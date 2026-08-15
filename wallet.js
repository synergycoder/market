// Shared Adena wallet pill — address (truncated) + GNOT balance + connect/
// disconnect, wired into any page that calls initWalletPill(). Adapted from
// gno-tools/tools/lib/adena-connect.js ("solved a lot of hiccups" per the
// user) but kept as a plain <script> (not an ES module) to match this
// project's no-build-step convention — every other page here is a flat
// <script src>, and mixing module/non-module script styles across pages
// would be its own source of hiccups.
//
// Requires shared.js's CONFIG.adenaAppName and truncAddr() to already be
// loaded first (see NETWORKS/CONFIG in shared.js).

// ---------------- localStorage "was connected before" flag ----------------
// Adena tracks per-domain approval itself; this is only OUR record of "the
// user completed AddEstablish before", so a reload can silently redo that
// round-trip instead of always showing a disconnected button. Never stores
// the address — that's always re-read fresh via GetAccount().
const WALLET_CONNECTED_KEY = "gnomarket:adenaConnected";

let walletAddress = null;
let walletChainId = null;
let walletConnecting = false;
let walletListenerRegistered = false;
let walletPillEls = null; // { root, btn, addr, balance }

function isAvailableAdena() {
  return typeof window.adena !== "undefined";
}

// Adena's content script can inject after this page's own script already
// ran — a single synchronous check can false-negative. Poll briefly instead.
function waitForAdena(timeoutMs = 3000, intervalMs = 150) {
  return new Promise((resolve) => {
    if (isAvailableAdena()) { resolve(true); return; }
    const start = Date.now();
    const timer = setInterval(() => {
      if (isAvailableAdena()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

async function establishAdenaConnection() {
  const establishRes = await window.adena.AddEstablish(CONFIG.adenaAppName);
  const alreadyConnected = /already connected/i.test(establishRes?.message || "");
  if (establishRes?.status !== "success" && !alreadyConnected) {
    throw new Error(establishRes?.message || "Connection request was not approved.");
  }
  const accountRes = await window.adena.GetAccount();
  if (accountRes?.status !== "success" || !accountRes.data?.address) {
    throw new Error(accountRes?.message || "Could not read the connected account.");
  }
  return accountRes.data; // { address, chainId, coins }
}

function formatGnotBalance(coinsStr) {
  const m = /^(\d+)ugnot$/.exec(coinsStr || "");
  if (!m) return null;
  return (Number(m[1]) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 }) + " GNOT";
}

function renderPillState(state) {
  if (!walletPillEls) return;
  const { root, btn, addr, balance } = walletPillEls;
  switch (state) {
    case "connecting":
      root.classList.remove("connected");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Connecting…';
      addr.textContent = "";
      balance.textContent = "";
      break;
    case "connected":
      root.classList.add("connected");
      btn.disabled = false;
      btn.textContent = "Disconnect";
      addr.textContent = truncAddr(walletAddress);
      addr.title = walletAddress;
      break;
    default: // idle
      root.classList.remove("connected");
      btn.disabled = false;
      btn.textContent = "Connect Adena";
      addr.textContent = "";
      balance.textContent = "";
  }
}

function applyConnectedUI(account) {
  walletAddress = account.address;
  walletChainId = account.chainId;
  renderPillState("connected");
  if (walletPillEls) walletPillEls.balance.textContent = formatGnotBalance(account.coins) || "";

  if (!walletListenerRegistered) {
    // Adena has no unsubscribe API, so this listener outlives any later
    // disconnect on the same page — guard on live connected state so it
    // doesn't silently reconnect the UI after a manual disconnect.
    window.adena.On?.("changedAccount", (newAddress) => {
      if (!newAddress || !walletPillEls?.root.classList.contains("connected")) return;
      walletAddress = typeof newAddress === "string" ? newAddress : newAddress?.address;
      renderPillState("connected");
    });
    walletListenerRegistered = true;
  }
  try { localStorage.setItem(WALLET_CONNECTED_KEY, "1"); } catch { /* ignore */ }
  document.dispatchEvent(new CustomEvent("wallet:connected", { detail: { address: walletAddress } }));
}

// Adena has no page-side "revoke" API by design — Disconnect only forgets
// our own "was connected" flag so a reload goes back to idle instead of
// auto-reconnecting; the extension's own per-domain approval is untouched.
function disconnectWallet() {
  walletAddress = null;
  walletChainId = null;
  renderPillState("idle");
  try { localStorage.removeItem(WALLET_CONNECTED_KEY); } catch { /* ignore */ }
  document.dispatchEvent(new CustomEvent("wallet:disconnected"));
}

async function connectWallet() {
  if (walletConnecting) return walletAddress;
  if (!isAvailableAdena()) {
    if (walletPillEls) walletPillEls.balance.textContent = "Adena not detected — install it from adena.app";
    return null;
  }
  walletConnecting = true;
  renderPillState("connecting");
  try {
    applyConnectedUI(await establishAdenaConnection());
    return walletAddress;
  } catch (err) {
    renderPillState("idle");
    if (walletPillEls) walletPillEls.balance.textContent = "Connect failed: " + err.message;
    try { localStorage.removeItem(WALLET_CONNECTED_KEY); } catch { /* ignore */ }
    return null;
  } finally {
    walletConnecting = false;
  }
}

async function autoReconnectWallet() {
  let wasConnected = false;
  try { wasConnected = localStorage.getItem(WALLET_CONNECTED_KEY) === "1"; } catch { /* ignore */ }
  if (!wasConnected) return;
  if (!(await waitForAdena())) return;

  walletConnecting = true;
  renderPillState("connecting");
  try {
    applyConnectedUI(await establishAdenaConnection());
  } catch {
    // Silent — this attempt was automatic, not a click, so a scary error
    // would be confusing. Falls back to a normal idle button.
    renderPillState("idle");
    try { localStorage.removeItem(WALLET_CONNECTED_KEY); } catch { /* ignore */ }
  } finally {
    walletConnecting = false;
  }
}

async function ensureConnected() {
  if (walletAddress) return walletAddress;
  return connectWallet();
}

// Signs and broadcasts a single /vm.m_call message via Adena's DoContract.
// Returns { ok, message? } — never throws, so callers can render a status
// line without their own try/catch boilerplate.
//
// Listing an NFT does NOT bundle SetApprovalForAll+List into one
// DoContract call with two messages, even though that would be the more
// elegant fix for the confirmation-timing race (and IS confirmed to work
// at the contract level — verified directly against sapphire-1 with
// gno.land/pkg/gnoclient, bypassing Adena, for both a native registration
// and a satellite-adapter one). Real-world testing through actual Adena
// hit the exact same "not approved" panic with the bundled version that
// the earlier two-transaction-with-a-short-timeout version hit — meaning
// either Adena doesn't genuinely bundle multiple /vm.m_call messages into
// one atomic tx the way it's confirmed to for /bank.MsgSend (see
// ~/gno-land-dev-notes.md), or does so with a bug. It's also not a single
// function doing both transactions automatically back-to-back, even as
// two separate txs: approveForListing/createListing below are deliberately
// split so createListing only ever fires from a fresh button click, not an
// automatic continuation after an async poll — see approveForListing's own
// doc comment for why that distinction turned out to matter.
async function signAndBroadcast(pkgPath, func, args, sendCoins) {
  const addr = await ensureConnected();
  if (!addr) return { ok: false, message: "Wallet not connected." };
  try {
    const res = await window.adena.DoContract({
      messages: [{
        type: "/vm.m_call",
        value: { caller: addr, send: sendCoins || "", pkg_path: pkgPath, func, args },
      }],
    });
    if (res?.status !== "success") throw new Error(res?.message || `${func} was not approved or failed.`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `${func} failed: ` + (err?.message || err) };
  }
}

// A natively-registered collection (its own deployer called
// RegisterCollection) approves the marketplace's own address, directly on
// its own path — collectionID and the approval target are the same thing.
// A satellite-adapter collection (registered by us, without that
// deployer's involvement — see gno.land/r/gnomarket/satellites and its own
// README) can't work that way: collectionID is unavoidably the adapter's
// own path, not the real collection's, so the real collection has no idea
// what "the marketplace" even is — a seller has to approve the ADAPTER's
// address, on the REAL collection's path. An adapter exposes exactly two
// extra functions, ApprovalTarget()/ApprovalOperator(), to say where and
// who; their absence (a plain qeval error) means this is a native
// registration, so fall back to the direct case.
async function resolveApprovalTarget(collectionID, marketAddr) {
  try {
    const [target] = parseGnoLines(await qevalOn(collectionID, "ApprovalTarget()"));
    const [operator] = parseGnoLines(await qevalOn(collectionID, "ApprovalOperator()"));
    if (target && operator) return { target, operator };
  } catch { /* no such functions — this is a natively-registered collection */ }
  return { target: collectionID, operator: marketAddr };
}

// Read-only: does collectionID currently show `seller` as having approved
// `marketAddr` — the exact same check List() itself performs. Retries once
// immediately on a read error before giving up on this one check —
// confirmed live that the public sapphire-1 RPC endpoint occasionally
// throws on a perfectly valid query (same query, same args, succeeded on
// retry moments later with no code change). Returns { approved, error } —
// error is the last raw failure seen (from either attempt), null if both
// attempts came back clean either way; kept even on approved:true/false so
// a caller building a diagnostic message always has the real reason to
// hand, not just a boolean.
async function checkApproval(collectionID, seller, marketAddr) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [approvedAll] = parseGnoLines(await qevalOn(collectionID, `IsApprovedForAll(${JSON.stringify(seller)}, ${JSON.stringify(marketAddr)})`));
      return { approved: !!approvedAll, error: lastError };
    } catch (err) {
      lastError = `${collectionID}.IsApprovedForAll(${seller}, ${marketAddr}): ` + (err?.message || err);
    }
  }
  return { approved: false, error: lastError };
}

// Boolean-only convenience wrapper — used where the caller only needs the
// current state, not a diagnostic (the initial render check on both
// /nft/ and My NFTs' cards).
async function isApprovedForListing(collectionID, seller, marketAddr) {
  return (await checkApproval(collectionID, seller, marketAddr)).approved;
}

// Adena's DoContract resolves "success" once a tx is accepted into the
// mempool (CheckTx), not once it's actually committed to a block — its own
// response never reliably carries a `height`, only a `hash` (see
// ~/gno-land-dev-notes.md). Poll checkApproval until it genuinely goes
// true. 90s / 2s errs long and patient: a real approval that landed but
// wasn't yet visible was mistaken for a failure at 20s in an earlier
// version of this function, even though it always did land moments later.
// Browser tabs also throttle timers heavily while backgrounded (e.g. while
// Adena's own popup has focus instead), so far fewer real checks may run
// in a given wall-clock window than intervalMs implies — approveForListing
// below re-checks once more, fresh, before treating a timeout as final.
// Returns { confirmed, lastError } — lastError is whatever checkApproval
// last reported, so a final failure message can say WHY, not just that it
// gave up.
async function waitForApproval(collectionID, seller, marketAddr, onTick, timeoutMs = 90000, intervalMs = 2000) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastError = null;
  for (;;) {
    const { approved, error } = await checkApproval(collectionID, seller, marketAddr);
    if (error) lastError = error;
    if (approved) return { confirmed: true, lastError };
    if (Date.now() >= deadline) return { confirmed: false, lastError };
    onTick?.(Math.round((Date.now() - start) / 1000));
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Approves the marketplace (or satellite adapter) for the whole collection
// and waits for that to actually land on-chain — step 1 of 2. Deliberately
// does NOT go on to create the listing itself: doing that automatically,
// right after this promise resolves (rather than from a fresh click), is
// what silently failed in practice — the List transaction either never
// prompted or never actually applied, even though nothing here threw and
// the approval genuinely had landed. Browser extensions commonly gate
// their own popup UI on a recent, real user gesture; an Adena call fired
// from inside an async continuation after a multi-second poll, with no
// new click in between, is exactly the shape that gesture requirement
// would silently swallow. Splitting this into two calls — this one, then
// createListing() from a SEPARATE button click — fixes that by construction:
// every DoContract call now traces back to its own fresh click.
async function approveForListing(collectionID, marketAddr, onStatus) {
  const { target, operator } = await resolveApprovalTarget(collectionID, marketAddr);
  onStatus?.("Approving marketplace… (check Adena)");
  const approveRes = await signAndBroadcast(target, "SetApprovalForAll", [operator, "true"], "");
  if (!approveRes.ok) return approveRes;

  onStatus?.("Waiting for the approval to confirm on-chain…");
  const seller = await ensureConnected();
  const { confirmed, lastError } = await waitForApproval(collectionID, seller, marketAddr,
    (elapsedSec) => onStatus?.(`Waiting for the approval to confirm on-chain… (${elapsedSec}s)`));
  if (confirmed) return { ok: true };

  // waitForApproval giving up doesn't necessarily mean the approval isn't
  // there — see its own doc comment on timer throttling and transient RPC
  // errors. One more fresh check, well clear of the polling loop, catches
  // exactly that case without making the seller manually reload the page.
  onStatus?.("Still checking…");
  const final = await checkApproval(collectionID, seller, marketAddr);
  if (final.approved) return { ok: true };
  const reason = final.error || lastError;
  console.error("[gnomarket] approval still not visible after 90s", { collectionID, target, operator, marketAddr, seller, reason });
  return {
    ok: false,
    message: "Approval was sent but still hasn't confirmed on-chain after 90s — this is unusual. It likely landed; wait a bit and click Approve again (harmless if it already went through)."
      + (reason ? ` [diagnostic: ${reason}]` : " [diagnostic: every check came back clean \"not approved\" — no read errors]"),
  };
}

// Step 2 of 2 — call only from a fresh click, once approveForListing has
// already confirmed. See approveForListing's own doc comment for why.
async function createListing(collectionID, tokenId, priceUgnot, onStatus) {
  onStatus?.("Creating listing… (check Adena)");
  return signAndBroadcast(net().marketPkgPath, "List", [collectionID, tokenId, String(priceUgnot)], "");
}

async function cancelListing(collectionID, tokenId) {
  return signAndBroadcast(net().marketPkgPath, "Cancel", [collectionID, tokenId], "");
}

// Direct wallet-to-wallet transfer, bypassing the marketplace entirely —
// no listing, no approval to the marketplace's address needed. Calls
// TransferFrom on the REAL collection realm (realCollectionPath — the
// same path OwnerOf/TokenURI reads already use, never a satellite
// adapter's path: an adapter's TransferFrom expects to be called BY the
// adapter itself during a Buy, not directly by a seller). TransferFrom
// (from == to == the caller's own address for a self-initiated transfer)
// rather than a bare Transfer(to, tid): confirmed live against the real
// Gems collection that it has no such convenience function, only the
// GRC721-standard TransferFrom/SafeTransferFrom pair — this is the one
// entrypoint good general-purpose evidence says is actually there on any
// real collection, not just this project's own test fixtures.
//
// If tid is currently listed on this marketplace, this leaves that
// listing stale (same as any other out-of-band move — see nftmarketv2's
// PruneStale doc comment) since nothing here is escrowed; the caller is
// expected to warn about that before calling this, not this function.
async function transferToken(realCollectionPath, from, to, tokenId, onStatus) {
  onStatus?.("Sending… (check Adena)");
  return signAndBroadcast(realCollectionPath, "TransferFrom", [from, to, tokenId], "");
}

// Injects the pill markup into `container` and wires it up. Call once per
// page, after shared.js has loaded.
function initWalletPill(container) {
  container.innerHTML = `
    <span class="wallet-pill" id="walletPill">
      <span class="wallet-info">
        <span class="wallet-addr mono" id="walletAddrText"></span>
        <span class="wallet-balance" id="walletBalanceText"></span>
      </span>
      <button id="walletConnectBtn" class="secondary">Connect Adena</button>
    </span>`;
  walletPillEls = {
    root: container.querySelector("#walletPill"),
    btn: container.querySelector("#walletConnectBtn"),
    addr: container.querySelector("#walletAddrText"),
    balance: container.querySelector("#walletBalanceText"),
  };
  walletPillEls.btn.addEventListener("click", () => {
    if (walletPillEls.root.classList.contains("connected")) disconnectWallet();
    else connectWallet();
  });
  renderPillState("idle");

  if (location.protocol === "file:") {
    walletPillEls.balance.textContent = "Serve over http(s) for Adena to work.";
  }
  autoReconnectWallet();
}

