import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_TYPE_ACCOUNT_B58, accountFilters, fetchAccounts, loadExclusions, parseExclusions, run, toTokenAccounts, TOKEN_2022_PROGRAM, type FetchLike } from "../src/cli.ts";
import { snapshot } from "../src/snapshot.ts";

const MINT = "mintMINT";
const entry = (pubkey: string, owner: string, amount: string, mint = MINT) => ({
  pubkey,
  account: { data: { program: "spl-token-2022", parsed: { type: "account", info: { mint, owner, tokenAmount: { amount, decimals: 6 } } } } },
});
const ENTRIES = [entry("t1", "alice", "100"), entry("t2", "bob", "100"), entry("t3", "carol", "300"), entry("vault", "pool", "999")];

// Returns `value` for the plain (dataSize) query and `extended` for the extended-account query; records the calls.
function fakeFetch(value: unknown[], slot = 4242, extended: unknown[] = [], extendedSlot = slot) {
  const calls: { url: string; body: any }[] = [];
  const f: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const isPlain = body.params[1].filters.some((x: any) => x.dataSize !== undefined);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: isPlain ? slot : extendedSlot }, value: isPlain ? value : extended } }),
    };
  };
  return { f, calls };
}
const exFile = (data: unknown) => {
  const p = join(mkdtempSync(join(tmpdir(), "lhs-")), "ex.json");
  writeFileSync(p, JSON.stringify(data));
  return p;
};

test("exclusions file is a JSON array of strings", () => {
  assert.deepEqual(parseExclusions(["a", "b"]), ["a", "b"]);
  assert.deepEqual(loadExclusions(exFile(["x", "y"])), ["x", "y"]);
  assert.deepEqual(parseExclusions([]), []);
  for (const bad of [{}, { curve: [] }, [1], [["a"]], "a", null, [{ owner: "a" }]]) assert.throws(() => parseExclusions(bad), /JSON array of strings/);
});

test("the shipped example exclusions file loads", () => {
  assert.deepEqual(loadExclusions(new URL("../exclusions.example.json", import.meta.url).pathname), ["1nc1nerator11111111111111111111111111111111"]);
});

test("two getProgramAccounts requests on Token-2022, jsonParsed, with context, each filtered by mint", async () => {
  const { f, calls } = fakeFetch(ENTRIES);
  await fetchAccounts({ rpc: "http://rpc.test", mint: MINT, fetch: f });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.url, "http://rpc.test");
    assert.equal(c.body.method, "getProgramAccounts");
    assert.equal(c.body.params[0], TOKEN_2022_PROGRAM);
    assert.equal(c.body.params[1].encoding, "jsonParsed");
    assert.equal(c.body.params[1].withContext, true);
    assert.ok(c.body.params[1].filters.some((x: any) => x.memcmp?.offset === 0 && x.memcmp.bytes === MINT));
  }
});

test("plain query uses dataSize 165; extended query uses the AccountType tag at offset 165 (no dataSize)", async () => {
  const { f, calls } = fakeFetch(ENTRIES);
  await fetchAccounts({ rpc: "http://rpc.test", mint: MINT, fetch: f });
  assert.deepEqual(calls[0]!.body.params[1].filters, [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: MINT } }]);
  assert.deepEqual(calls[1]!.body.params[1].filters, [{ memcmp: { offset: 165, bytes: "3" } }, { memcmp: { offset: 0, bytes: MINT } }]);
  assert.deepEqual(accountFilters(MINT), { plain: calls[0]!.body.params[1].filters, extended: calls[1]!.body.params[1].filters });
  assert.equal(calls[1]!.body.params[1].filters.some((x: any) => x.dataSize !== undefined), false);
  assert.equal(calls[0]!.body.params[1].minContextSlot, undefined);
});

test("AccountType filter byte: base58 '3' is the single byte 0x02", () => {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  assert.equal(ALPHABET.indexOf(ACCOUNT_TYPE_ACCOUNT_B58), 2);
  assert.equal(ACCOUNT_TYPE_ACCOUNT_B58.length, 1);
});

