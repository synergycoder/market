// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnomarket/nftmarket"
)

var (
	deployer = testutils.TestAddress("deployer")
	stranger = testutils.TestAddress("stranger")
)

func main(cur realm) {
	testing.SetOriginCaller(deployer)
	nftmarket.ClaimAdmin(cross(cur))

	testing.SetOriginCaller(stranger)
	nftmarket.SetFee(cross(cur), nftmarket.FeeModePercent, 250)
}

// Error:
// ownable: caller is not owner
