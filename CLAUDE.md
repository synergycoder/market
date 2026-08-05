# gno-nft-marketplace

An NFT marketplace realm for gno.land. Not yet started.

## Shared knowledge base

This project is one of a family of related gno.land projects developed in
separate sessions (siblings: `~/gno-observer`, `~/gno-nft-minter`,
`~/gno-tools`). They share a common knowledge file at
`~/gno-land-dev-notes.md`.

- At the start of substantial work here, read `~/gno-land-dev-notes.md` for
  established gno.land conventions (registry patterns, RPC call shapes,
  NFT detection heuristics, realm/package conventions, etc.) before
  rediscovering them from scratch.
- When you learn something broadly applicable to gno.land dev in general —
  not specific to this project's own code — append it to the "Cross-project
  discovery log" section at the bottom of that file, so the sibling
  projects benefit too. Keep project-specific implementation details local
  to this repo instead.

## Design note

Build against the standard GRC721/GRC1155 interface, not against
`gno-nft-minter` specifically — the marketplace should be able to list and
trade any compliant collection deployed by anyone, the same way real-world
NFT marketplaces aren't limited to one minting tool's output.
