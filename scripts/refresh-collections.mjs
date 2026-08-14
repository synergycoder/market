#!/usr/bin/env node
// Scans a gno.land network for GRC721/GRC1155 collections and writes
// data/collections-{chainId}.json — the static file collections.html fetches
// as its primary data source instead of every visitor's browser running this
// same scan live. Run on a schedule by .github/workflows/refresh-collections.yml
// (every 30 min); also runnable by hand: `node scripts/refresh-collections.mjs`.
//
// Deliberately standalone rather than importing web/shared.js: this runs in
// Node (CI), shared.js has browser-only top-level state (localStorage,
// location) wired into its module scope, and the handful of pure-logic
// pieces reused here (struct parsing, standard detection, candidate token
// IDs) are each only a few lines — not worth threading an import-safety
// refactor through a file that otherwise has zero reason to change.
//
// Network access here is heavier per collection than the browser's own
// live-scan button (see collections.html) — first-token image lookup and
// holder counting both enumerate tokens — which is exactly the point: this
// runs once per interval server-side instead of once per visitor.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const NETWORKS = {
  "sapphire-1": {
    rpcUrl: "https://rpc.sapphire.testnets.gno.land", label: "Testnet (sapphire-1)",
    indexerUrl: "https://indexer.sapphire.testnets.gno.land/graphql/query",
  },
  "gnoland1": {
    rpcUrl: "https://rpc.gno.land", label: "Betanet (gnoland1)",
    indexerUrl: "https://indexer.gno.land/graphql/query",
  },
};

// Kept in sync by hand with shared.js's SATELLITE_ADAPTERS (values only —
// this script only needs to exclude them from the scan, not resolve real
// paths to adapter paths, which is a frontend link-generation concern).
const SATELLITE_ADAPTER_PATHS = new Set([
  "gno.land/r/g1jkkpd3jyzzn8zz0jd8tmzewxxq9ysn67nhc35z/gemsg7adapter",
]);

const MAX_REALMS_TO_SCAN = 200;
const MAX_SEQUENTIAL_PROBE = 60;
const CONSECUTIVE_MISS_LIMIT = 5;
const CONCURRENCY_REALMS = 8;
const CONCURRENCY_COLLECTIONS = 4;
const CONCURRENCY_TOKENS = 4;

// ---------------- low-level chain access (same shape as shared.js's abciQuery) ----------------

