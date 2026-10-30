# lax-holder-snapshot

Deterministic top N holder snapshot for a Token-2022 mint, with a stable sha256 hash.
Read only: it never signs or sends a transaction and never needs to hold the token.

## Install and test

```sh
npm ci
npm run typecheck
npm test          # node:test via tsx: 38 tests (26 for snapshot(), 12 for the CLI), no network
```

There is no CI workflow in this repository yet; run the three commands above locally (Node 20 or newer).

## Library: `src/snapshot.ts` exports `snapshot`

```ts
import { snapshot } from "./src/snapshot.ts";

const { holders, hash } = snapshot({
  accounts,      // { pubkey: string; owner: string; amount: string }[]  (amount: base 10 integer string, atomic units)
  exclusions,    // string[]  (optional; an account is left out when its owner OR its pubkey is in the list)
  top,           // integer, 100 when absent
});
// holders: { rank: number; owner: string; amount: string }[]   (rank from 1)
// hash:    64 lowercase hex characters
```

The output is exactly `{ holders, hash }` and each holder is exactly `{ rank, owner, amount }`.

Rules, in order:

1. Leave out every account whose `owner` or `pubkey` is in `exclusions`.
2. Sum the remaining amounts per owner with BigInt (exact above 2^53); amounts come back as base 10 strings.
3. Leave out owners whose total is zero.
4. Sort by amount descending, then owner ascending (plain JavaScript string comparison, i.e. UTF-16 code units, not locale order).
5. Keep the first `top`; ranks start at 1.
6. `hash` = sha256 of the UTF-8 text

```
holders.map(h => `${h.rank},${h.owner},${h.amount}`).join('\n')
```

with no header and no trailing newline. For no holders it is the sha256 of the empty text.

`snapshot` is pure and the order of the accounts (or of the exclusions) never changes the result.

Validation is deliberately light so short fixture names such as `"alice"` work: `pubkey` and `owner` must be strings,
`amount` must match `^[0-9]+$` (a string, never a JS number), and `top` must be a non negative integer. Anything else
throws a `TypeError`. Addresses are not checked for base58. A token account `pubkey` that appears twice in `accounts` also
throws a `TypeError` (`duplicate token account pubkey ...`), whether or not that account is excluded, because it would
be counted twice.

## Exclusions file

A JSON array of address strings. An account is left out when its owner or its token account address is in the array:

```json
["1nc1nerator11111111111111111111111111111111", "<bonding curve owner>", "<pool vault token account>"]
```

`exclusions.example.json` is a starting file (burn address only; add the curve, pools and project wallets per mint).

## CLI

```sh
npx tsx src/cli.ts --rpc <url> --mint <mint> --exclusions <file> [--top 100]
```

It reads every token account of the mint with `getProgramAccounts` on the Token-2022 program
(`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), `jsonParsed`, with `withContext` so the response carries the slot.
It maps each account to `{ pubkey, owner, amount }` (`amount` is `tokenAmount.amount`), runs `snapshot` and prints
one JSON object on stdout:

```json
{ "mint": "...", "slot": 123, "top": 100, "holders": [{ "rank": 1, "owner": "...", "amount": "..." }], "hash": "..." }
```

### Why two queries (dataSize)

Token-2022 token accounts are not a fixed size. A plain account is 165 bytes, but an account with extensions (transfer
fee, memo required, ...) is longer, so one `dataSize: 165` filter would silently drop every extended account. The CLI
therefore sends two disjoint queries, both with `memcmp` offset 0 = the mint:

| Query | Extra filter | Matches |
|---|---|---|
| plain | `dataSize: 165` | 165-byte accounts |
| extended | `memcmp` offset 165 = `3` (base58 of the byte `0x02`, the AccountType tag for a token account) | accounts with extensions (byte 165 is the AccountType; mints carry `1` there) |

A plain account has no byte 165 and an extended one is longer than 165, so the two sets never overlap. Every result
entry is also checked to be a parsed token account of the requested mint, and `snapshot` rejects duplicate pubkeys, so
an overlap or a repeated entry would fail loudly. The two queries are not atomic: `slot` is the context slot of the
first (plain) query, and the second sends `minContextSlot` = that slot so it is never older; extended-account balances
may be a few slots newer.

`--rpc`, `--mint` and `--exclusions` are required. Errors go to stderr with exit code 1.

The tests cover the CLI with a stub `fetch` (both request shapes and filters, mapping, output keys, duplicate rejection). The CLI has not been run
against a live RPC since this rewrite, and a very large mint may be refused by public RPCs for `getProgramAccounts`;
pass `--rpc` for another endpoint.

MIT licensed (see LICENSE). Built by BluThunder (bluthunder@agentmail.to).
