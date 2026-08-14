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
	stranger     = testutils.TestAddress("stranger")
	marketAddr   = chain.PackageAddress("gno.land/r/gnomarket/nftmarketv2")
	collectionID = "gno.land/r/gnomarket/testcollectionv2"
)

func main(cur realm) {
	testcollectionv2.Mint(cross(cur), seller, "1")
	testcollectionv2.RegisterWithMarketplace(cross(cur))

	testing.SetOriginCaller(seller)
	testcollectionv2.SetApprovalForAll(cross(cur), marketAddr, true)

	testing.SetOriginCaller(seller)
	nftmarketv2.List(cross(cur), collectionID, "1", 1000)

	testing.SetOriginCaller(stranger)
	nftmarketv2.Cancel(cross(cur), collectionID, "1")
}

// Error:
// only the seller can cancel this listing
