import { test } from "node:test";
import assert from "node:assert/strict";
import { base58, base64 } from "@scure/base";
import { decodeTokenAccountHead, fetchMintAccounts, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type FetchLike } from "../src/rpc.ts";
import { addr, MINT } from "./helpers.ts";

function head(mint: string, owner: string, amount: bigint): string {
  const b = new Uint8Array(72);
  b.set(base58.decode(mint), 0);
  b.set(base58.decode(owner), 32);
  for (let i = 0; i < 8; i++) b[64 + i] = Number((amount >> BigInt(8 * i)) & 0xffn);
  return base64.encode(b);
}

test("decodes little endian u64 amount above 2^53", () => {
  const amt = (1n << 63n) + 12345n;
  const d = decodeTokenAccountHead(base64.decode(head(MINT, addr(1), amt)));
  assert.equal(d.amount, amt);
  assert.equal(d.owner, addr(1));
  assert.equal(d.mint, MINT);
});

test("rejects short data", () => {
  assert.throws(() => decodeTokenAccountHead(new Uint8Array(71)));
});

function mockRpc(value: unknown[], slot = 4242) {
  const calls: { body: any }[] = [];
  const f: FetchLike = async (_url, init) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot }, value } }) };
  };
  return { f, calls };
}

test("builds a read only getProgramAccounts request with mint filter and minContextSlot", async () => {
  const { f, calls } = mockRpc([]);
  await fetchMintAccounts({ rpcUrl: "http://rpc", mint: MINT, minContextSlot: 100, fetch: f });
  const [program, cfg] = calls[0]!.body.params;
  assert.equal(calls[0]!.body.method, "getProgramAccounts");
  assert.equal(program, TOKEN_2022_PROGRAM);
  assert.deepEqual(cfg.filters, [{ memcmp: { offset: 0, bytes: MINT } }]);
  assert.equal(cfg.minContextSlot, 100);
  assert.equal(cfg.withContext, true);
  assert.deepEqual(cfg.dataSlice, { offset: 0, length: 72 });
});

test("classic token program adds dataSize 165", async () => {
  const { f, calls } = mockRpc([]);
  await fetchMintAccounts({ rpcUrl: "http://rpc", mint: MINT, programId: TOKEN_PROGRAM, fetch: f });
  assert.deepEqual(calls[0]!.body.params[1].filters[1], { dataSize: 165 });
});

test("returns context slot and accounts sorted by pubkey", async () => {
  const { f } = mockRpc([
    { pubkey: addr(20), account: { data: [head(MINT, addr(2), 7n), "base64"] } },
    { pubkey: addr(10), account: { data: [head(MINT, addr(1), 5n), "base64"] } },
  ]);
  const r = await fetchMintAccounts({ rpcUrl: "http://rpc", mint: MINT, fetch: f });
  assert.equal(r.slot, 4242);
  assert.deepEqual(r.accounts, [
    { pubkey: addr(10), owner: addr(1), amount: "5", mint: MINT },
    { pubkey: addr(20), owner: addr(2), amount: "7", mint: MINT },
  ]);
});

test("refuses an account for another mint", async () => {
  const { f } = mockRpc([{ pubkey: addr(10), account: { data: [head(addr(3), addr(1), 5n), "base64"] } }]);
  await assert.rejects(fetchMintAccounts({ rpcUrl: "http://rpc", mint: MINT, fetch: f }));
});

test("surfaces RPC errors", async () => {
  const f: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "slot not reached" } }) });
  await assert.rejects(fetchMintAccounts({ rpcUrl: "http://rpc", mint: MINT, fetch: f }), /slot not reached/);
  const g: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(fetchMintAccounts({ rpcUrl: "http://rpc", mint: MINT, fetch: g }), /429/);
});

test("program ids are the real 32 byte mainnet ids", () => {
  assert.equal(TOKEN_PROGRAM, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  assert.equal(TOKEN_2022_PROGRAM, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  for (const p of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) assert.equal(base58.decode(p).length, 32);
});
