# Satellite adapters

A satellite adapter registers a collection with gnomarket **without any
action from that collection's own deployer** — the standard onboarding
path (see `~/gno-land-dev-notes.md` and `p/gnomarket/market`'s own doc
comment) requires the collection itself to call `RegisterCollection`, which
only works when its author built with gnomarket in mind. Most collections
on the network weren't. A satellite adapter is a small realm we deploy
instead, on the collection's behalf, that forwards `market.NFT`'s methods
to the real collection's actual functions.

Each subdirectory here is the *source* for one such adapter — one per
target collection, since Gno's imports are static (there's no way to write
one generic adapter that dynamically targets an arbitrary path at
runtime). The deploy path recorded in each adapter's own `gnomod.toml`
reflects where it actually lives on-chain, which is **not** under
`gno.land/r/gnomarket/*` — on a real gno.land chain that namespace requires
registration (see the dev-notes entry on `r/sys/names`), so every satellite
adapter currently deploys under the project's own PA (personal-address)
namespace instead. This directory is just the checked-in source of record.

## Why a seller approves the adapter, not the marketplace

`RegisterCollection` derives `collectionID` from the real calling realm
(`cur.Previous().PkgPath()`) — spoof-proof by construction, so an adapter
can never claim to *be* the collection it wraps. That means `collectionID`
for an adapter-backed listing is unavoidably the adapter's own path, and a
seller has to grant approval on the **real** collection's contract, to the
**adapter's** address — not to the marketplace's address directly, and not
on `collectionID` itself. Each adapter exposes two extra functions,
`ApprovalTarget()` and `ApprovalOperator()`, so the frontend (`nft.html`)
can discover where and who; their absence just means a collection was
registered the normal, native way.

## Write GetApproved/IsApprovedForAll defensively — don't just pass through

`nftmarket.gno`'s own `isApproved` check is stricter than `market.NFT`'s
contract: it `panic`s on **any** error from `GetApproved`, when the
interface's own doc comment only promises `""` with a nil error for "no
approval" — and it checks `IsApprovedForAll(owner, marketAddr)` using its
*own* address, which is never the address a seller was actually told to
approve once an adapter is in the picture (see above). A real collection
can differ from both assumptions: `gemsg7adapter`'s first deploy passed
g7's `GetApproved` straight through, and g7's real implementation *errors*
(`ErrTokenIdNotHasApproved`) instead of returning an empty address when
nothing is individually approved — which meant `isApproved` panicked with
`"token id not approved for anyone"` on every single List/Buy, even for a
seller who'd correctly called `SetApprovalForAll`. Both bugs are fixable
entirely inside the adapter (never trust the wrapped collection's error
convention or the marketplace's own passed-in operator address at face
value), which is good news given `nftmarket.gno` itself is immutable —
but only if the adapter is written defensively from the start:

- `GetApproved`: swallow any error from the real collection and return
  `("", nil)` — never propagate a "not approved" condition as an error.
- `IsApprovedForAll`: ignore the passed-in `operator` entirely and check
  whether **this adapter's own address** is approved instead — that's the
  address that will actually call `TransferFrom`, and the only one a
  seller was ever told to approve.

## An adapter's marketplace import is static — a marketplace version bump means a new adapter too

An adapter registers with one specific marketplace deploy by importing it
(`nftmarket "gno.land/r/.../nftmarketv2"` and calling
`nftmarket.RegisterCollection` inside `RegisterWithMarketplace`) — a plain
Gno import, resolved at compile time. When the marketplace itself gets a
new deploy (immutable, same reasoning as everything else on this page),
every adapter's `RegisterWithMarketplace` is still pointed at the OLD
marketplace and has no way to repoint itself — there's no such thing as
"the same adapter, now importing something else." Each marketplace version
bump means every satellite adapter needs its own fresh deploy too, even
though nothing about the adapter's own logic changed.

## A CurrentRealm()-under-nested-dispatch bug (v3 -> v4 -> v5)

v3 hit a real, independently-reproduced bug: `vm/qeval` reads always showed
a seller's approval as correct (`IsApprovedForAll` → `true`), but the exact
same check inside a real `List()` transaction — confirmed via `.app/simulate`
against the same RPC node, same block height, same arguments — consistently
panicked with "marketplace is not approved to transfer this token" anyway.
Reproduced independently multiple times with disposable test collections
(bypassing Adena, the frontend, and the real seller's wallet entirely) to
rule out caching, Adena's own RPC/simulation behavior, and anything in this
project's own JavaScript.

v4 tried "redeploy fresh" as a mitigation, based on a controlled test where
a freshly-deployed-and-approved adapter succeeded where an older
registration didn't. That theory turned out wrong: v4, deployed fresh and
genuinely approved by the real seller on-chain (confirmed both directions —
`g7.IsApprovedForAll(seller, v4Addr)` and `gemsg7adapterv4.
IsApprovedForAll(seller, marketAddr)` both returned `true` via `qeval`) —
still failed identically through `.app/simulate`, reproduced independently
via `gnoclient.Client.Simulate()` against the real seller address and real
token. Freshness was never the variable that mattered.

Root cause, now isolated: v3/v4's `ApprovalTarget`/`ApprovalOperator`/
`IsApprovedForAll` all used `chain/runtime/unsafe`'s `CurrentRealm().
Address()` to find "this adapter's own address." A direct `qeval` call to
that same expression always resolved correctly. But the identical
expression, reached through `nftmarketv2.List()`'s nested `market.NFT`
interface dispatch (`nft.IsApprovedForAll(...)` where `nft` is an interface
value backed by the adapter, one hop deeper than a direct call) and
executed via `.app/simulate` specifically, resolved to something that made
the approval check fail. `vm/qeval` calling `IsApprovedForAll` directly
apparently doesn't go through the same call shape, so it never observed
the bug. v5 removes `CurrentRealm()` from these functions entirely,
replacing it with `chain.PackageAddress(selfPkgPath)` — a pure hash of a
compile-time pkgpath string literal (`gno.DerivePkgBech32Addr` under the
hood, the same derivation gno.land itself uses to assign a package's
address at deploy time), with no notion of "current call stack" for
nested dispatch to disturb. Verified independently before deploying v5
that `chain.PackageAddress(v4's own pkgpath)` computes the exact same
address v4's `CurrentRealm()` calls had been returning — confirming this
is the correct formula, not a different address that would just move the
bug elsewhere. This is a real, mechanism-level fix, not a freshness-based
mitigation like v4 was — though the underlying `CurrentRealm()` behavior
under nested interface dispatch during `.app/simulate` is itself still an
open question worth reporting upstream if it recurs anywhere else in this
codebase.

## Existing adapters

- `gemsg7adapterv5/` — wraps `gno.land/r/g17cjym5e9hhws46lt6329pv2gtx2ay0503hgems/g7`
  ("Gems"), sapphire-1 testnet, registered with `nftmarketv2`. Uses
  `chain.PackageAddress` instead of `CurrentRealm()` (see above). (v1
  shipped without the defensive `GetApproved`/`IsApprovedForAll` handling
  above and panicked on every trade; v2 fixed that but was still
  registered with the original `nftmarket`, superseded by `nftmarketv2`;
  v3 and v4 both hit the `CurrentRealm()`-under-nested-dispatch bug
  described above. v1-v4's registrations are still on-chain but
  dead/excluded from the frontend and cache.)
