// Shared chain-access, network-config, and rendering helpers for all
// gnomarket pages (index.html, collections.html, nfts.html). Kept as one
// plain <script> file (no bundler, no build step) rather than tripling this
// ~250 lines across three pages.

// ---------------- networks ----------------

// marketPkgPath is per-network, not a single global constant: on real
// gno.land chains, deploying under a custom string namespace like
// "gnomarket" requires that name to be registered via a GovDAO-whitelisted
// controller (gno.land/r/sys/names + r/sys/users) — not something to rush
// through for a testnet trial deploy. The sapphire-1 deploy instead lives
// under the deploying key's own address namespace (gno.land/r/{addr}/*),
// which gno.land always permits with no registration at all. Local gnodev
// has no such restriction, so it keeps the clean "gnomarket" path.
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
    marketPkgPath: "gno.land/r/gnomarket/nftmarket",
    marketplaceDeployed: true,
  },
  testnet: {
    // topaz-1 was sunset 2026-08-11; sapphire-1 is its replacement (verified
    // against gno-nft-minter's own working config and ~/gno-land-dev-notes.md,
    // both already using it successfully) — see the shared dev-notes file.
    label: "Testnet (sapphire-1)",
    rpcUrl: "https://rpc.sapphire.testnets.gno.land",
    chainId: "sapphire-1",
    gnowebUrl: "https://sapphire.testnets.gno.land",
    marketPkgPath: "gno.land/r/g1jkkpd3jyzzn8zz0jd8tmzewxxq9ysn67nhc35z/nftmarket",
    marketplaceDeployed: true,
  },
  betanet: {
    label: "Betanet (gnoland1)",
    rpcUrl: "https://rpc.gno.land",
    chainId: "gnoland1",
    gnowebUrl: "https://gno.land",
    marketPkgPath: "gno.land/r/gnomarket/nftmarket",
    marketplaceDeployed: false,
  },
};

const CONFIG = {
  adenaAppName: "gnomarket",
  // While gnomarket is in private testing, the full app is only shown to
  // this address — everyone else (and anyone not connected) sees the
  // splash view instead. See wallet.js's initGate(). Not a security
  // boundary (the chain itself is public to anyone who queries it
  // directly) — purely a UI convenience so casual visitors to gno.market
  // see "coming soon" instead of a half-finished trading UI.
  ownerAddress: "g18pph34e6e70whfqzk6m4kv6cdtl47nm4vlfl4x",
};

// Real collection path -> the satellite adapter that fronts it for the
// marketplace (see gno.land/r/gnomarket/satellites/README.md). Browsing a
// collection naturally (Collections -> NFTs -> a token) discovers tokens
// under their REAL path, but the marketplace only knows the adapter's
// registered collectionID — a "List for sale"/"Buy" reachable through that
// natural flow needs its links built with the adapter's path instead, or
// the listing would silently look invisible (searched for under a
// collectionID nothing was ever registered against). Keyed by real path,
// one entry per satellite adapter that exists.
const SATELLITE_ADAPTERS = {
  "gno.land/r/g17cjym5e9hhws46lt6329pv2gtx2ay0503hgems/g7":
    "gno.land/r/g1jkkpd3jyzzn8zz0jd8tmzewxxq9ysn67nhc35z/gemsg7adapter",
};

// The collectionID a "View NFTs"/item link should actually use — the
// adapter's path when the real path has one fronting it, otherwise the
// real path itself (a natively-registered or unregistered collection).
function marketplaceCollectionId(realPath) {
  return SATELLITE_ADAPTERS[realPath] || realPath;
}

const NETWORK_STORAGE_KEY = "gnomarket:selectedNetwork";

