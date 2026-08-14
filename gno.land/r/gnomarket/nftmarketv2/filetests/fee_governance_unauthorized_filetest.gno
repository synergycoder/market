// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnomarket/nftmarketv2"
)

var (
	deployer = testutils.TestAddress("deployer")
	stranger = testutils.TestAddress("stranger")
)

func main(cur realm) {
	testing.SetOriginCaller(deployer)
	nftmarketv2.ClaimAdmin(cross(cur))

	testing.SetOriginCaller(stranger)
	nftmarketv2.SetFee(cross(cur), nftmarketv2.FeeModePercent, 250)
}

// Error:
// ownable: caller is not owner
