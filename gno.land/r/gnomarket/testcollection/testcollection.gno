// Package testcollection is a minimal GRC721-like collection realm used to
// exercise gno.land/r/gnomarket/nftmarket's registration and escrow flow end
// to end. It also doubles as a concrete, minimal reference for how any
// collection — regardless of which vendored grc721 package it's built on,
// or a hand-rolled ledger like this one — wires up a market.NFT adapter.
// It is deliberately not a general-purpose GRC721 implementation (open
// mint, no approvals, no metadata): keep those concerns in a real
// collection, not in this fixture.
package testcollection

import (
	"encoding/base64"
	"errors"

	"gno.land/p/gnomarket/market"
	"gno.land/p/nt/avl/v0"
	"gno.land/p/nt/ufmt/v0"
	"gno.land/r/gnomarket/nftmarket"
)

var (
	owners    = avl.NewTree() // tid -> address
	tokenURIs = avl.NewTree() // tid -> string (data: URI, OpenSea-style JSON metadata)
)

var placeholderColors = []string{"steelblue", "seagreen", "indianred", "goldenrod", "mediumorchid", "darkslategray"}

// buildMetadataURI returns a self-contained data: URI JSON metadata blob
// (OpenSea metadata shape) whose image is itself an inline data: URI SVG —
// no network fetch needed to display it. Both are base64-encoded: a data:
// URI's payload must otherwise be percent-encoded for any character outside
// a narrow safe set, and this fixture has no URL-encoder handy, so base64
// sidesteps that entirely rather than risk producing an invalid URI.
func buildMetadataURI(tid, name string) string {
	sum := 0
	for _, b := range []byte(tid) {
		sum += int(b)
	}
	color := placeholderColors[sum%len(placeholderColors)]
	svg := ufmt.Sprintf(
		`<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><rect width='300' height='300' fill='%s'/><text x='150' y='150' font-size='28' fill='white' text-anchor='middle' dy='.3em' font-family='sans-serif'>%s</text></svg>`,
		color, name,
	)
	image := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))
	metadata := ufmt.Sprintf(`{"name":"%s","description":"gnomarket test collection","image":"%s"}`, name, image)
	return "data:application/json;base64," + base64.StdEncoding.EncodeToString([]byte(metadata))
}

// SetMetadata sets (or overwrites) tid's display name/image. Open to any
// caller — this is a test fixture, not a real collection's admin surface.
func SetMetadata(cur realm, tid, name string) {
	if !owners.Has(tid) {
		panic(errNoSuchToken.Error())
	}
	tokenURIs.Set(tid, buildMetadataURI(tid, name))
}

var (
	errNoSuchToken = errors.New("no such token")
	errNotOwner    = errors.New("caller is not the owner")
)

// Mint is an open, unrestricted mint — fine for a test fixture, never do
// this in a real collection.
func Mint(cur realm, to address, tid string) {
	if owners.Has(tid) {
		panic("token already exists: " + tid)
	}
	owners.Set(tid, to)
}

func OwnerOf(tid string) (address, error) {
	owner, ok := owners.Get(tid).(address)
	if !ok {
		return "", errNoSuchToken
	}
	return owner, nil
}

func TokenURI(tid string) (string, error) {
	if !owners.Has(tid) {
		return "", errNoSuchToken
	}
	uri, _ := tokenURIs.Get(tid).(string)
	return uri, nil
}

// transfer is the single internal authorization+mutation path shared by the
// public Transfer entrypoint and the marketplace adapter below.
func transfer(caller, from, to address, tid string) error {
	owner, ok := owners.Get(tid).(address)
	if !ok {
		return errNoSuchToken
	}
	if owner != from || caller != owner {
		return errNotOwner
	}
	owners.Set(tid, to)
	return nil
}

// Transfer sends the caller's own token to `to`. This is the plain,
// standalone GRC721-style transfer a seller calls directly — no marketplace
// involvement needed — to escrow a token to the marketplace's address
// before calling nftmarket.List.
func Transfer(cur realm, to address, tid string) {
	caller := cur.Previous().Address()
	if err := transfer(caller, caller, to, tid); err != nil {
		panic(err.Error())
	}
}

// marketAdapter satisfies market.NFT on top of this collection's own ledger.
// TransferFrom derives its caller from cur.Previous() itself, per market.NFT's
// contract, rather than trusting an argument — see gno.land/p/gnomarket/market
// for why that's what makes it safe to hand to an untrusted marketplace realm.
type marketAdapter struct{}

func (marketAdapter) Name() string                        { return "Test Collection" }
func (marketAdapter) OwnerOf(tid string) (address, error) { return OwnerOf(tid) }
func (marketAdapter) TokenURI(tid string) (string, error) { return TokenURI(tid) }
func (marketAdapter) TransferFrom(cur realm, from, to address, tid string) error {
	caller := cur.Previous().Address()
	return transfer(caller, from, to, tid)
}

var _ market.NFT = marketAdapter{}

// RegisterWithMarketplace registers this collection with the gnomarket
// marketplace. Callable by anyone since it only ever hands over a value that
// can move tokens the marketplace is already the realm-current caller for
// (i.e. tokens already escrowed to it) — see market.NFT's doc comment.
func RegisterWithMarketplace(cur realm) string {
	return nftmarket.RegisterCollection(cross(cur), marketAdapter{})
}
