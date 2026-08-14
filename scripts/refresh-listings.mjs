#!/usr/bin/env node
// Scans a gno.land network's gnomarket deployment for active listings and
// writes data/listings-{chainId}.json — a "stale" flag pre-computed per
// listing so index.html can filter out anything that no longer belongs to
// its seller (sold/transferred elsewhere, or approval revoked) without
// every visitor's browser paying for the extra approval-check RPC call
// that requires. Run on a schedule by
// .github/workflows/refresh-collections.yml (every 30 min); also runnable
// by hand: `node scripts/refresh-listings.mjs`.
//
// index.html still fetches the listing set itself LIVE on every visit (a
// stale-for-30-minutes view of "what's for sale" would be a real UX
// downgrade, unlike collections.html's "what collections exist" which
// barely changes) — this cache is only cross-referenced for the `stale`
// flag, and a listing this cache hasn't seen yet is treated as fresh, not
// hidden. See index.html's loadListings()/isKnownStale().
//
// Deliberately standalone rather than importing web/shared.js — same
// reasoning as refresh-collections.mjs's own top-of-file note.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

// Only networks where gnomarket is actually deployed have listings to check
// — kept in sync by hand with shared.js's NETWORKS (marketplaceDeployed).
const NETWORKS = {
  "sapphire-1": {
    rpcUrl: "https://rpc.sapphire.testnets.gno.land", label: "Testnet (sapphire-1)",
    marketPkgPath: "gno.land/r/g1jkkpd3jyzzn8zz0jd8tmzewxxq9ysn67nhc35z/nftmarket",
  },
};

const CONCURRENCY_LISTINGS = 6;

// ---------------- low-level chain access (same shape as refresh-collections.mjs) ----------------

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
  if (/^\(true /.test(line)) return true;
  if (/^\(false /.test(line)) return false;
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

// ---------------- per-network run ----------------

// Same check nftmarket.gno's own List()/Buy() perform internally
// (isApproved: GetApproved == marketAddr || IsApprovedForAll(seller,
// marketAddr)) — the frontend only ever sets SetApprovalForAll, never a
// per-token Approve, so IsApprovedForAll alone is the meaningful check
// here. Calling it on collectionID (not the real collection) is what makes
// this correct for a satellite-adapter listing too: the adapter's own
// IsApprovedForAll ignores the operator argument it's passed and checks
// whether *it* is approved on the real collection — see
// gno.land/r/gnomarket/satellites/README.md.
async function isStillApproved(rpcUrl, collectionID, seller, marketAddr) {
  try {
    const [approved] = parseGnoLines(await qevalOn(rpcUrl, collectionID, `IsApprovedForAll(${JSON.stringify(seller)}, ${JSON.stringify(marketAddr)})`));
    return approved === true;
  } catch {
    return false; // unreadable — treat as not-approved rather than trusting a broken read
  }
}

async function refreshNetwork(chainId, { rpcUrl, label, marketPkgPath }) {
  console.log(`[${chainId}] fetching listings...`);
  let marketAddr = null;
  try {
    [marketAddr] = parseGnoLines(await qevalOn(rpcUrl, marketPkgPath, "MarketAddress()"));
  } catch (err) {
    console.error(`[${chainId}] couldn't read MarketAddress(): ${err.message} — skipping`);
    return;
  }

  const raw = parseGnoLines(await qevalOn(rpcUrl, marketPkgPath, "GetListingsPage(0, 100)"))[0] || "";
  const rawListings = raw.split("\n").filter(Boolean).map((line) => {
    const [collectionID, tokenId, seller, price] = line.split("|");
    return { collectionID, tokenId, seller, price: Number(price) };
  });
  console.log(`[${chainId}] ${rawListings.length} active listing(s)`);

  const listings = await mapLimit(rawListings, CONCURRENCY_LISTINGS, async (l) => {
    let owner = null;
    try { [owner] = parseGnoLines(await qevalOn(rpcUrl, l.collectionID, `OwnerOf(${JSON.stringify(l.tokenId)})`)); } catch { /* leave null — treated as stale below */ }
    const ownerMismatch = owner !== l.seller;
    const approved = ownerMismatch ? false : await isStillApproved(rpcUrl, l.collectionID, l.seller, marketAddr);
    const stale = ownerMismatch || !approved;
    if (stale) console.log(`[${chainId}]   STALE ${l.collectionID}#${l.tokenId} — ${ownerMismatch ? `owner is now ${owner || "unreadable"}, not seller ${l.seller}` : "marketplace approval revoked"}`);
    return { ...l, owner, stale };
  });

  const out = {
    chainId,
    label,
    generatedAt: new Date().toISOString(),
    marketAddr,
    listings,
  };
  await mkdir(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, `listings-${chainId}.json`);
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`[${chainId}] wrote ${outPath} (${listings.filter((l) => l.stale).length} stale)`);
}

const only = process.argv[2]; // optional: run just one network, e.g. `node refresh-listings.mjs sapphire-1`
const targets = only ? { [only]: NETWORKS[only] } : NETWORKS;
if (only && !NETWORKS[only]) {
  console.error(`Unknown network "${only}". Known: ${Object.keys(NETWORKS).join(", ")}`);
  process.exit(1);
}

for (const [chainId, cfg] of Object.entries(targets)) {
  await refreshNetwork(chainId, cfg);
}