test("extended accounts are included, the slot is the first query's, and the second query sends minContextSlot", async () => {
  const ext = [entry("x1", "dave", "500")];
  const { f, calls } = fakeFetch(ENTRIES, 100, ext, 103);
  const { slot, accounts } = await fetchAccounts({ rpc: "http://rpc.test", mint: MINT, fetch: f });
  assert.equal(slot, 100);
  assert.equal(calls[1]!.body.params[1].minContextSlot, 100);
  assert.deepEqual(accounts.map((a) => a.pubkey), ["t1", "t2", "t3", "vault", "x1"]);
});

test("run includes extended accounts in the snapshot", async () => {
  const { f } = fakeFetch(ENTRIES, 5, [entry("x1", "dave", "500")]);
  const out = await run(["--rpc", "http://rpc.test", "--mint", MINT, "--exclusions", exFile([]), "--top", "2"], { fetch: f });
  assert.deepEqual(out.holders.map((h) => h.owner), ["pool", "dave"]);
});

test("the same token account returned by both queries is rejected as a duplicate pubkey", async () => {
  const { f } = fakeFetch(ENTRIES, 5, [entry("t1", "alice", "100")]);
  await assert.rejects(
    run(["--rpc", "http://rpc.test", "--mint", MINT, "--exclusions", exFile([])], { fetch: f }),
    /duplicate token account pubkey t1/,
  );
});

test("jsonParsed entries map to TokenAccount {pubkey, owner, amount}", () => {
  assert.deepEqual(toTokenAccounts(ENTRIES.slice(0, 1), MINT), [{ pubkey: "t1", owner: "alice", amount: "100" }]);
  assert.throws(() => toTokenAccounts([entry("t9", "o", "1", "otherMint")], MINT), /is not mintMINT/);
  assert.throws(() => toTokenAccounts([{ pubkey: "t9", account: { data: {} } }], MINT), /not a parsed token account/);
});

test("run prints {mint, slot, top, holders, hash}, matching snapshot() on the same accounts", async () => {
  const { f } = fakeFetch(ENTRIES, 777);
  const ex = exFile(["pool"]);
  const out = await run(["--rpc", "http://rpc.test", "--mint", MINT, "--exclusions", ex, "--top", "2"], { fetch: f });
  assert.deepEqual(Object.keys(out), ["mint", "slot", "top", "holders", "hash"]);
  assert.equal(out.mint, MINT);
  assert.equal(out.slot, 777);
  assert.equal(out.top, 2);
  const expected = snapshot({ accounts: toTokenAccounts(ENTRIES, MINT), exclusions: ["pool"], top: 2 });
  assert.deepEqual(out.holders, expected.holders);
  assert.equal(out.hash, expected.hash);
  assert.deepEqual(out.holders.map((h) => h.owner), ["carol", "alice"]);
});

test("--top defaults to 100; a pubkey in the exclusions file leaves that account out", async () => {
  const { f } = fakeFetch(ENTRIES);
  const out = await run(["--rpc", "r", "--mint", MINT, "--exclusions", exFile(["vault"])], { fetch: f });
  assert.equal(out.top, 100);
  assert.deepEqual(out.holders.map((h) => h.owner), ["carol", "alice", "bob"]);
});

test("run fails clearly on missing flags, bad top, RPC errors and a bad exclusions file", async () => {
  const { f } = fakeFetch(ENTRIES);
  const ex = exFile([]);
  await assert.rejects(run(["--mint", MINT, "--exclusions", ex], { fetch: f }), /usage/);
  await assert.rejects(run(["--rpc", "r", "--exclusions", ex], { fetch: f }), /usage/);
  await assert.rejects(run(["--rpc", "r", "--mint", MINT], { fetch: f }), /usage/);
  await assert.rejects(run(["--rpc", "r", "--mint", MINT, "--exclusions", ex, "--top", "x"], { fetch: f }), /--top/);
  await assert.rejects(run(["--rpc", "r", "--mint", MINT, "--exclusions", exFile({})], { fetch: f }), /JSON array/);
  const bad: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "nope" } }) });
  await assert.rejects(run(["--rpc", "r", "--mint", MINT, "--exclusions", ex], { fetch: bad }), /RPC error: nope/);
  const http: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(run(["--rpc", "r", "--mint", MINT, "--exclusions", ex], { fetch: http }), /HTTP 429/);
});