// Local's RPC (http://127.0.0.1:26657) only exists on the machine actually
// running gnodev — defaulting every visitor to it (including the owner
// loading the real deployed site) produces a silent "Failed to fetch" the
// moment any read fires, with no obvious cause. Default to local only when
// the page itself is being served from localhost (a dev session); any real
// domain (gno.market, a preview URL, etc.) defaults to testnet instead.
function defaultNetworkKey() {
  return (location.hostname === "localhost" || location.hostname === "127.0.0.1") ? "local" : "testnet";
}

function loadSavedNetworkKey() {
  try {
    const saved = localStorage.getItem(NETWORK_STORAGE_KEY);
    if (saved && NETWORKS[saved]) return saved;
  } catch { /* storage unavailable — fall through to hostname-based default */ }
  return defaultNetworkKey();
}

let currentNetKey = loadSavedNetworkKey();
function net() { return NETWORKS[currentNetKey]; }

// Populates the given <select> with every network, restores the saved
// selection, and wires it to call onChange(netKey) — the caller owns
// whatever page-specific reload logic follows a network switch.
function initNetworkSelect(selectEl, onChange) {
  // "Local (gnodev)" only ever resolves on the machine actually running
  // gnodev — real visitors have no use for it and it's just clutter/a
  // confusing option in the dropdown on the deployed site. Hidden the same
  // way it's chosen by default in the first place (see defaultNetworkKey):
  // gated on being served from localhost, so this stays fully visible for
  // local development and disappears everywhere else, without needing a
  // second "is this the dev build" flag to keep in sync.
  const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  for (const [key, n] of Object.entries(NETWORKS)) {
    if (key === "local" && !isLocalhost) continue;
    selectEl.appendChild(new Option(n.label, key));
  }
  selectEl.value = currentNetKey;
  selectEl.addEventListener("change", () => {
    currentNetKey = selectEl.value;
    try { localStorage.setItem(NETWORK_STORAGE_KEY, currentNetKey); } catch { /* ignore */ }
    onChange(currentNetKey);
  });
}

