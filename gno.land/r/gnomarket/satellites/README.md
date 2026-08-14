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

## Existing adapters

- `gemsg7adapterv2/` — wraps `gno.land/r/g17cjym5e9hhws46lt6329pv2gtx2ay0503hgems/g7`
  ("Gems"), sapphire-1 testnet. (v1 shipped without the defensive handling
  above, panicked on every trade, and — being immutable — had to be
  superseded by a fresh deploy rather than fixed in place; its dead
  registration is still on-chain but excluded from the frontend/cache.)
