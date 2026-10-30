import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { snapshot, type TokenAccount } from "../src/snapshot.ts";

const acc = (pubkey: string, owner: string, amount: string): TokenAccount => ({ pubkey, owner, amount });
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const FIXTURE = [
  acc("t1", "alice", "100"),
  acc("t2", "bob", "100"),
  acc("t3", "carol", "300"),
  acc("t4", "alice", "0"),
];

// ---- output shape and hash format -------------------------------------------------------------

test("known vector: hash is sha256 of rank,owner,amount lines joined by \\n, no header, no trailing newline", () => {
  const r = snapshot({ accounts: FIXTURE, exclusions: [] });
  assert.deepEqual(r.holders, [
    { rank: 1, owner: "carol", amount: "300" },
    { rank: 2, owner: "alice", amount: "100" },
    { rank: 3, owner: "bob", amount: "100" },
  ]);
  // value computed independently with: printf '1,carol,300\n2,alice,100\n3,bob,100' | sha256sum
  assert.equal(r.hash, "61fe03960e256c24b056d7ef88b0374ed83fe0b57dde86258096b3e483a20e84");
  assert.equal(r.hash, sha(r.holders.map((h) => `${h.rank},${h.owner},${h.amount}`).join("\n")));
  assert.notEqual(r.hash, sha(r.holders.map((h) => `${h.rank},${h.owner},${h.amount}`).join("\n") + "\n"));
  assert.match(r.hash, /^[0-9a-f]{64}$/);
});

test("result is exactly {holders, hash} and each holder is exactly {rank, owner, amount}", () => {
  const r = snapshot({ accounts: FIXTURE, exclusions: [] });
  assert.deepEqual(Object.keys(r).sort(), ["hash", "holders"]);
  for (const h of r.holders) {
    assert.deepEqual(Object.keys(h).sort(), ["amount", "owner", "rank"]);
    assert.equal(typeof h.rank, "number");
    assert.equal(typeof h.amount, "string");
  }
});

