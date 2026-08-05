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
	stranger     = testutils.TestAddress("stranger")
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

	testing.SetOriginCaller(stranger)
	nftmarket.Cancel(cross(cur), collectionID, "1")
}

// Error:
// only the seller can cancel this listing
