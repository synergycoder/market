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
	buyer        = testutils.TestAddress("buyer")
	marketAddr   = chain.PackageAddress("gno.land/r/gnomarket/nftmarket")
	collectionID = "gno.land/r/gnomarket/testcollection"
)

func main(cur realm) {
	testing.IssueCoins(buyer, chain.Coins{{"ugnot", 1_000_000}})

	testcollection.Mint(cross(cur), seller, "1")
	testcollection.RegisterWithMarketplace(cross(cur))

	// Seller escrows the token to the marketplace, then lists it — two
	// separate direct calls, exactly as a real seller would make them.
	testing.SetOriginCaller(seller)
	testcollection.Transfer(cross(cur), marketAddr, "1")

	testing.SetOriginCaller(seller)
	nftmarket.List(cross(cur), collectionID, "1", 1000)

	println("listings after list:", nftmarket.ListingsCount())

	// A real MsgCall's attached coins land in the target realm's balance
	// before the function runs; simulate that arrival directly, since
	// testing.SetOriginSend only stubs the metadata unsafe.OriginSend() reads.
	testing.IssueCoins(marketAddr, chain.Coins{{"ugnot", 1000}})
	testing.SetOriginCaller(buyer)
	testing.SetOriginSend(chain.Coins{{"ugnot", 1000}})
	nftmarket.Buy(cross(cur), collectionID, "1")

	owner, _ := testcollection.OwnerOf("1")
	println("owner after buy:", owner == buyer)
	println("listings after buy:", nftmarket.ListingsCount())
}

// Output:
// listings after list: 1
// owner after buy: true
// listings after buy: 0
