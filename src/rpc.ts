import { base58, base64 } from "@scure/base";
import type { TokenAccount } from "./snapshot.ts";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Decode the first 72 bytes of an SPL token account (same layout in Token and Token-2022):
 * mint [0,32) owner [32,64) amount u64 little endian [64,72).
 */
export function decodeTokenAccountHead(data: Uint8Array): { mint: string; owner: string; amount: bigint } {
  if (data.length < 72) throw new Error(`token account data too short: ${data.length}`);
  let amount = 0n;
  for (let i = 7; i >= 0; i--) amount = (amount << 8n) | BigInt(data[64 + i]!);
  return { mint: base58.encode(data.subarray(0, 32)), owner: base58.encode(data.subarray(32, 64)), amount };
}

export interface FetchResult {
  slot: number;
  accounts: TokenAccount[];
}

/**
 * Read every token account of a mint with getProgramAccounts, read only.
 * minContextSlot makes the RPC refuse to answer from an older slot; the returned slot is the
 * context slot the node actually served. No signing, no transactions.
 */
export async function fetchMintAccounts(opts: {
  rpcUrl: string;
  mint: string;
  programId?: string;
  minContextSlot?: number;
  fetch?: FetchLike;
}): Promise<FetchResult> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const programId = opts.programId ?? TOKEN_2022_PROGRAM;
  const config: Record<string, unknown> = {
    encoding: "base64",
    commitment: "finalized",
    withContext: true,
    dataSlice: { offset: 0, length: 72 },
    filters: [{ memcmp: { offset: 0, bytes: opts.mint } }],
  };
  // Classic Token accounts are always 165 bytes. Token-2022 accounts with extensions are longer,
  // so no dataSize filter there; the mint memcmp plus the program id is what selects them.
  if (programId === TOKEN_PROGRAM) (config.filters as unknown[]).push({ dataSize: 165 });
  if (opts.minContextSlot !== undefined) config.minContextSlot = opts.minContextSlot;

  const res = await f(opts.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [programId, config] }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as {
    error?: { message: string };
    result?: { context: { slot: number }; value: { pubkey: string; account: { data: [string, string] } }[] };
  };
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  if (!body.result) throw new Error("RPC returned no result");
  const accounts = body.result.value.map(({ pubkey, account }) => {
    const head = decodeTokenAccountHead(base64.decode(account.data[0]));
    if (head.mint !== opts.mint) throw new Error(`account ${pubkey} has mint ${head.mint}`);
    return { pubkey, owner: head.owner, amount: head.amount.toString(), mint: head.mint };
  });
  accounts.sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
  return { slot: body.result.context.slot, accounts };
}
