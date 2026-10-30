#!/usr/bin/env -S node --import tsx
// Usage: npx tsx src/cli.ts --rpc <url> --mint <mint> --exclusions <file> [--top 100]
//
// Reads every token account of the mint (two getProgramAccounts queries on the Token-2022 program, jsonParsed,
// one for 165-byte accounts and one for extended accounts, both filtered by mint), notes the context slot, maps the accounts to TokenAccount and prints one JSON
// object on stdout: { mint, slot, top, holders, hash }. Read only: it never signs or sends a transaction.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { snapshot, type Holder, type TokenAccount } from "./snapshot.ts";

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The exclusions file is a JSON array of address strings (matched against owner or token account). */
export function parseExclusions(data: unknown): string[] {
  if (!Array.isArray(data) || !data.every((x) => typeof x === "string"))
    throw new Error("exclusions file must be a JSON array of strings");
  return data as string[];
}

export function loadExclusions(path: string): string[] {
  return parseExclusions(JSON.parse(readFileSync(path, "utf8")));
}

type ParsedEntry = {
  pubkey: string;
  account: { data?: { parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string } } } } };
};

/** Map jsonParsed getProgramAccounts entries to TokenAccount. Entries of another mint are rejected. */
export function toTokenAccounts(entries: readonly ParsedEntry[], mint: string): TokenAccount[] {
  return entries.map((e) => {
    const info = e.account?.data?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    if (!info || typeof info.owner !== "string" || typeof amount !== "string")
      throw new Error(`account ${e.pubkey}: not a parsed token account`);
    if (info.mint !== mint) throw new Error(`account ${e.pubkey}: mint ${info.mint} is not ${mint}`);
    return { pubkey: e.pubkey, owner: info.owner, amount };
  });
}

/**
 * Token-2022 token accounts are NOT a fixed size: a plain account is 165 bytes, but accounts with extensions
 * (transfer fee, memo required, ...) are longer, and a single `dataSize` filter would silently drop one of the
 * two groups. So the mint is read with two disjoint queries, each with its own dataSize / account-type filter:
 *   A. plain accounts:    dataSize 165                 + memcmp offset 0 = mint
 *   B. extended accounts: memcmp offset 165 = [2]      + memcmp offset 0 = mint
 * Byte 165 of an extended Token-2022 account is the AccountType tag (1 = Mint, 2 = Account); [2] in base58 is "3".
 * A plain account has no byte 165, so it never matches B, and an extended one is longer than 165, so it never
 * matches A. The two result sets are disjoint; snapshot() rejects any duplicate pubkey, which would show a bug here.
 */
export const PLAIN_ACCOUNT_SIZE = 165;
export const ACCOUNT_TYPE_OFFSET = 165;
export const ACCOUNT_TYPE_ACCOUNT_B58 = "3"; // base58 of the single byte 0x02 (AccountType::Account)

export function accountFilters(mint: string): { plain: unknown[]; extended: unknown[] } {
  return {
    plain: [{ dataSize: PLAIN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint } }],
    extended: [
      { memcmp: { offset: ACCOUNT_TYPE_OFFSET, bytes: ACCOUNT_TYPE_ACCOUNT_B58 } },
      { memcmp: { offset: 0, bytes: mint } },
    ],
  };
}

async function queryAccounts(
  f: FetchLike,
  rpc: string,
  filters: unknown[],
  minContextSlot?: number,
): Promise<{ slot: number; value: ParsedEntry[] }> {
  const res = await f(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccounts",
      params: [
        TOKEN_2022_PROGRAM,
        {
          encoding: "jsonParsed",
          commitment: "finalized",
          withContext: true,
          ...(minContextSlot === undefined ? {} : { minContextSlot }),
          filters,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as {
    error?: { message?: string };
    result?: { context?: { slot?: number }; value?: ParsedEntry[] };
  };
  if (body.error) throw new Error(`RPC error: ${body.error.message ?? "unknown"}`);
  const slot = body.result?.context?.slot;
  if (typeof slot !== "number" || !Array.isArray(body.result?.value)) throw new Error("RPC returned no context or value");
  return { slot, value: body.result.value };
}

/**
 * Two queries (see accountFilters). `slot` is the context slot of the FIRST (plain) query; the second one sends
 * minContextSlot = that slot, so it is never older. Balances of extended accounts may be a few slots newer.
 */
export async function fetchAccounts(opts: {
  rpc: string;
  mint: string;
  fetch?: FetchLike;
}): Promise<{ slot: number; accounts: TokenAccount[] }> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const filters = accountFilters(opts.mint);
  const plain = await queryAccounts(f, opts.rpc, filters.plain);
  const extended = await queryAccounts(f, opts.rpc, filters.extended, plain.slot);
  return { slot: plain.slot, accounts: toTokenAccounts([...plain.value, ...extended.value], opts.mint) };
}

export async function run(
  argv: string[],
  deps: { fetch?: FetchLike } = {},
): Promise<{ mint: string; slot: number; top: number; holders: Holder[]; hash: string }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      rpc: { type: "string" },
      mint: { type: "string" },
      exclusions: { type: "string" },
      top: { type: "string", default: "100" },
    },
  });
  if (!values.rpc || !values.mint || !values.exclusions)
    throw new Error("usage: --rpc <url> --mint <mint> --exclusions <file> [--top 100]");
  if (!/^[0-9]+$/.test(values.top!)) throw new Error("--top must be a non negative integer");
  const top = Number(values.top);
  const exclusions = loadExclusions(values.exclusions);
  const { slot, accounts } = await fetchAccounts({ rpc: values.rpc, mint: values.mint, fetch: deps.fetch });
  const { holders, hash } = snapshot({ accounts, exclusions, top });
  return { mint: values.mint, slot, top, holders, hash };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (out) => console.log(JSON.stringify(out)),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
}