// Injects the standing disclaimer footer into `container` — call once per
// page. Kept as one shared function (not duplicated HTML per page) so the
// wording never drifts between pages.
function initFooter(container) {
  container.innerHTML = `
    <p>gnomarket is an independent, community-built project. It is not affiliated with, endorsed by, or
    part of the official gno.land project.</p>
    <p>This site is in beta and provided "as is," without warranties of any kind. Use at your own risk —
    testnet tokens have no real-world value, and mainnet trading (once available) carries the same risks
    as any other smart contract interaction.</p>`;
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
function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function attributesHtml(attributes) {
  if (!attributes || attributes.length === 0) return "";
  const pills = attributes.map((a) => `<span class="trait">${escapeHtml(a.traitType)}: <b>${escapeHtml(a.value)}</b></span>`).join("");
  return `<div class="traits">${pills}</div>`;
}

// Calls TokenURI(tid) on a collection's own path, with a fallback to
// GetTokenURI(tid) — and a validity check, not just a try/catch, because the
// failure mode here is silent rather than an error. Confirmed against a real
// deployed collection (gno.land/r/.../gingernft2 on betanet): it declares
// `type TokenURI string` at package scope and never defines a `TokenURI`
// *function* at all (its real accessor is `GetTokenURI`) — qeval still
// "succeeds" against the bare name because Gno resolves it as a type
// conversion instead (`TokenURI("1")` evaluates to the string "1" recast as
// that type), so a plain try/catch never sees an error, it just gets back
// the token ID itself misread as a URI. Only trust a result that actually
// looks like a URI; otherwise fall through to GetTokenURI, the accessor
// name gno-observer's own cache builder already uses for this same case.
async function fetchTokenURI(path, tid) {
  for (const fn of ["TokenURI", "GetTokenURI"]) {
    try {
      const [uri] = parseGnoLines(await qevalOn(path, `${fn}(${JSON.stringify(tid)})`));
      if (typeof uri === "string" && (uri.startsWith("data:") || /^https?:\/\//.test(uri))) return uri;
    } catch { /* try the next accessor name */ }
  }
  return "";
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

// ---------------- on-chain metadata (IGRC721MetadataOnchain) ----------------
// gno.land's canonical GRC721 reference package (gno.land/p/demo/tokens/grc721)
// sanctions TWO separate, coexisting metadata interfaces — TokenURI (Ethereum-
// style, a URI a client fetches/decodes) and TokenMetadata (OpenSea-schema
// struct, fully on-chain, no fetch needed). A collection may implement
// either. Real deployed collections use both in the wild (confirmed against
// gno-nft-minter's own collection, which only implements TokenMetadata) —
// treating TokenURI as the only source under-reads plenty of real,
// standards-compliant collections. This section adds TokenMetadata support.
//
// Reading it back is harder than TokenURI because vm/qeval's text rendering
// doesn't expand nested reference-holding values: Metadata.Attributes
// ([]Trait) comes back as an opaque `slice[ref(<hash>:<idx>)] []...Trait`
// placeholder, not the actual trait data (confirmed against the real
// deployed collection: gno.land/r/.../nftminter.TokenMetadata("0000000")).
// There is no way to dereference that from a plain qeval text query — it
// would need actual struct-aware decoding, not string scraping. Every OTHER
// field (Image, ImageData, Description, Name, BackgroundColor, ExternalURL,
// AnimationURL, YoutubeURL) is a plain string and reads back fine.
const GRC721_METADATA_FIELDS = [
  "image", "imageData", "externalURL", "description", "name",
  null /* attributes — see note above, not extractable this way */,
  "backgroundColor", "animationURL", "youtubeURL",
];

// Splits `str` on `sep` at depth 0 only, respecting ()/{}/[] nesting — needed
// because a qeval struct's fields are naturally comma-separated but a field's
// own value (e.g. the opaque Attributes slice placeholder) can itself contain
// parens/brackets that must not be mistaken for a field boundary.
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

// Parses one `(<value> <type>)` field chunk from a qeval struct rendering.
// The type is always the last top-level-space-separated token (package paths
// and slice types never contain spaces); everything before it is the value.
// A zero-value string renders with literally nothing between the parens and
// the type (`( string)`, not `("" string)`) — handled explicitly below.
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
  if (/^-?\d+$/.test(value)) return Number(value);
  return null; // complex/unsupported type (slice, nested struct, ref, ...)
}

// Parses a `(struct{(v1 t1),(v2 t2),...} pkgpath.Type)` qeval line into
// {fieldName: value}, using fieldNames for positional field names (pass null
// for a field to skip it — see GRC721_METADATA_FIELDS above).
function parseGnoStruct(raw, fieldNames) {
  const m = /^\(struct\{(.*)\}\s+\S+\)$/.exec(raw.trim());
  if (!m) return null;
  const chunks = splitTopLevel(m[1], ",");
  const result = {};
  chunks.forEach((chunk, i) => {
    const name = fieldNames[i];
    if (name) result[name] = parseGnoStructFieldValue(chunk);
  });
  return result;
}

// Calls TokenMetadata(tid) on a collection's own path and parses the result.
// Returns null on any error (including the collection not implementing this
// interface at all) — this is a best-effort secondary read, never a throw.
async function fetchOnchainMetadata(path, tid) {
  try {
    const raw = await qevalOn(path, `TokenMetadata(${JSON.stringify(tid)})`);
    const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length < 2 || lines[1] !== "(undefined)") return null; // errored (2nd return value is a non-nil error)
    return parseGnoStruct(lines[0], GRC721_METADATA_FIELDS);
  } catch {
    return null;
  }
}

function svgTextToDataUrl(svgText) {
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgText)));
}

