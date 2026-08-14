// PKGPATH: gno.land/r/gnomarket/main
package main

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnomarket/nftmarket"
)

var deployer = testutils.TestAddress("deployer")

func main(cur realm) {
	testing.SetOriginCaller(deployer)
	nftmarket.ClaimAdmin(cross(cur))

	testing.SetOriginCaller(deployer)
	nftmarket.SetFee(cross(cur), nftmarket.FeeModePercent, 9999) // above the 5000bps sanity cap
}

// Error:
// percent fee capped at 5000 bps (50%)
