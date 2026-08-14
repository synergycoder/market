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

// Adena's DoContract resolves "success" once a tx is accepted into the
// mempool (CheckTx), not once it's actually committed to a block — its own
// response never reliably carries a `height`, only a `hash` (see
// ~/gno-land-dev-notes.md). Firing List immediately after a "successful"
// SetApprovalForAll can race ahead of that approval's real on-chain effect,
// so List's own approval check reads stale state and panics with
// "marketplace is not approved to transfer this token" even though the
// seller did everything right. Poll the exact same read nftmarket.gno's own
// isApproved() performs — IsApprovedForAll(seller, marketAddr) on
// collectionID, which for a satellite adapter correctly resolves through to
// its own approval regardless of the operator address passed in — until it
// genuinely goes true, or give up after a while.
async function waitForApproval(collectionID, seller, marketAddr, timeoutMs = 20000, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [approvedAll] = parseGnoLines(await qevalOn(collectionID, `IsApprovedForAll(${JSON.stringify(seller)}, ${JSON.stringify(marketAddr)})`));
      if (approvedAll) return true;
    } catch { /* not visible yet, or a transient read error — keep polling */ }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Approves the marketplace (or satellite adapter) for the whole collection,
// waits for that approval to actually land on-chain, then creates the
// listing — two transactions. onStatus, if given, is called with a
// progress message before each Adena prompt and while waiting in between.
async function listToken(collectionID, tokenId, priceUgnot, marketAddr, onStatus) {
  const { target, operator } = await resolveApprovalTarget(collectionID, marketAddr);
  onStatus?.("Approving marketplace… (1/2, check Adena)");
  const approveRes = await signAndBroadcast(target, "SetApprovalForAll", [operator, "true"], "");
  if (!approveRes.ok) return approveRes;

  onStatus?.("Waiting for the approval to confirm on-chain…");
  const seller = await ensureConnected();
  const confirmed = await waitForApproval(collectionID, seller, marketAddr);
  if (!confirmed) {
    return { ok: false, message: "Approval was sent but hasn't confirmed on-chain yet — wait a few seconds and try listing again." };
  }

  onStatus?.("Creating listing… (2/2, check Adena)");
  return signAndBroadcast(net().marketPkgPath, "List", [collectionID, tokenId, String(priceUgnot)], "");
}

async function cancelListing(collectionID, tokenId) {
  return signAndBroadcast(net().marketPkgPath, "Cancel", [collectionID, tokenId], "");
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

// ---------------- private-preview gate ----------------
// While gnomarket is only meant to be visible to its own owner (see
// CONFIG.ownerAddress), every page that shows real app content calls this
// once, after initWalletPill(). onChange(unlocked) fires immediately with
// the current state (false, unless a stored connection silently
// auto-reconnects to the owner's address before this runs — see below) and
// again on every connect/disconnect.
function isOwnerConnected() {
  return !!walletAddress && walletAddress === CONFIG.ownerAddress;
}

function initGate(onChange) {
  const apply = () => onChange(isOwnerConnected());
  document.addEventListener("wallet:connected", apply);
  document.addEventListener("wallet:disconnected", apply);
  apply();
}
