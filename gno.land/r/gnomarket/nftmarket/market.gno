// Package nftmarket is a fixed-price escrow marketplace for any GRC721
// collection whose owning realm registers a market.NFT adapter (see
// gno.land/p/gnomarket/market). It never imports a specific collection's
// package — collections come to it at runtime as registered interface
// values, so it can list and trade any compliant collection deployed by
// anyone, not just ones it was compiled against.
//
// Trade flow:
//  1. The collection realm calls RegisterCollection once, handing over an
//     adapter that satisfies market.NFT.
//  2. A seller transfers their token to this realm's own address using the
//     collection's normal transfer entrypoint (no marketplace involvement
//     needed for that step — it's a plain GRC721 transfer).
//  3. The seller calls List, which verifies the token is now owned by this
//     realm before accepting the listing.
//  4. A buyer calls Buy with the exact price attached as ugnot; the realm
//     moves the token out of escrow to the buyer and forwards the payment
//     to the seller, in that order (effects before interactions).
package nftmarket

import (
	"chain"
	"chain/banker"
	"chain/runtime"
	"chain/runtime/unsafe"
	"strconv"

	"gno.land/p/gnomarket/market"
	"gno.land/p/nt/avl/v0"
	"gno.land/p/nt/ufmt/v0"
)

var (
	collections  = avl.NewTree() // collectionID (registrant's own PkgPath) -> market.NFT
	listings     = avl.NewTree() // listingKey -> *market.Listing
	listingOrder []string        // insertion order, for pagination/render
)

func listingKey(collectionID, tid string) string {
	return collectionID + ":" + tid
}

func removeFromOrder(key string) {
	for i, k := range listingOrder {
		if k == key {
			listingOrder = append(listingOrder[:i], listingOrder[i+1:]...)
			return
		}
	}
}

// RegisterCollection lets a collection realm register its market.NFT adapter.
// Must be called by the collection realm itself, crossing (cross(cur) from the
// collection's own registration function) — collectionID is derived from the
// caller's own PkgPath so no other realm can register under, or overwrite, a
// collection identity that isn't its own.
func RegisterCollection(cur realm, nft market.NFT) string {
	collectionID := cur.Previous().PkgPath()
	if collectionID == "" {
		panic("RegisterCollection must be called by a realm, not a direct user transaction")
	}
	collections.Set(collectionID, nft)
	return collectionID
}

func mustCollection(collectionID string) market.NFT {
	nft, ok := collections.Get(collectionID).(market.NFT)
	if !ok {
		panic("unregistered collection: " + collectionID)
	}
	return nft
}

func getListing(key string) (*market.Listing, bool) {
	l, ok := listings.Get(key).(*market.Listing)
	return l, ok
}

// IsRegistered reports whether collectionID has a registered adapter.
func IsRegistered(collectionID string) bool {
	return collections.Has(collectionID)
}

// RegisteredCollectionsCount returns the number of registered collections.
func RegisteredCollectionsCount() int {
	return collections.Size()
}

// GetRegisteredCollectionsPage returns a page of registered collections, one
// per line: collectionID|displayName. These are the only collections a
// seller can actually list here — for a frontend's sell-collection picker.
// Ordered by collectionID (the tree's natural key order); limit is clamped
// to [1, 100].
func GetRegisteredCollectionsPage(offset, limit int) string {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	out := ""
	collections.IterateByOffset(offset, limit, func(key string, value any) bool {
		nft, ok := value.(market.NFT)
		if !ok {
			return false
		}
		out += key + "|" + nft.Name() + "\n"
		return false
	})
	return out
}

// MarketAddress returns this realm's own address — the address a seller
// must transfer a token to (escrow) before calling List.
func MarketAddress() address {
	return unsafe.CurrentRealm().Address()
}

// List creates a fixed-price listing for tid. PREREQUISITE: the caller must
// have already transferred tid to this realm's own address (GetAddress)
// using the collection's normal transfer entrypoint — List only records the
// sale terms, it does not itself pull the token.
func List(cur realm, collectionID, tid string, price int64) {
	if price <= 0 {
		panic("price must be positive")
	}
	nft := mustCollection(collectionID)
	owner, err := nft.OwnerOf(tid)
	if err != nil {
		panic(err.Error())
	}
	marketAddr := cur.Address()
	if owner != marketAddr {
		panic("token is not escrowed to the marketplace — transfer it to " + marketAddr.String() + " first")
	}
	key := listingKey(collectionID, tid)
	if listings.Has(key) {
		panic("already listed")
	}
	seller := cur.Previous().Address()
	listings.Set(key, &market.Listing{
		CollectionID: collectionID,
		TokenID:      tid,
		Seller:       seller,
		Price:        price,
		CreatedAt:    runtime.ChainHeight(),
	})
	listingOrder = append(listingOrder, key)
}

