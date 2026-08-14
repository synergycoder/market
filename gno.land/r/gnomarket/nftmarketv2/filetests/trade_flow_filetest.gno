// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"chain"
	"chain/banker"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnomarket/nftmarketv2"
	"gno.land/r/gnomarket/testcollectionv2"
)

var (
	seller       = testutils.TestAddress("seller")
	buyer        = testutils.TestAddress("buyer")
	marketAddr   = chain.PackageAddress("gno.land/r/gnomarket/nftmarketv2")
	collectionID = "gno.land/r/gnomarket/testcollectionv2"
	price        = int64(5_000_000) // 5 GNOT — above the 1 GNOT default flat fee, so proceeds are clearly nonzero
)

func main(cur realm) {
	testcollectionv2.Mint(cross(cur), seller, "1")
	testcollectionv2.RegisterWithMarketplace(cross(cur))

	testing.SetOriginCaller(testutils.TestAddress("admin"))
	nftmarketv2.ClaimAdmin(cross(cur))

	// Seller approves the marketplace for ALL their tokens (SetApprovalForAll)
	// rather than transferring anything — the token never leaves their wallet.
	testing.SetOriginCaller(seller)
	testcollectionv2.SetApprovalForAll(cross(cur), marketAddr, true)

	owner, _ := testcollectionv2.OwnerOf("1")
	println("owner before list:", owner == seller)

	testing.SetOriginCaller(seller)
	nftmarketv2.List(cross(cur), collectionID, "1", price)
	println("listings after list:", nftmarketv2.ListingsCount())

	mode, value := nftmarketv2.GetFee()
	println("fee mode:", mode)
	println("fee value:", value)
	println("estimated fee:", nftmarketv2.EstimateFee(price))

	testing.IssueCoins(buyer, chain.Coins{{"ugnot", 10_000_000}})
	testing.IssueCoins(marketAddr, chain.Coins{{"ugnot", price}}) // simulates the attached-send arriving, see prior filetest notes
	testing.SetOriginCaller(buyer)
	testing.SetOriginSend(chain.Coins{{"ugnot", price}})
	nftmarketv2.Buy(cross(cur), collectionID, "1")

	owner, _ = testcollectionv2.OwnerOf("1")
	println("owner after buy:", owner == buyer)
	println("listings after buy:", nftmarketv2.ListingsCount())

	robanker := banker.NewReadonlyBanker()
	sellerBal := robanker.GetCoins(seller).AmountOf("ugnot")
	adminBal := robanker.GetCoins(nftmarketv2.Admin()).AmountOf("ugnot")
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
