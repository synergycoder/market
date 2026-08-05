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

	testing.SetOriginCaller(seller)
	testcollection.Transfer(cross(cur), marketAddr, "1")

	testing.SetOriginCaller(seller)
	nftmarket.List(cross(cur), collectionID, "1", 1000)

	testing.SetOriginCaller(seller)
	nftmarket.Cancel(cross(cur), collectionID, "1")

	owner, _ := testcollection.OwnerOf("1")
	println("owner after cancel:", owner == seller)
	println("listings after cancel:", nftmarket.ListingsCount())
}

// Output:
// owner after cancel: true
// listings after cancel: 0
