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
	someoneElse  = testutils.TestAddress("someoneElse")
	marketAddr   = chain.PackageAddress("gno.land/r/gnomarket/nftmarketv2")
	collectionID = "gno.land/r/gnomarket/testcollectionv2"
)

func main(cur realm) {
	testcollectionv2.Mint(cross(cur), seller, "1")
	testcollectionv2.Mint(cross(cur), seller, "2")
	testcollectionv2.RegisterWithMarketplace(cross(cur))

	testing.SetOriginCaller(seller)
	testcollectionv2.SetApprovalForAll(cross(cur), marketAddr, true)

	testing.SetOriginCaller(seller)
	nftmarketv2.List(cross(cur), collectionID, "1", 1000)
	testing.SetOriginCaller(seller)
	nftmarketv2.List(cross(cur), collectionID, "2", 1000)
	println("listings after listing both:", nftmarketv2.ListingsCount())

	// Token 1 goes stale because the seller sells/transfers it away from
	// under the listing, entirely outside the marketplace.
	testing.SetOriginCaller(seller)
	testcollectionv2.Transfer(cross(cur), someoneElse, "1")

	// Token 2 goes stale because the seller simply revokes the approval —
	// still owns it, just no longer lets the marketplace move it.
	testing.SetOriginCaller(seller)
	testcollectionv2.SetApprovalForAll(cross(cur), marketAddr, false)

	// Anyone — not just the seller, not just an involved party — can prune
	// both, since staleness here is an objective fact, not a discretionary
	// call. A random stranger does it.
	testing.SetOriginCaller(stranger)
	nftmarketv2.PruneStale(cross(cur), collectionID, "1")
	testing.SetOriginCaller(stranger)
	nftmarketv2.PruneStale(cross(cur), collectionID, "2")

	println("listings after pruning both:", nftmarketv2.ListingsCount())
	_, stillListed1 := nftmarketv2.GetListing(collectionID, "1")
	_, stillListed2 := nftmarketv2.GetListing(collectionID, "2")
	println("token 1 still listed:", stillListed1)
	println("token 2 still listed:", stillListed2)
}

// Output:
// listings after listing both: 2
// listings after pruning both: 0
// token 1 still listed: false
// token 2 still listed: false
