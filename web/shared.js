// Shared chain-access, network-config, and rendering helpers for all
// gnomarket pages (index.html, collections.html, nfts.html). Kept as one
// plain <script> file (no bundler, no build step) rather than tripling this
// ~250 lines across three pages.

// ---------------- networks ----------------

const NETWORKS = {
  local: {
    // Points at the shared local gnodev instance also used by the
    // gno-nft-minter session (default ports) rather than a separate one of
    // our own — gnomarket + testcollection are deployed there too now, so
    // Collections/NFTs see real minted collections from that other project
    // alongside ours, and Buy/Sell here works against them.
    label: "Local (gnodev)",
    rpcUrl: "http://127.0.0.1:26657",
    chainId: "dev",
    gnowebUrl: "http://localhost:8888",
    marketplaceDeployed: true,
  },
  testnet: {
    label: "Testnet (topaz-1)",
    rpcUrl: "https://rpc.topaz.testnets.gno.land",
    chainId: "topaz-1",
    gnowebUrl: "https://topaz.testnets.gno.land",
    marketplaceDeployed: false,
  },
  betanet: {
    label: "Betanet (gnoland1)",
    rpcUrl: "https://rpc.gno.land",
    chainId: "gnoland1",
    gnowebUrl: "https://gno.land",
    marketplaceDeployed: false,
  },
};

const CONFIG = {
  marketPkgPath: "gno.land/r/gnomarket/nftmarket",
  adenaAppName: "gnomarket",
};

const NETWORK_STORAGE_KEY = "gnomarket:selectedNetwork";

function loadSavedNetworkKey() {
  try {
    const saved = localStorage.getItem(NETWORK_STORAGE_KEY);
    if (saved && NETWORKS[saved]) return saved;
  } catch { /* storage unavailable — default to local */ }
  return "local";
}

let currentNetKey = loadSavedNetworkKey();
function net() { return NETWORKS[currentNetKey]; }

// Populates the given <select> with every network, restores the saved
// selection, and wires it to call onChange(netKey) — the caller owns
// whatever page-specific reload logic follows a network switch.
function initNetworkSelect(selectEl, onChange) {
  for (const [key, n] of Object.entries(NETWORKS)) {
    selectEl.appendChild(new Option(n.label, key));
  }
  selectEl.value = currentNetKey;
  selectEl.addEventListener("change", () => {
    currentNetKey = selectEl.value;
    try { localStorage.setItem(NETWORK_STORAGE_KEY, currentNetKey); } catch { /* ignore */ }
    onChange(currentNetKey);
  });
}