async function abciQuery(rpcUrl, qpath, dataStr, timeoutMs = 15000) {
  const data = btoa(unescape(encodeURIComponent(dataStr)));
  const url = `${rpcUrl}/abci_query?path=${encodeURIComponent('"' + qpath + '"')}&data=${encodeURIComponent('"' + data + '"')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`RPC timed out after ${timeoutMs / 1000}s (${qpath})`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const base = json.result.response.ResponseBase;
  if (base.Error) throw new Error(base.Log || "query failed: " + qpath);
  return base.Data ? decodeURIComponent(escape(atob(base.Data))) : "";
}

async function qevalOn(rpcUrl, pkgPath, expr) {
  return abciQuery(rpcUrl, "vm/qeval", `${pkgPath}.${expr}`);
}

function parseGnoLine(line) {
  line = line.trim();
  const str = /^\("((?:\\.|[^"\\])*)"/.exec(line);
  if (str) return JSON.parse('"' + str[1] + '"');
  const num = /^\((-?\d+)/.exec(line);
  if (num) return Number(num[1]);
  return null;
}
function parseGnoLines(raw) {
  return raw.split("\n").map(parseGnoLine).filter((v) => v !== null);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------- collection detection (mirrors shared.js's heuristic) ----------------

const STANDARD_MARKERS = [
  { std: "GRC721", mentionRe: /grc721/i, funcRe: /func\s+(?:\([^)]*\)\s*)?(Mint|OwnerOf|TokenURI|SafeTransferFrom)\s*\(/ },
  { std: "GRC1155", mentionRe: /grc1155/i, funcRe: /func\s+(?:\([^)]*\)\s*)?(Mint|BalanceOf|URI|SafeTransferFrom|SafeBatchTransferFrom)\s*\(/ },
];
function detectStandard(fileBodies) {
  const combined = fileBodies.join("\n");
  for (const marker of STANDARD_MARKERS) {
    if (marker.mentionRe.test(combined) && marker.funcRe.test(combined)) return marker.std;
  }
  return null;
}

async function scanRealmPaths(rpcUrl) {
  const pathsRaw = await abciQuery(rpcUrl, "vm/qpaths", "gno.land/r/");
  let paths = pathsRaw.split("\n").map((s) => s.trim()).filter(Boolean);
  const totalRealms = paths.length;
  const truncated = totalRealms > MAX_REALMS_TO_SCAN;
  if (truncated) paths = paths.slice(0, MAX_REALMS_TO_SCAN);

  const found = [];
  await mapLimit(paths, CONCURRENCY_REALMS, async (p) => {
    try {
      const listing = await abciQuery(rpcUrl, "vm/qfile", p);
      const filenames = (listing || "").split("\n").map((s) => s.trim())
        .filter((name) => name.endsWith(".gno") && !name.endsWith("_test.gno"));
      const bodies = await mapLimit(filenames, 4, (name) => abciQuery(rpcUrl, "vm/qfile", `${p}/${name}`).catch(() => ""));
      const standard = detectStandard(bodies);
      // See SATELLITE_ADAPTER_PATHS's own comment — an adapter forwards to
      // a real collection and would otherwise show up as a duplicate.
      if (standard && !SATELLITE_ADAPTER_PATHS.has(p)) found.push({ path: p, standard });
    } catch {
      // unreadable package — skip
    }
  });
  return { found, scannedCount: paths.length, totalRealms, truncated };
}

async function fetchCollectionSummary(rpcUrl, p) {
  const summary = { name: null, symbol: null, tokenCount: null };
  await Promise.all([
    qevalOn(rpcUrl, p, "Name()").then((r) => { summary.name = parseGnoLines(r)[0] ?? null; }).catch(() => {}),
    qevalOn(rpcUrl, p, "Symbol()").then((r) => { summary.symbol = parseGnoLines(r)[0] ?? null; }).catch(() => {}),
    qevalOn(rpcUrl, p, "TokenCount()").then((r) => { summary.tokenCount = parseGnoLines(r)[0] ?? null; }).catch(() => {}),
  ]);
  return summary;
}

// ---------------- creation date (via tx-indexer, not vm/* RPC) ----------------
// gno.land's vm/* query surface (qpaths/qfile/qeval) has no notion of "when
// was this deployed" at all — confirmed by trying it directly, nothing there
// returns a height or timestamp for a package. The GraphQL tx-indexer does:
// every deploy is a MsgAddPackage transaction, findable by its own package
// path, which carries a block_height; a second query resolves that height to
// a wall-clock time. Both queries verified live against sapphire-1's real
// indexer before wiring this in. Server-side only (Node/CI) — betanet's
// indexer has no CORS headers, so this can't run from a browser, and that's
// the real reason the live client-side scan (shared.js) doesn't attempt it
// at all rather than half-supporting it.
//
// Genesis-deployed packages (loaded at chain start, not via a real tx) have
// no MsgAddPackage to find — fetchCreationHeight returns null for those, and
// the collection just sorts to the end / shows no date, rather than guessing.
async function graphqlQuery(indexerUrl, query, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(indexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCreationHeight(indexerUrl, p) {
  if (!indexerUrl) return null;
  try {
    const query = `query { getTransactions(where: { success: { eq: true }, messages: { route: { eq: "vm" }, typeUrl: { eq: "add_package" }, value: { MsgAddPackage: { package: { path: { eq: ${JSON.stringify(p)} } } } } } }) { block_height } }`;
    const data = await graphqlQuery(indexerUrl, query);
    return data?.getTransactions?.[0]?.block_height ?? null;
  } catch {
    return null;
  }
}

async function fetchBlockTime(indexerUrl, height) {
  if (!indexerUrl || height == null) return null;
  try {
    const query = `query { getBlocks(where: { height: { eq: ${height} } }) { time } }`;
    const data = await graphqlQuery(indexerUrl, query);
    return data?.getBlocks?.[0]?.time ?? null;
  } catch {
    return null;
  }
}

// ---------------- token enumeration: holder count + first-minted thumbnail ----------------
// Same best-effort candidate-ID probing as shared.js's fetchCollectionTokens
// (no standard "list every token ID" function exists) — see
// ~/gno-land-dev-notes.md. Combined into one pass since both holder count
// and "first token" fall naturally out of the same OwnerOf enumeration.

const CFORD32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function cford32Compact(id) {
  let out = "";
  for (const shift of [30, 25, 20, 15, 10, 5, 0]) out += CFORD32_ALPHABET[(id >>> shift) & 0x1f];
  return out;
}
function candidateTokenIds(i) {
  return [String(i + 1), String(i), cford32Compact(i)];
}

// tokenCount is NEVER trusted as a hard upper bound on the index to probe
// to — same fix and same real-world cause as shared.js's
// fetchCollectionTokens (see its doc comment): TokenCount() is current
// supply, not highest-index-ever-minted, and a single burn can leave a
// real, currently-held token past that count entirely.
async function scanHoldersAndFirstToken(rpcUrl, p, tokenCount) {
  const limit = MAX_SEQUENTIAL_PROBE;
  const indices = Array.from({ length: limit }, (_, i) => i);
  const owners = new Set();
  let firstTokenId = null;
  let consecutiveMisses = 0;

  // Sequential (not mapLimit) so "stop after N consecutive misses" and
  // "remember the first resolved index" both stay meaningful — a
  // concurrent scan would race both.
  for (const i of indices) {
    let resolved = null;
    for (const tid of candidateTokenIds(i)) {
      try {
        const [owner] = parseGnoLines(await qevalOn(rpcUrl, p, `OwnerOf(${JSON.stringify(tid)})`));
        if (owner) { resolved = { tokenId: tid, owner }; break; }
      } catch { /* try next candidate shape */ }
    }
    if (!resolved) {
      consecutiveMisses++;
      if (consecutiveMisses >= CONSECUTIVE_MISS_LIMIT) break;
      continue;
    }
    consecutiveMisses = 0;
    owners.add(resolved.owner);
    if (firstTokenId === null) firstTokenId = resolved.tokenId;
  }
  return { holderCount: owners.size, firstTokenId };
}

// Image lookup deliberately narrower than shared.js's fetchTokenDisplayInfo:
// only the inline data: URI case (no external-URL fetch from CI — a slow or
// dead third-party host would stall the whole cron run) and only the
// Image/ImageData on-chain fields (no Attributes — that needs the inline
// function-literal qeval trick, not worth it just for a thumbnail).
function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of str) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ""; } else { cur += ch; }
  }
  if (cur) parts.push(cur);
  return parts;
}
function parseGnoStructFieldValue(chunk) {
  chunk = chunk.trim();
  if (!chunk.startsWith("(") || !chunk.endsWith(")")) return null;
  const body = chunk.slice(1, -1);
  let inQuote = false, lastSpace = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' && body[i - 1] !== "\\") inQuote = !inQuote;
    else if (c === " " && !inQuote) lastSpace = i;
  }
  if (lastSpace === -1) return null;
  const value = body.slice(0, lastSpace).trim();
  if (value === "") return "";
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  return null;
}
const IMAGE_FIELDS = ["image", "imageData"]; // positions 0,1 of GRC721_METADATA_FIELDS — see shared.js
function parseImageFromStruct(raw) {
  const m = /^\(struct\{(.*)\}\s+\S+\)$/.exec(raw.trim());
  if (!m) return null;
  const chunks = splitTopLevel(m[1], ",");
  const result = {};
  chunks.forEach((chunk, i) => { if (IMAGE_FIELDS[i]) result[IMAGE_FIELDS[i]] = parseGnoStructFieldValue(chunk); });
  return result;
}
function svgTextToDataUrl(svgText) {
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgText)));
}

// Tries TokenURI(tid) then falls back to GetTokenURI(tid), and only trusts
// a result that actually looks like a URI. Confirmed against a real
// deployed collection (betanet's gingernft2): it declares `type TokenURI
// string` at package scope with no `TokenURI` *function* at all (the real
// accessor is `GetTokenURI`) — qeval against the bare name doesn't error,
// it silently resolves as a type conversion and echoes the token ID back
// as a fake "URI", which is why this needs a validity check, not just a
// try/catch. Same fix as shared.js's fetchTokenURI (kept separate here on
// purpose — see this file's own top-of-file note on not importing
// shared.js into a Node/CI context).
async function fetchTokenURI(rpcUrl, p, tid) {
  for (const fn of ["TokenURI", "GetTokenURI"]) {
    try {
      const [uri] = parseGnoLines(await qevalOn(rpcUrl, p, `${fn}(${JSON.stringify(tid)})`));
      if (typeof uri === "string" && (uri.startsWith("data:") || /^https?:\/\//.test(uri))) return uri;
    } catch { /* try the next accessor name */ }
  }
  return "";
}

async function fetchFirstTokenImage(rpcUrl, p, tid) {
  if (!tid) return null;
  try {
    const tokenURI = await fetchTokenURI(rpcUrl, p, tid);
    if (tokenURI && tokenURI.startsWith("data:application/json")) {
      const comma = tokenURI.indexOf(",");
      const header = tokenURI.slice(0, comma);
      const payload = tokenURI.slice(comma + 1);
      const json = header.includes(";base64") ? decodeURIComponent(escape(atob(payload))) : decodeURIComponent(payload);
      const meta = JSON.parse(json);
      if (meta.image) return meta.image;
    }
  } catch { /* fall through to on-chain metadata */ }
  try {
    const raw = await qevalOn(rpcUrl, p, `TokenMetadata(${JSON.stringify(tid)})`);
    const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length < 2 || lines[1] !== "(undefined)") return null;
    const meta = parseImageFromStruct(lines[0]);
    if (meta?.image) return meta.image;
    if (meta?.imageData) return svgTextToDataUrl(meta.imageData);
  } catch { /* no on-chain metadata either — no thumbnail for this collection */ }
  return null;
}

// ---------------- per-network run ----------------

async function refreshNetwork(chainId, { rpcUrl, label, indexerUrl }) {
  console.log(`[${chainId}] scanning realms...`);
  const { found, scannedCount, totalRealms, truncated } = await scanRealmPaths(rpcUrl);
  console.log(`[${chainId}] ${found.length} collection(s) found across ${scannedCount}/${totalRealms} realms scanned${truncated ? " (truncated)" : ""}`);

  const collections = await mapLimit(found, CONCURRENCY_COLLECTIONS, async (c) => {
    const summary = await fetchCollectionSummary(rpcUrl, c.path).catch(() => ({ name: null, symbol: null, tokenCount: null }));
    let holderCount = null, image = null;
    if (c.standard === "GRC721") {
      // Holder counting/thumbnail only make sense for GRC721's per-token
      // OwnerOf model — GRC1155 is multi-token-per-holder (BalanceOf), a
      // different enumeration shape not built here yet.
      try {
        const { holderCount: hc, firstTokenId } = await scanHoldersAndFirstToken(rpcUrl, c.path, summary.tokenCount);
        holderCount = hc;
        image = await fetchFirstTokenImage(rpcUrl, c.path, firstTokenId);
      } catch (err) {
        console.warn(`[${chainId}] token scan failed for ${c.path}: ${err.message}`);
      }
    }
    const blockHeight = await fetchCreationHeight(indexerUrl, c.path);
    const createdAt = await fetchBlockTime(indexerUrl, blockHeight);
    console.log(`[${chainId}]   ${c.path} — ${summary.name || "(unnamed)"} · ${summary.tokenCount ?? "?"} tokens · ${holderCount ?? "?"} holders · ${createdAt || "no creation date"}`);
    return { ...c, ...summary, holderCount, image, blockHeight, createdAt };
  });

  // Drop GRC721s with no confirmed token count — either a real 0 (never
  // minted anything) or unreadable entirely (no TokenCount() at all). Both
  // describe something that isn't a genuine browsable collection: gnoswap's
  // position/v1 and staker never mint, and gnoswap/gnft, despite having real
  // holders, doesn't expose a count either — if we can't even say how many
  // tokens exist, it doesn't belong in a collections list. Leaves GRC1155
  // alone (TokenCount isn't part of that standard here).
  const isJunk = (c) => c.standard === "GRC721" && (c.tokenCount == null || c.tokenCount === 0);
  const dropped = collections.filter(isJunk);
  const kept = collections.filter((c) => !isJunk(c));
  if (dropped.length) console.log(`[${chainId}] dropping ${dropped.length} collection(s) with no confirmed tokens: ${dropped.map((c) => c.path).join(", ")}`);

  // Newest first. A collection with no creation date at all (genesis-
  // deployed, no MsgAddPackage tx for the indexer to find — see
  // fetchCreationHeight's doc comment) sorts to the end rather than being
  // guessed at; ties within "no date" fall back to block height, which is
  // at least monotonic even without a wall-clock time attached.
  kept.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return (b.blockHeight ?? -1) - (a.blockHeight ?? -1);
  });

  const out = {
    chainId,
    label,
    generatedAt: new Date().toISOString(),
    scannedCount,
    totalRealms,
    truncated,
    collections: kept,
  };
  await mkdir(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, `collections-${chainId}.json`);
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`[${chainId}] wrote ${outPath}`);
}

const only = process.argv[2]; // optional: run just one network, e.g. `node refresh-collections.mjs sapphire-1`
const targets = only ? { [only]: NETWORKS[only] } : NETWORKS;
if (only && !NETWORKS[only]) {
  console.error(`Unknown network "${only}". Known: ${Object.keys(NETWORKS).join(", ")}`);
  process.exit(1);
}

for (const [chainId, cfg] of Object.entries(targets)) {
  await refreshNetwork(chainId, cfg);
}
