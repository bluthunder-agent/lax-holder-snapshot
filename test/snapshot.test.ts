import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { snapshot, canonicalEncoding, SnapshotError, type TokenAccount } from "../src/index.ts";
import { addr, MINT, shuffle } from "./helpers.ts";

const acc = (n: number, owner: number, amount: string | bigint): TokenAccount => ({ pubkey: addr(1000 + n), owner: addr(owner), amount, mint: MINT });

const FIXTURE: TokenAccount[] = [
  acc(1, 1, "500"),
  acc(2, 2, "300"),
  acc(3, 2, "300"), // owner 2 has two accounts: 600
  acc(4, 3, "600"), // ties owner 2 at 600
  acc(5, 4, "0"),   // zero balance dropped
  acc(6, 5, "100"),
  acc(7, 6, "1000"), // excluded owner (pool)
  acc(8, 7, "900"),  // excluded account (vault)
  acc(9, 8, "50"),
];
const EX = { owners: [addr(6)], accounts: [addr(1008)] };

describe("determinism", () => {
  test("same input gives the same hash", () => {
    const a = snapshot({ accounts: FIXTURE, exclusions: EX, mint: MINT, slot: 123 });
    const b = snapshot({ accounts: FIXTURE, exclusions: EX, mint: MINT, slot: 123 });
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a, b);
  });

  test("shuffled input order gives the same result and hash", () => {
    const ref = snapshot({ accounts: FIXTURE, exclusions: EX, mint: MINT, slot: 123 });
    for (let seed = 1; seed <= 25; seed++) {
      const r = snapshot({ accounts: shuffle(FIXTURE, seed), exclusions: { owners: shuffle(EX.owners, seed), accounts: EX.accounts }, mint: MINT, slot: 123 });
      assert.deepEqual(r, ref, `seed ${seed}`);
    }
  });

  test("golden hash is pinned (catches any change to canonical encoding)", () => {
    const r = snapshot({ accounts: FIXTURE, exclusions: EX, mint: MINT, slot: 123, top: 100 });
    const expected = createHash("sha256")
      .update(
        `lax-holder-snapshot/v1 mint=${MINT} slot=123 top=100\n` +
          r.holders.map((h) => `${h.rank},${h.owner},${h.amount}`).join("\n") + "\n",
      )
      .digest("hex");
    assert.equal(r.hash, expected);
    assert.match(r.hash, /^[0-9a-f]{64}$/);
  });

  test("hash changes when any holder amount changes by one unit", () => {
    const a = snapshot({ accounts: FIXTURE, exclusions: EX });
    const b = snapshot({ accounts: FIXTURE.map((x) => (x.pubkey === addr(1009) ? { ...x, amount: "51" } : x)), exclusions: EX });
    assert.notEqual(a.hash, b.hash);
  });

  test("hash binds slot, mint and top", () => {
    const h = (o: object) => snapshot({ accounts: FIXTURE, exclusions: EX, ...o }).hash;
    const base = h({ slot: 1, mint: MINT, top: 100 });
    assert.notEqual(base, h({ slot: 2, mint: MINT, top: 100 }));
    assert.notEqual(base, h({ slot: 1, top: 100 }));
    assert.notEqual(base, h({ slot: 1, mint: MINT, top: 99 }));
  });
});

