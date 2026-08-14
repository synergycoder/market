// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"chain"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnomarket/nftmarketv2"
	"gno.land/r/gnomarket/testcollectionv2"
)

var (
	seller       = testutils.TestAddress("seller")
	marketAddr   = chain.PackageAddress("gno.land/r/gnomarket/nftmarketv2")
	collectionID = "gno.land/r/gnomarket/testcollectionv2"
)

func main(cur realm) {
	testcollectionv2.Mint(cross(cur), seller, "1")
	testcollectionv2.RegisterWithMarketplace(cross(cur))

	// Single-token Approve this time (rather than SetApprovalForAll), for
	// coverage of the other approval path List/Buy/Cancel accept.
	testing.SetOriginCaller(seller)
	testcollectionv2.Approve(cross(cur), marketAddr, "1")

	testing.SetOriginCaller(seller)
	nftmarketv2.List(cross(cur), collectionID, "1", 1000)

	testing.SetOriginCaller(seller)
	nftmarketv2.Cancel(cross(cur), collectionID, "1")

	// The token never left the seller's wallet in the first place — Cancel
	// is pure bookkeeping, so ownership is unaffected either way.
	owner, _ := testcollectionv2.OwnerOf("1")
	println("owner after cancel:", owner == seller)
	println("listings after cancel:", nftmarketv2.ListingsCount())
}

// Output:
// owner after cancel: true
// listings after cancel: 0
