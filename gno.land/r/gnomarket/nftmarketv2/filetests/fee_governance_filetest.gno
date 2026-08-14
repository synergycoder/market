// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnomarket/nftmarketv2"
)

var deployer = testutils.TestAddress("deployer")

func main(cur realm) {
	// Before ClaimAdmin, there's no one to receive a fee — computeFee (and
	// therefore any Buy) charges nothing rather than erroring.
	println("admin before claim:", nftmarketv2.Admin() == "")
	println("estimated fee before claim:", nftmarketv2.EstimateFee(1_000_000))

	testing.SetOriginCaller(deployer)
	nftmarketv2.ClaimAdmin(cross(cur))
	println("admin after claim:", nftmarketv2.Admin() == deployer)

	mode, value := nftmarketv2.GetFee()
	println("initial fee mode:", mode)
	println("initial fee value:", value)

	testing.SetOriginCaller(deployer)
	nftmarketv2.SetFee(cross(cur), nftmarketv2.FeeModePercent, 250) // 2.5%
	mode, value = nftmarketv2.GetFee()
	println("fee mode after SetFee:", mode)
	println("fee value after SetFee:", value)
	println("estimated fee on 1,000,000 ugnot sale:", nftmarketv2.EstimateFee(1_000_000))
}

// Output:
// admin before claim: true
// estimated fee before claim: 0
// admin after claim: true
// initial fee mode: flat
// initial fee value: 1000000
// fee mode after SetFee: percent
// fee value after SetFee: 250
// estimated fee on 1,000,000 ugnot sale: 25000