describe("ranking", () => {
  test("multi account owners sum, ties broken by owner address ascending", () => {
    const r = snapshot({ accounts: FIXTURE, exclusions: EX });
    const tied = [addr(2), addr(3)].sort();
    assert.deepEqual(
      r.holders.map((h) => [h.rank, h.owner, h.amount, h.accounts]),
      [
        [1, tied[0], "600", tied[0] === addr(2) ? 2 : 1],
        [2, tied[1], "600", tied[1] === addr(2) ? 2 : 1],
        [3, addr(1), "500", 1],
        [4, addr(5), "100", 1],
        [5, addr(8), "50", 1],
      ],
    );
    assert.equal(r.totalHolders, 5);
  });

  test("tie break uses byte order, not locale order", () => {
    // 'Z' (0x5a) < 'a' (0x61) in byte order; localeCompare would put 'a' first.
    const lo = "Z".repeat(32), hi = "a".repeat(32);
    const r = snapshot({ accounts: [{ pubkey: addr(1), owner: hi, amount: "5" }, { pubkey: addr(2), owner: lo, amount: "5" }] });
    assert.deepEqual(r.holders.map((h) => h.owner), [lo, hi]);
  });

  test("amounts compare as integers, not strings", () => {
    const r = snapshot({ accounts: [acc(1, 1, "9"), acc(2, 2, "10")] });
    assert.deepEqual(r.holders.map((h) => h.owner), [addr(2), addr(1)]);
  });

  test("bigint amounts above 2^53 sum exactly", () => {
    const big = (1n << 60n) + 1n;
    const r = snapshot({ accounts: [acc(1, 1, big), acc(2, 1, big.toString()), acc(3, 2, "9007199254740993")] });
    assert.equal(r.holders[0]!.amount, (2n * big).toString());
    assert.equal(r.holders[1]!.amount, "9007199254740993");
  });

  test("top N cut keeps exactly N and the right ones", () => {
    const many = Array.from({ length: 150 }, (_, i) => acc(i, i + 1, String(1000 - i)));
    const r = snapshot({ accounts: many });
    assert.equal(r.holders.length, 100);
    assert.equal(r.holders[99]!.amount, "901");
    assert.equal(r.totalHolders, 150);
    assert.equal(snapshot({ accounts: many, top: 3 }).holders.length, 3);
    assert.deepEqual(r.holders.map((h) => h.rank), Array.from({ length: 100 }, (_, i) => i + 1));
  });

  test("fewer holders than top returns them all", () => {
    assert.equal(snapshot({ accounts: FIXTURE, top: 100 }).holders.length, 7);
  });
});

describe("exclusions and filtering", () => {
  test("excluded owner is dropped across all its accounts", () => {
    const r = snapshot({ accounts: [...FIXTURE, acc(20, 6, "5")], exclusions: EX });
    assert.ok(!r.holders.some((h) => h.owner === addr(6)));
  });
  test("excluded token account is dropped but its owner's other accounts count", () => {
    const r = snapshot({ accounts: [...FIXTURE, acc(21, 7, "40")], exclusions: EX });
    assert.equal(r.holders.find((h) => h.owner === addr(7))?.amount, "40");
  });
  test("zero balances and fully excluded owners are not counted as holders", () => {
    const r = snapshot({ accounts: FIXTURE, exclusions: EX });
    assert.ok(!r.holders.some((h) => h.owner === addr(4)));
    assert.equal(r.totalHolders, 5);
  });
  test("no exclusions keeps excluded candidates", () => {
    const r = snapshot({ accounts: FIXTURE });
    assert.equal(r.holders[0]!.owner, addr(6));
    assert.equal(r.holders[1]!.owner, addr(7));
  });
});

describe("input validation", () => {
  const bad: [string, () => unknown][] = [
    ["duplicate account", () => snapshot({ accounts: [acc(1, 1, "1"), acc(1, 2, "1")] })],
    ["negative amount string", () => snapshot({ accounts: [acc(1, 1, "-1")] })],
    ["negative bigint", () => snapshot({ accounts: [acc(1, 1, -1n)] })],
    ["decimal amount", () => snapshot({ accounts: [acc(1, 1, "1.5")] })],
    ["leading zero amount", () => snapshot({ accounts: [acc(1, 1, "01")] })],
    ["above u64", () => snapshot({ accounts: [acc(1, 1, (1n << 64n).toString())] })],
    ["number amount", () => snapshot({ accounts: [{ ...acc(1, 1, "1"), amount: 5 as unknown as string }] })],
    ["mint mismatch", () => snapshot({ accounts: [{ ...acc(1, 1, "1"), mint: addr(5) }], mint: MINT })],
    ["bad owner", () => snapshot({ accounts: [{ ...acc(1, 1, "1"), owner: "0OIl" }] })],
    ["top zero", () => snapshot({ accounts: [], top: 0 })],
    ["top fractional", () => snapshot({ accounts: [], top: 1.5 })],
    ["negative slot", () => snapshot({ accounts: [], slot: -1 })],
  ];
  for (const [name, fn] of bad) test(`rejects ${name}`, () => assert.throws(fn, SnapshotError));

  test("u64 max is accepted", () => {
    const max = ((1n << 64n) - 1n).toString();
    assert.equal(snapshot({ accounts: [acc(1, 1, max)] }).holders[0]!.amount, max);
  });
  test("empty input gives an empty, still hashed snapshot", () => {
    const r = snapshot({ accounts: [] });
    assert.deepEqual(r.holders, []);
    assert.equal(r.hash, createHash("sha256").update(canonicalEncoding([], { top: 100 })).digest("hex"));
  });
});
