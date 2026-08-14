// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"chain"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnomarket/nftmarket"
	"gno.land/r/gnomarket/testcollection"
)

var (
	seller       = testutils.TestAddress("seller")
	marketAddr   = chain.PackageAddress("gno.land/r/gnomarket/nftmarket")
	collectionID = "gno.land/r/gnomarket/testcollection"
)

func main(cur realm) {
	testcollection.Mint(cross(cur), seller, "1")
	testcollection.RegisterWithMarketplace(cross(cur))

	// Single-token Approve this time (rather than SetApprovalForAll), for
	// coverage of the other approval path List/Buy/Cancel accept.
	testing.SetOriginCaller(seller)
	testcollection.Approve(cross(cur), marketAddr, "1")

	testing.SetOriginCaller(seller)
	nftmarket.List(cross(cur), collectionID, "1", 1000)

	testing.SetOriginCaller(seller)
	nftmarket.Cancel(cross(cur), collectionID, "1")

	// The token never left the seller's wallet in the first place — Cancel
	// is pure bookkeeping, so ownership is unaffected either way.
	owner, _ := testcollection.OwnerOf("1")
	println("owner after cancel:", owner == seller)
	println("listings after cancel:", nftmarket.ListingsCount())
}

// Output:
// owner after cancel: true
// listings after cancel: 0