test("empty input gives an empty list and the sha256 of the empty text", () => {
  const r = snapshot({ accounts: [], exclusions: [] });
  assert.deepEqual(r.holders, []);
  assert.equal(r.hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("exclusions may be absent", () => {
  assert.equal(snapshot({ accounts: FIXTURE }).hash, snapshot({ accounts: FIXTURE, exclusions: [] }).hash);
});

// ---- acceptance: the same input gives the same hash -------------------------------------------

test("acceptance: same input gives the same hash, whatever the order of the accounts", () => {
  const accounts = Array.from({ length: 60 }, (_, i) => acc(`pk${i}`, `owner${i % 17}`, String((i * 7919) % 1000)));
  const base = snapshot({ accounts, exclusions: ["owner3", "pk5"], top: 10 });
  for (let seed = 1; seed <= 25; seed++) {
    assert.deepEqual(snapshot({ accounts: shuffle(accounts, seed), exclusions: ["owner3", "pk5"], top: 10 }), base);
  }
  assert.deepEqual(snapshot({ accounts, exclusions: ["owner3", "pk5"], top: 10 }), base);
});

test("order of the exclusions never changes the result", () => {
  const ex = ["alice", "t3", "nobody"];
  assert.deepEqual(snapshot({ accounts: FIXTURE, exclusions: ex }), snapshot({ accounts: FIXTURE, exclusions: [...ex].reverse() }));
});

test("snapshot does not mutate its input", () => {
  const accounts = FIXTURE.map((a) => ({ ...a }));
  const exclusions = ["bob"];
  const copyA = JSON.stringify(accounts), copyE = JSON.stringify(exclusions);
  snapshot({ accounts, exclusions });
  assert.equal(JSON.stringify(accounts), copyA);
  assert.equal(JSON.stringify(exclusions), copyE);
});

// ---- acceptance: exclusions applied -----------------------------------------------------------

test("acceptance: an account is left out when its owner is in exclusions", () => {
  const r = snapshot({ accounts: FIXTURE, exclusions: ["carol"] });
  assert.deepEqual(r.holders.map((h) => h.owner), ["alice", "bob"]);
});

test("acceptance: an account is left out when its pubkey is in exclusions (the owner's other accounts still count)", () => {
  const accounts = [acc("vault", "pool", "900"), acc("other", "pool", "50"), acc("t1", "alice", "100")];
  const r = snapshot({ accounts, exclusions: ["vault"] });
  assert.deepEqual(r.holders, [
    { rank: 1, owner: "alice", amount: "100" },
    { rank: 2, owner: "pool", amount: "50" },
  ]);
});

test("excluding an owner removes all of its accounts, and ranks are re-numbered from 1", () => {
  const accounts = [acc("a", "whale", "1000"), acc("b", "whale", "1000"), acc("c", "mid", "10"), acc("d", "small", "5")];
  const r = snapshot({ accounts, exclusions: ["whale"] });
  assert.deepEqual(r.holders, [
    { rank: 1, owner: "mid", amount: "10" },
    { rank: 2, owner: "small", amount: "5" },
  ]);
});

test("an exclusion that matches nothing changes nothing", () => {
  assert.deepEqual(snapshot({ accounts: FIXTURE, exclusions: ["zzz"] }), snapshot({ accounts: FIXTURE, exclusions: [] }));
});

test("exclusion matching is exact and case sensitive", () => {
  const r = snapshot({ accounts: [acc("t1", "Alice", "5")], exclusions: ["alice", "T1"] });
  assert.equal(r.holders.length, 1);
});

// ---- acceptance: ties broken deterministically ------------------------------------------------

test("acceptance: equal amounts are ordered by owner ascending (plain JavaScript string comparison)", () => {
  const r = snapshot({ accounts: [acc("1", "b", "5"), acc("2", "a", "5"), acc("3", "c", "5")], exclusions: [] });
  assert.deepEqual(r.holders.map((h) => `${h.rank}${h.owner}`), ["1a", "2b", "3c"]);
});

test("tie break is a code unit comparison, not locale order: uppercase sorts before lowercase", () => {
  const r = snapshot({ accounts: [acc("1", "a", "5"), acc("2", "B", "5"), acc("3", "Z", "5")], exclusions: [] });
  assert.deepEqual(r.holders.map((h) => h.owner), ["B", "Z", "a"]);
});

test("ties are decided on the owner's summed total, not on single accounts", () => {
  const accounts = [acc("1", "x", "3"), acc("2", "x", "3"), acc("3", "y", "6"), acc("4", "w", "5")];
  const r = snapshot({ accounts, exclusions: [] });
  assert.deepEqual(r.holders.map((h) => h.owner), ["x", "y", "w"]);
});

test("ties at the top cut are resolved the same way for every input order", () => {
  const accounts = ["e", "d", "c", "b", "a"].map((o, i) => acc(`p${i}`, o, "7"));
  for (let seed = 1; seed <= 10; seed++) {
    assert.deepEqual(snapshot({ accounts: shuffle(accounts, seed), exclusions: [], top: 2 }).holders.map((h) => h.owner), ["a", "b"]);
  }
});

// ---- grouping, zero balances, big numbers -----------------------------------------------------

test("sums the accounts of an owner with BigInt and keeps amounts as base 10 strings above 2^53", () => {
  const big = "18446744073709551615"; // u64 max
  const r = snapshot({ accounts: [acc("1", "w", big), acc("2", "w", big), acc("3", "v", "9007199254740993")], exclusions: [] });
  assert.deepEqual(r.holders, [
    { rank: 1, owner: "w", amount: "36893488147419103230" },
    { rank: 2, owner: "v", amount: "9007199254740993" },
  ]);
});

test("owners with a zero total are left out", () => {
  const r = snapshot({ accounts: [acc("1", "z", "0"), acc("2", "z", "000"), acc("3", "a", "1")], exclusions: [] });
  assert.deepEqual(r.holders, [{ rank: 1, owner: "a", amount: "1" }]);
});

test("leading zeros in an input amount are normalised in the output", () => {
  assert.deepEqual(snapshot({ accounts: [acc("1", "a", "0007")], exclusions: [] }).holders, [{ rank: 1, owner: "a", amount: "7" }]);
});

// ---- top --------------------------------------------------------------------------------------

test("top keeps the first N, default 100 when absent", () => {
  const accounts = Array.from({ length: 150 }, (_, i) => acc(`p${i}`, `o${String(i).padStart(3, "0")}`, String(1000 - i)));
  assert.equal(snapshot({ accounts, exclusions: [] }).holders.length, 100);
  assert.equal(snapshot({ accounts, exclusions: [], top: undefined }).holders.length, 100);
  const t3 = snapshot({ accounts, exclusions: [], top: 3 });
  assert.deepEqual(t3.holders.map((h) => h.rank), [1, 2, 3]);
  assert.equal(snapshot({ accounts, exclusions: [], top: 1000 }).holders.length, 150);
});

test("a smaller top is a prefix of a larger one and the hash covers only the kept holders", () => {
  const accounts = Array.from({ length: 20 }, (_, i) => acc(`p${i}`, `o${i}`, String(i + 1)));
  const a = snapshot({ accounts, exclusions: [], top: 5 });
  const b = snapshot({ accounts, exclusions: [], top: 6 });
  assert.deepEqual(b.holders.slice(0, 5), a.holders);
  assert.notEqual(a.hash, b.hash);
});

// ---- validation is relaxed for short fixture names, but still rejects bad amounts -------------

test("short fixture names are accepted for pubkey and owner", () => {
  const r = snapshot({ accounts: [acc("a", "x", "1"), acc("b", "y", "2")], exclusions: ["x"] });
  assert.deepEqual(r.holders, [{ rank: 1, owner: "y", amount: "2" }]);
});

test("amount must be a base 10 integer string", () => {
  for (const bad of ["-1", "1.5", "0x10", "", " 1", "1e3", "abc"])
    assert.throws(() => snapshot({ accounts: [acc("p", "o", bad)], exclusions: [] }), TypeError, bad);
  assert.throws(() => snapshot({ accounts: [{ pubkey: "p", owner: "o", amount: 5 as unknown as string }], exclusions: [] }), TypeError);
});

test("top must be an integer", () => {
  for (const bad of [1.5, -1, Number.NaN, Infinity])
    assert.throws(() => snapshot({ accounts: FIXTURE, exclusions: [], top: bad }), TypeError, String(bad));
  assert.deepEqual(snapshot({ accounts: FIXTURE, exclusions: [], top: 0 }).holders, []);
});
