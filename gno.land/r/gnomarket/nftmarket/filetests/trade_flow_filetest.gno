// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"chain"
	"chain/banker"
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
	price        = int64(5_000_000) // 5 GNOT — above the 1 GNOT default flat fee, so proceeds are clearly nonzero
)

func main(cur realm) {
	testcollection.Mint(cross(cur), seller, "1")
	testcollection.RegisterWithMarketplace(cross(cur))

	testing.SetOriginCaller(testutils.TestAddress("admin"))
	nftmarket.ClaimAdmin(cross(cur))

	// Seller approves the marketplace for ALL their tokens (SetApprovalForAll)
	// rather than transferring anything — the token never leaves their wallet.
	testing.SetOriginCaller(seller)
	testcollection.SetApprovalForAll(cross(cur), marketAddr, true)

	owner, _ := testcollection.OwnerOf("1")
	println("owner before list:", owner == seller)

	testing.SetOriginCaller(seller)
	nftmarket.List(cross(cur), collectionID, "1", price)
	println("listings after list:", nftmarket.ListingsCount())

	mode, value := nftmarket.GetFee()
	println("fee mode:", mode)
	println("fee value:", value)
	println("estimated fee:", nftmarket.EstimateFee(price))

	testing.IssueCoins(buyer, chain.Coins{{"ugnot", 10_000_000}})
	testing.IssueCoins(marketAddr, chain.Coins{{"ugnot", price}}) // simulates the attached-send arriving, see prior filetest notes
	testing.SetOriginCaller(buyer)
	testing.SetOriginSend(chain.Coins{{"ugnot", price}})
	nftmarket.Buy(cross(cur), collectionID, "1")

	owner, _ = testcollection.OwnerOf("1")
	println("owner after buy:", owner == buyer)
	println("listings after buy:", nftmarket.ListingsCount())

	robanker := banker.NewReadonlyBanker()
	sellerBal := robanker.GetCoins(seller).AmountOf("ugnot")
	adminBal := robanker.GetCoins(nftmarket.Admin()).AmountOf("ugnot")
	println("seller received:", sellerBal)
	println("admin (fee recipient) received:", adminBal)
	println("seller + fee == price:", sellerBal+adminBal == price)
}

// Output:
// owner before list: true
// listings after list: 1
// fee mode: flat
// fee value: 1000000
// estimated fee: 1000000
// owner after buy: true
// listings after buy: 0
// seller received: 4000000
// admin (fee recipient) received: 1000000
// seller + fee == price: true
