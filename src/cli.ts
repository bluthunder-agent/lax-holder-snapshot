#!/usr/bin/env -S node --import tsx
// Usage: npx tsx src/cli.ts --rpc <url> --mint <mint> --exclusions <file> [--top 100]
//
// Reads every token account of the mint (getProgramAccounts on the Token-2022 program, jsonParsed,
// filtered by mint), notes the context slot, maps the accounts to TokenAccount and prints one JSON
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

export async function fetchAccounts(opts: {
  rpc: string;
  mint: string;
  fetch?: FetchLike;
}): Promise<{ slot: number; accounts: TokenAccount[] }> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const res = await f(opts.rpc, {
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
          filters: [{ memcmp: { offset: 0, bytes: opts.mint } }],
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
  return { slot, accounts: toTokenAccounts(body.result.value, opts.mint) };
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
