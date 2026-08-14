// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnomarket/nftmarketv2"
)

var deployer = testutils.TestAddress("deployer")

func main(cur realm) {
	testing.SetOriginCaller(deployer)
	nftmarketv2.ClaimAdmin(cross(cur))

	testing.SetOriginCaller(deployer)
	nftmarketv2.SetFee(cross(cur), nftmarketv2.FeeModePercent, 9999) // above the 5000bps sanity cap
}

// Error:
// percent fee capped at 5000 bps (50%)