// Reads Metadata.Attributes ([]Trait) for the OpenSea on-chain-metadata path.
// This is NOT a plain qeval(pkgpath.Func(args)) call — vm/qeval also accepts
// an arbitrary Gno expression, including a function literal invoked inline,
// so the slice can be indexed and dereferenced entirely on the chain side,
// returning a plain string qeval renders normally. That sidesteps the opaque
// `slice[ref(...)]` placeholder a bare TokenMetadata() call produces (see
// fetchOnchainMetadata's doc comment) — confirmed working against the real
// deployed gno-nft-minter collection. General across any collection
// implementing the official IGRC721MetadataOnchain interface, not specific
// to that one.
//
// TraitType and Value are joined with "=" in ONE inline call rather than
// fetched separately, to keep the RPC cost to one call per attribute — a
// value that itself contains "=" would split incorrectly (accepted
// trade-off; real trait values are simple labels in practice). Deliberately
// avoids needing any string-escaping helper (strconv.Quote etc.) that the
// target package may not have imported — the expression only uses `+` and
// indexing, both language built-ins, so it works regardless of what the
// collection's own package imports.
const MAX_ATTRIBUTES_TO_FETCH = 30;

async function fetchOnchainAttributes(path, tid) {
  try {
    const countExpr = `func() int { m, _ := TokenMetadata(${JSON.stringify(tid)}); return len(m.Attributes) }()`;
    const [count] = parseGnoLines(await qevalOn(path, countExpr));
    if (typeof count !== "number" || count <= 0) return [];
    const indices = Array.from({ length: Math.min(count, MAX_ATTRIBUTES_TO_FETCH) }, (_, i) => i);
    const attrs = await mapLimit(indices, 4, async (i) => {
      const expr = `func() string { m, _ := TokenMetadata(${JSON.stringify(tid)}); t := m.Attributes[${i}]; return t.TraitType + "=" + t.Value }()`;
      const [combined] = parseGnoLines(await qevalOn(path, expr));
      const eq = typeof combined === "string" ? combined.indexOf("=") : -1;
      return eq === -1 ? null : { traitType: combined.slice(0, eq), value: combined.slice(eq + 1) };
    });
    return attrs.filter(Boolean);
  } catch {
    return [];
  }
}