// Re-points the GnoConnect meta tags (docs.gno.land/resources/gnoconnect) so
// a connected wallet signs against whichever network is currently selected.
// No-op if the page doesn't declare them.
function updateGnoConnectMeta() {
  const n = net();
  const rpcMeta = document.querySelector('meta[name="gnoconnect:rpc"]');
  const chainMeta = document.querySelector('meta[name="gnoconnect:chainid"]');
  if (rpcMeta) rpcMeta.content = n.rpcUrl.replace(/^https?:\/\//, "");
  if (chainMeta) chainMeta.content = n.chainId;
}

// ---------------- low-level chain access (same abci_query pattern as gno-observer) ----------------

async function abciQuery(rpcUrl, path, dataStr, timeoutMs = 15000) {
  const data = btoa(unescape(encodeURIComponent(dataStr)));
  const url = `${rpcUrl}/abci_query?path=${encodeURIComponent('"' + path + '"')}&data=${encodeURIComponent('"' + data + '"')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`RPC timed out after ${timeoutMs / 1000}s (${path})`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const base = json.result.response.ResponseBase;
  if (base.Error) throw new Error(base.Log || "query failed: " + path);
  return base.Data ? decodeURIComponent(escape(atob(base.Data))) : "";
}

// Evaluates `expr` against pkgPath on the current network (e.g.
// qevalOn("gno.land/r/gnomarket/nftmarket", "MarketAddress()")). Works
// against ANY package, not just this marketplace — used by the
// Collections/NFTs pages to read arbitrary detected collections directly.
async function qevalOn(pkgPath, expr) {
  return abciQuery(net().rpcUrl, "vm/qeval", `${pkgPath}.${expr}`);
}

// vm/qeval renders each return value as its own line: `("foo" string)`,
// `(42 int64)`, `("g1..." .uverse.address)`. Quoted values use Go's %q
// escaping, which is a compatible subset of JSON string escaping for the
// plain-ASCII content these realms ever produce.
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

// ---------------- generic helpers ----------------

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

function truncAddr(a) {
  return a && a.length > 14 ? a.slice(0, 8) + "…" + a.slice(-6) : a;
}
function ugnotToGnot(amount) {
  return (amount / 1_000_000).toString();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Two supported tokenURI shapes: an inline `data:application/json[;base64],<data>`
// blob (what this repo's demo collection returns — no fetch needed), or a
// real URL a real collection might return (fetched, OpenSea metadata shape).
function metadataFromTokenURI(tokenURI) {
  if (!tokenURI) return null;
  if (tokenURI.startsWith("data:application/json")) {
    const comma = tokenURI.indexOf(",");
    if (comma === -1) return null;
    const header = tokenURI.slice(0, comma);
    const payload = tokenURI.slice(comma + 1);
    try {
      const json = header.includes(";base64") ? decodeURIComponent(escape(atob(payload))) : decodeURIComponent(payload);
      return JSON.parse(json);
    } catch { return null; }
  }
  return { __fetch: tokenURI };
}

// Resolves a tokenURI down to a displayable image URL, fetching a real URL
// if that's what the collection returned. Returns null on any failure —
// callers should fall back to a placeholder, never throw.
async function resolveImageUrl(tokenURI) {
  const meta = metadataFromTokenURI(tokenURI);
  if (meta?.image) return meta.image;
  if (meta?.__fetch) {
    try {
      const res = await fetch(meta.__fetch);
      const json = await res.json();
      return json.image || null;
    } catch { return null; }
  }
  return null;
}

// ---------------- chain-wide NFT collection detection ----------------
// Independent of gnomarket's own registry — reuses gno-observer's verified
// detection heuristic (see ~/gno-land-dev-notes.md): a realm counts as an
// NFT collection only if the standard's name is mentioned in its source AND
// it defines a matching characteristic function itself (free function or
// method) — this excludes realms (like the marketplace itself) that merely
// reference someone else's collection without minting anything.
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

const MAX_REALMS_TO_SCAN = 200; // client-side cap, see scanChainForCollections

// Scans every gno.land/r/ realm on the current network for the GRC721/
// GRC1155 signature above. `onProgress(scanned, total)` is called after
// each realm resolves — callers use this to render a live counter and to
// detect a stale/abandoned scan (e.g. after a network switch) via their own
// generation token, since this function has no way to know it's been
// superseded on its own.
async function scanChainForCollections(onProgress) {
  const rpcUrl = net().rpcUrl;
  const pathsRaw = await abciQuery(rpcUrl, "vm/qpaths", "gno.land/r/");
  let paths = pathsRaw.split("\n").map((s) => s.trim()).filter(Boolean);
  const totalRealms = paths.length;
  const truncated = totalRealms > MAX_REALMS_TO_SCAN;
  if (truncated) paths = paths.slice(0, MAX_REALMS_TO_SCAN);

  let scanned = 0;
  const found = [];
  await mapLimit(paths, 8, async (path) => {
    try {
      const listing = await abciQuery(rpcUrl, "vm/qfile", path);
      const filenames = (listing || "").split("\n").map((s) => s.trim())
        .filter((name) => name.endsWith(".gno") && !name.endsWith("_test.gno"));
      const bodies = await mapLimit(filenames, 4, (name) => abciQuery(rpcUrl, "vm/qfile", `${path}/${name}`).catch(() => ""));
      const standard = detectStandard(bodies);
      if (standard) found.push({ path, standard });
    } catch {
      // unreadable package — skip, don't retry
    } finally {
      scanned++;
      onProgress?.(scanned, paths.length);
    }
  });

  return { found, scannedCount: paths.length, totalRealms, truncated };
}

// Reads Name/Symbol/TokenCount from a detected collection's own path, as
// plain package-level functions (not methods on some unknown exported
// var) — collections that don't expose these this way (e.g. a vendored
// grc721 package's BasicNFT held in an unexported var, read only through
// hand-written wrappers with different names) just show blanks; this is a
// best-effort demo-grade scan, not a universal reader.
async function fetchCollectionSummary(path) {
  const summary = { name: null, symbol: null, tokenCount: null };
  await Promise.all([
    qevalOn(path, "Name()").then((r) => { summary.name = parseGnoLines(r)[0] ?? null; }).catch(() => {}),
    qevalOn(path, "Symbol()").then((r) => { summary.symbol = parseGnoLines(r)[0] ?? null; }).catch(() => {}),
    qevalOn(path, "TokenCount()").then((r) => { summary.tokenCount = parseGnoLines(r)[0] ?? null; }).catch(() => {}),
  ]);
  return summary;
}

// ---------------- chain-wide NFT token enumeration ----------------
// There is no standard enumeration function for "give me every token ID in
// this collection" (see ~/gno-land-dev-notes.md) — BalanceOf tells you how
// many an address holds, not which ones. This is a best-effort fallback:
// probe a small set of common ID conventions at each sequential index and
// take whichever one resolves, calling OwnerOf/TokenURI as plain package-
// level functions on the collection's own path. Stops at tokenCount if
// known, otherwise at MAX_SEQUENTIAL_PROBE, and gives up early after
// several consecutive misses (probably past the end of a shorter,
// unknown-length collection).
const MAX_SEQUENTIAL_PROBE = 60;
const CONSECUTIVE_MISS_LIMIT = 5;

// gno.land/p/nt/seqid's ID.String() (cford32's "compact" encoding: 7 chars,
// lowercase Crockford base32, 5 bits per char, id=0 first) — confirmed
// against gno-nft-minter's real deployed collection, whose token IDs render
// as "0000000", "0000001", ... (digits are shared between upper/lower in
// this alphabet, which is why they look like plain zero-padded numbers).
// seqid is a standard `p/nt` package, so this candidate is worth trying
// for any collection, not just the one that prompted it.
const CFORD32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function cford32Compact(id) {
  let out = "";
  for (const shift of [30, 25, 20, 15, 10, 5, 0]) {
    out += CFORD32_ALPHABET[(id >>> shift) & 0x1f];
  }
  return out;
}

// Candidate token ID strings to try at sequential index i, covering the ID
// conventions we know about: this repo's own 1-based plain decimal, plain
// 0-based decimal, and seqid's 0-based cford32 compact encoding.
function candidateTokenIds(i) {
  return [String(i + 1), String(i), cford32Compact(i)];
}

async function fetchCollectionTokens(path, tokenCount, onProgress) {
  const limit = tokenCount && tokenCount > 0 ? Math.min(tokenCount, MAX_SEQUENTIAL_PROBE) : MAX_SEQUENTIAL_PROBE;
  const tokens = [];
  let consecutiveMisses = 0;
  for (let i = 0; i < limit; i++) {
    onProgress?.(i + 1, limit);
    let resolved = null;
    for (const tid of candidateTokenIds(i)) {
      try {
        const [owner] = parseGnoLines(await qevalOn(path, `OwnerOf(${JSON.stringify(tid)})`));
        if (owner) { resolved = { tokenId: tid, owner }; break; }
      } catch { /* try the next candidate ID shape */ }
    }
    if (!resolved) {
      consecutiveMisses++;
      if (!tokenCount && consecutiveMisses >= CONSECUTIVE_MISS_LIMIT) break;
      continue;
    }
    consecutiveMisses = 0;
    let tokenURI = "";
    try {
      [tokenURI] = parseGnoLines(await qevalOn(path, `TokenURI(${JSON.stringify(resolved.tokenId)})`));
    } catch { /* URI optional */ }
    tokens.push({ tokenId: resolved.tokenId, owner: resolved.owner, tokenURI: tokenURI || "" });
  }
  return tokens;
}