// Cancel removes a listing and returns the token to the seller. Only the
// original seller may cancel.
func Cancel(cur realm, collectionID, tid string) {
	key := listingKey(collectionID, tid)
	l, ok := getListing(key)
	if !ok {
		panic("not listed")
	}
	if cur.Previous().Address() != l.Seller {
		panic("only the seller can cancel this listing")
	}

	// Effects before interactions.
	listings.Remove(key)
	removeFromOrder(key)

	nft := mustCollection(collectionID)
	if err := nft.TransferFrom(cross(cur), cur.Address(), l.Seller, tid); err != nil {
		panic(err.Error())
	}
}

// UpdatePrice changes the price of an existing listing. Only the seller may
// update it.
func UpdatePrice(cur realm, collectionID, tid string, newPrice int64) {
	if newPrice <= 0 {
		panic("price must be positive")
	}
	key := listingKey(collectionID, tid)
	l, ok := getListing(key)
	if !ok {
		panic("not listed")
	}
	if cur.Previous().Address() != l.Seller {
		panic("only the seller can update this listing")
	}
	l.Price = newPrice
}

// Buy purchases a listed token. The caller must send exactly the listing's
// price in ugnot with the transaction.
func Buy(cur realm, collectionID, tid string) {
	// Without this, an intermediary realm could call Buy on a user's behalf
	// and receive the token itself while funneling that user's ugnot as the
	// payment — AssertOriginCall keeps buyer identity and payment sender the
	// same account.
	runtime.AssertOriginCall()

	key := listingKey(collectionID, tid)
	l, ok := getListing(key)
	if !ok {
		panic("not listed")
	}
	buyer := cur.Previous().Address()
	if buyer == l.Seller {
		panic("cannot buy your own listing")
	}

	sent := unsafe.OriginSend()
	if len(sent) != 1 || sent[0].Denom != "ugnot" || sent[0].Amount != l.Price {
		panic(ufmt.Sprintf("payment must be exactly %d ugnot", l.Price))
	}

	// Effects before interactions.
	listings.Remove(key)
	removeFromOrder(key)

	nft := mustCollection(collectionID)
	if err := nft.TransferFrom(cross(cur), cur.Address(), buyer, tid); err != nil {
		panic(err.Error())
	}

	stdBanker := banker.NewBanker(banker.BankerTypeRealmSend, cur)
	stdBanker.SendCoins(cur.Address(), l.Seller, chain.Coins{{"ugnot", l.Price}})
}

// GetListing returns a listing by collection and token ID.
func GetListing(collectionID, tid string) (market.Listing, bool) {
	l, ok := getListing(listingKey(collectionID, tid))
	if !ok {
		return market.Listing{}, false
	}
	return *l, true
}

// ListingsCount returns the number of active listings.
func ListingsCount() int {
	return len(listingOrder)
}

// GetListingsPage returns a page of active listings, one per line, oldest
// first: collectionID|tokenID|seller|price. Intended for frontends — plain
// pipe-delimited text is trivial to parse client-side without a JSON
// encoder. limit is clamped to [1, 100].
func GetListingsPage(offset, limit int) string {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	if offset < 0 || offset >= len(listingOrder) {
		return ""
	}
	end := offset + limit
	if end > len(listingOrder) {
		end = len(listingOrder)
	}
	out := ""
	for _, key := range listingOrder[offset:end] {
		l, ok := getListing(key)
		if !ok {
			continue
		}
		out += l.CollectionID + "|" + l.TokenID + "|" + l.Seller.String() + "|" + strconv.Itoa(int(l.Price)) + "\n"
	}
	return out
}

// TokenInfo queries a registered collection's own adapter for display info
// about one of its tokens — for render/frontend use, not part of the trade
// flow itself.
func TokenInfo(collectionID, tid string) (name string, tokenURI string, owner address) {
	nft := mustCollection(collectionID)
	name = nft.Name()
	tokenURI, _ = nft.TokenURI(tid)
	owner, _ = nft.OwnerOf(tid)
	return
}
