// Package market defines the minimal, vendor-neutral interface a GRC721
// collection must expose to become tradeable on the gnomarket marketplace
// realm (gno.land/r/gnomarket/nftmarket).
//
// There is no canonical GRC721 import path on gno.land — every collection
// vendors its own copy (gno.land/p/gnoswap/deps/grc721, gno.land/p/samcrew/grc721,
// hand-rolled implementations, etc.), each with its own nominally-typed
// TokenID. To stay usable by any of them without the marketplace importing a
// specific vendor's package, this interface is expressed entirely in plain
// `string`/`address` types rather than a shared TokenID type. A collection
// wires itself up with a small adapter (a handful of lines) translating its
// own TokenID type to/from string — see the package doc on NFT below for the
// expected shape.
package market

// NFT is the write surface a collection registers with the marketplace via
// RegisterCollection. It is safe to hand a value of this type to an
// untrusted realm (the marketplace) because TransferFrom is `cur realm`-typed:
// the implementation must derive its caller from cur.Previous() itself, never
// from a trusted-blindly argument. The gno VM enforces that a stashed/foreign
// `cur` cannot be replayed through interface dispatch (IsCurrent-strict on
// cross), so the marketplace holding this value can only ever move a token
// while it is genuinely the calling realm — i.e. only tokens the collection's
// own ledger already shows as owned by the marketplace (escrowed).
//
// A typical adapter, written once by a collection author on top of any
// vendored grc721 package (nft below is that package's concrete type, kept in
// an unexported var by the owning realm):
//
//	type marketAdapter struct{}
//
//	func (marketAdapter) Name() string { return "MyCollection" }
//	func (marketAdapter) OwnerOf(tid string) (address, error) {
//		return nft.OwnerOf(grc721.TokenID(tid))
//	}
//	func (marketAdapter) TokenURI(tid string) (string, error) {
//		return nft.TokenURI(grc721.TokenID(tid))
//	}
//	func (marketAdapter) TransferFrom(cur realm, from, to address, tid string) error {
//		caller := cur.Previous().Address()
//		return nft.TransferFrom(caller, from, to, grc721.TokenID(tid))
//	}
//
//	func RegisterWithMarketplace(cur realm) {
//		nftmarket.RegisterCollection(cross(cur), marketAdapter{})
//	}
//
// (nftmarket here refers to the stateful realm gno.land/r/gnomarket/nftmarket,
// which re-exports this package's NFT/Listing types — a collection adapter
// only needs to satisfy the method set below, not import this package at all.)
type NFT interface {
	// Name returns the collection's display name, for render purposes only.
	Name() string
	// OwnerOf returns the current owner of tid in the collection's own ledger.
	OwnerOf(tid string) (address, error)
	// TokenURI returns the token's metadata URI, for render purposes only.
	TokenURI(tid string) (string, error)
	// TransferFrom moves tid from `from` to `to`. Implementations MUST derive
	// the effective caller from cur.Previous().Address() and apply their own
	// collection's normal transfer authorization against it — never trust a
	// caller identity passed in some other way.
	TransferFrom(cur realm, from, to address, tid string) error
}

// Listing is a fixed-price sale order held by the marketplace.
type Listing struct {
	CollectionID string // the registering realm's own PkgPath; spoof-proof
	TokenID      string
	Seller       address
	Price        int64 // ugnot
	CreatedAt    int64 // block height
}