// Resolves full display info for one token, trying both officially-sanctioned
// metadata interfaces in turn: TokenURI's JSON first (fetching a real URL if
// that's what was returned), then falling back to TokenMetadata's on-chain
// struct (including its Attributes, read via fetchOnchainAttributes above).
// Never throws — returns whatever fields it could find, nulls/[] for the
// rest, so callers can render a partial result instead of a placeholder.
async function fetchTokenDisplayInfo(path, tid, tokenURI) {
  const empty = { name: null, image: null, description: null, backgroundColor: null, attributes: [] };
  const meta = metadataFromTokenURI(tokenURI);
  if (meta?.__fetch) {
    try {
      const res = await fetch(meta.__fetch);
      const json = await res.json();
      if (json.name || json.image) {
        return {
          name: json.name || null, image: json.image || null, description: json.description || null,
          backgroundColor: json.background_color || null,
          attributes: (json.attributes || []).map((a) => ({ traitType: a.trait_type, value: a.value })),
        };
      }
    } catch { /* fall through to on-chain metadata */ }
  } else if (meta?.name || meta?.image) {
    return {
      name: meta.name || null, image: meta.image || null, description: meta.description || null,
      backgroundColor: meta.background_color || null,
      attributes: (meta.attributes || []).map((a) => ({ traitType: a.trait_type, value: a.value })),
    };
  }

  const onchain = await fetchOnchainMetadata(path, tid);
  if (onchain && (onchain.name || onchain.image || onchain.imageData)) {
    return {
      name: onchain.name || null,
      image: onchain.image || (onchain.imageData ? svgTextToDataUrl(onchain.imageData) : null),
      description: onchain.description || null,
      backgroundColor: onchain.backgroundColor || null,
      attributes: await fetchOnchainAttributes(path, tid),
    };
  }
  return empty;
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
// superseded on its own. `onFound(item)` fires the moment a collection is
// detected (awaited, so a caller can enrich it inline before the next realm
// starts) — lets a caller render results incrementally instead of waiting
// for the whole scan to finish. This is the light client-side fallback scan
// (collections.html's "Scan now" button) — the primary data source is the
// pre-built cache at data/collections-{chainId}.json (see
// scripts/refresh-collections.mjs), which also computes thumbnails/holder
// counts too expensive to run live in every visitor's browser.
async function scanChainForCollections(onProgress, onFound) {
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
      // A satellite adapter (see SATELLITE_ADAPTERS above) forwards
      // OwnerOf/TokenURI/etc to a real collection and mentions grc721 in
      // its own imports — it trips this same detector and would otherwise
      // show up as a second, duplicate "collection" alongside the real
      // one, with identical tokens. It isn't a collection to browse in its
      // own right, just a redirect target, so skip it here.
      const isAdapterPath = Object.values(SATELLITE_ADAPTERS).includes(path);
      if (standard && !isAdapterPath) {
        const item = { path, standard };
        found.push(item);
        await onFound?.(item);
      }
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

// Best-effort: resolve just the first token's display info (mainly its
// image) — a lighter cousin of fetchCollectionTokens for callers that only
// want a thumbnail, not the whole collection. Tries a handful of low
// candidate indices and stops at the first one that resolves, so a
// "Scan now" live scan can show a thumbnail per collection as it's found
// instead of leaving every row imageless (that used to be deferred
// entirely to the server-side cache — see scripts/refresh-collections.mjs
// — but a manual, user-initiated scan over a small, already-filtered
// candidate list is a bounded, reasonable cost to pay live).
const FIRST_TOKEN_PROBE_LIMIT = 8;

async function fetchFirstTokenImage(path) {
  for (let i = 0; i < FIRST_TOKEN_PROBE_LIMIT; i++) {
    for (const tid of candidateTokenIds(i)) {
      try {
        const [owner] = parseGnoLines(await qevalOn(path, `OwnerOf(${JSON.stringify(tid)})`));
        if (!owner) continue;
        const tokenURI = await fetchTokenURI(path, tid);
        const display = await fetchTokenDisplayInfo(path, tid, tokenURI);
        return display.image || null;
      } catch { /* try the next candidate ID shape */ }
    }
  }
  return null;
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

// Discovery has to stay sequential (the "stop after N consecutive misses"
// heuristic only means anything in index order), but `onToken(token)` fires
// — and is awaited — the moment each one resolves, before moving to the
// next index. That lets a caller start enriching/rendering that token
// immediately instead of waiting for the whole probe to finish, without
// needing this function itself to change shape.
//
// `tokenCount` is NEVER trusted as a hard upper bound on the index to probe
// to, only as a hint for the progress display — confirmed live against a
// real collection (sapphire-1's Gems g7): TokenCount() reports *current
// supply* (8), not *highest index ever minted*, and a single burned token
// (id 0000004) among lower indices meant a real, currently-held token at
// id 0000008 sat past that count entirely and was silently missed when the
// old code capped enumeration at tokenCount. A collection that burns has a
// higher max index than its count; always probing the full window (with
// the same consecutive-miss early exit either way) is the only safe
// option, at the cost of a handful of extra probes past a known-small
// collection's real end.
async function fetchCollectionTokens(path, tokenCount, onProgress, onToken) {
  const limit = MAX_SEQUENTIAL_PROBE;
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
      if (consecutiveMisses >= CONSECUTIVE_MISS_LIMIT) break;
      continue;
    }
    consecutiveMisses = 0;
    const tokenURI = await fetchTokenURI(path, resolved.tokenId);
    const token = { tokenId: resolved.tokenId, owner: resolved.owner, tokenURI };
    tokens.push(token);
    await onToken?.(token);
  }
  return tokens;
}
