// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnomarket/nftmarket"
)

var deployer = testutils.TestAddress("deployer")

func main(cur realm) {
	// Before ClaimAdmin, there's no one to receive a fee — computeFee (and
	// therefore any Buy) charges nothing rather than erroring.
	println("admin before claim:", nftmarket.Admin() == "")
	println("estimated fee before claim:", nftmarket.EstimateFee(1_000_000))

	testing.SetOriginCaller(deployer)
	nftmarket.ClaimAdmin(cross(cur))
	println("admin after claim:", nftmarket.Admin() == deployer)

	mode, value := nftmarket.GetFee()
	println("initial fee mode:", mode)
	println("initial fee value:", value)

	testing.SetOriginCaller(deployer)
	nftmarket.SetFee(cross(cur), nftmarket.FeeModePercent, 250) // 2.5%
	mode, value = nftmarket.GetFee()
	println("fee mode after SetFee:", mode)
	println("fee value after SetFee:", value)
	println("estimated fee on 1,000,000 ugnot sale:", nftmarket.EstimateFee(1_000_000))
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
