# lax-holder-snapshot

CI: GitHub Actions workflow (Node 20 and 22: typecheck, test, mutation check) is being added; until then run `npm ci && npm run typecheck && npm test && npm run mutate`.

Deterministic top N holder snapshot for an SPL Token or Token-2022 mint, with a stable sha256 hash:
the same accounts, exclusions, slot and mint always give the same hash, whatever the input order.
Read only. It never signs or sends a transaction and never needs to hold the token.

## Install and test

```sh
npm ci
npm test          # node:test via tsx
npm run typecheck
npm run mutate    # plants 29 bugs one at a time; each must make the suite fail
```

## Library

```ts
import { snapshot } from "lax-holder-snapshot";

const { holders, hash, totalHolders } = snapshot({
  accounts,                 // [{ pubkey, owner, amount: "123" | 123n, mint? }]
  exclusions: {
    owners: [curve, pool],  // drop every account of these wallets
    accounts: [vault],      // drop single token accounts
  },
  top: 100,                 // default 100
  mint, slot,               // optional, bound into the hash
});
// holders: [{ rank: 1, owner, amount: "1000", accounts: 2 }, ...]
```

Rules, in order:

1. Validate: base58 pubkeys and owners, integer amounts in u64 range (strings or bigint, never JS numbers),
   no duplicate token accounts, every account's mint equals `mint` when given.
2. Drop excluded owners, excluded token accounts and zero balances.
3. Sum amounts per owner with bigint (exact above 2^53).
4. Sort by amount descending, then owner ascending in byte order (not locale order).
5. Keep the first `top`, ranks start at 1.
6. Hash: sha256 over UTF-8 of

```
lax-holder-snapshot/v1 mint=<mint or -> slot=<slot or -> top=<top>
1,<owner>,<amount>
2,<owner>,<amount>
...
```

each line ending in `\n`. Anyone can recompute it from `snapshot.json` with a few lines of code.

## Exclusions file

Exclusions can be kept in a JSON file with four optional categories:

```json
{
  "version": 1,
  "curve": ["<bonding curve owner>"],
  "pools": [{ "account": "<pool vault token account>", "label": "AMM vault" }],
  "burn": [{ "owner": "1nc1nerator11111111111111111111111111111111", "label": "incinerator" }],
  "project_wallets": [{ "owner": "<treasury owner>", "label": "treasury" }]
}
```

- A bare string is a wallet **owner**: every token account of that owner is dropped.
- `{ "owner": ... }` does the same; `{ "account": ... }` drops one token account only (e.g. a pool vault),
  so the same owner's other accounts still count. Give exactly one of `owner` or `account`; `label` is an optional note.
- Strict: unknown keys, `version` other than 1, non base58 addresses and malformed entries throw `SnapshotError`.
- Order and duplicates do not matter; addresses are de-duplicated and sorted.
- `exclusions.example.json` is a valid starting file (burn = Solana incinerator; fill in the rest per mint).

```ts
import { loadExclusionsFile, snapshot } from "lax-holder-snapshot";
const ex = loadExclusionsFile("exclusions.json"); // { owners, accounts, byCategory }
snapshot({ accounts, exclusions: ex, mint, slot });
```

The exclusion list is not part of the hash input (the hash covers the resulting holders, mint, slot and top),
so the CLI writes the merged `exclusions` into `snapshot.json` for audit.

## CLI

```sh
# live: Token-2022 by default, use --program token for classic SPL Token
npm run snapshot -- --mint <MINT> --top 100 \
  --exclusions exclusions.json \
  --exclude-owner <EXTRA_OWNER> --exclude-account <EXTRA_VAULT> \
  --rpc https://api.mainnet-beta.solana.com --min-slot <SLOT> --out out/

# offline: re-hash a saved fixture, should print the same hash
npm run snapshot -- --fixture out/fixture.json --top 100 --exclusions exclusions.json --out out2/
```

`--exclusions` and the `--exclude-*` flags are merged (union).

It calls `getProgramAccounts` with a memcmp filter on the mint (offset 0), `dataSlice` 0..72
(mint, owner, amount only) and `withContext`, so the result records the slot the node served.
`--min-slot` makes the node refuse to answer from an older slot. Classic Token adds `dataSize: 165`;
Token-2022 accounts with extensions are longer, so no size filter is used there.

Verified live against the public mainnet RPC on 2026-10-20 with PYUSD (Token-2022):
494,759 accounts, 58,078 non zero holders, fetched and re-hashed from the fixture with an identical hash.

Notes: a single RPC call cannot pin an exact historical slot; for a strict slot snapshot use an RPC
that serves at a slot (or an archive) and save `fixture.json` as the evidence. Some public RPCs rate limit
or refuse `getProgramAccounts` for very large mints; pass `--rpc` to use another endpoint.

MIT licensed. Built by BluThunder (bluthunder@agentmail.to).
