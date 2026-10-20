import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { snapshot, parseExclusions, loadExclusionsFile, mergeExclusions, SnapshotError, type TokenAccount } from "../src/index.ts";
import { addr, MINT } from "./helpers.ts";

const acc = (n: number, owner: number, amount: string): TokenAccount => ({ pubkey: addr(1000 + n), owner: addr(owner), amount, mint: MINT });
const ACCOUNTS = [
  acc(1, 1, "500"),
  acc(2, 2, "9000"), // bonding curve owner
  acc(3, 3, "8000"), // pool vault token account (owner 3 also holds acc 4)
  acc(4, 3, "10"),
  acc(5, 4, "7000"), // burn
  acc(6, 5, "6000"), // project treasury
  acc(7, 6, "400"),
];
const FILE = {
  version: 1,
  curve: [addr(2)],
  pools: [{ account: addr(1003), label: "AMM vault" }],
  burn: [{ owner: addr(4) }],
  project_wallets: [{ owner: addr(5), label: "treasury" }],
};

describe("exclusions file", () => {
  test("parses all four categories into owners and accounts", () => {
    const p = parseExclusions(FILE);
    assert.deepEqual(p.owners, [addr(2), addr(4), addr(5)].sort());
    assert.deepEqual(p.accounts, [addr(1003)]);
    assert.deepEqual(p.byCategory.curve, { owners: [addr(2)], accounts: [] });
    assert.deepEqual(p.byCategory.pools, { owners: [], accounts: [addr(1003)] });
    assert.deepEqual(p.byCategory.burn, { owners: [addr(4)], accounts: [] });
    assert.deepEqual(p.byCategory.project_wallets, { owners: [addr(5)], accounts: [] });
  });

  test("each category actually removes its holders from the snapshot", () => {
    const r = snapshot({ accounts: ACCOUNTS, exclusions: parseExclusions(FILE), mint: MINT });
    assert.deepEqual(r.holders.map((h) => [h.owner, h.amount]), [[addr(1), "500"], [addr(6), "400"], [addr(3), "10"]]);
    for (const cat of ["curve", "pools", "burn", "project_wallets"] as const) {
      const only = parseExclusions({ [cat]: (FILE as any)[cat] });
      const all = snapshot({ accounts: ACCOUNTS }).holders.length;
      const res = snapshot({ accounts: ACCOUNTS, exclusions: only });
      if (cat === "pools") assert.equal(res.holders.find((h) => h.owner === addr(3))?.amount, "10", cat);
      else assert.equal(res.holders.length, all - 1, cat);
    }
  });

  test("empty file and empty categories exclude nothing", () => {
    const ref = snapshot({ accounts: ACCOUNTS }).hash;
    assert.equal(snapshot({ accounts: ACCOUNTS, exclusions: parseExclusions({}) }).hash, ref);
    assert.equal(snapshot({ accounts: ACCOUNTS, exclusions: parseExclusions({ curve: [], pools: [], burn: [], project_wallets: [] }) }).hash, ref);
  });

  test("entry order and duplicates do not change the result", () => {
    const a = parseExclusions(FILE);
    const b = parseExclusions({ ...FILE, curve: [addr(2), addr(2)], burn: [addr(4)], project_wallets: [addr(5), addr(4)] });
    assert.deepEqual(a.owners, b.owners);
  });

  test("rejects bad files", () => {
    const bad: unknown[] = [
      null, [], "x", { version: 2 }, { lp: [] }, { curve: addr(2) }, { curve: ["notbase58!"] },
      { pools: [{}] }, { pools: [{ owner: addr(1), account: addr(2) }] }, { pools: [{ account: addr(1), memo: "x" }] },
      { burn: [{ owner: addr(1), label: 5 }] }, { burn: [7] },
    ];
    for (const b of bad) assert.throws(() => parseExclusions(b), SnapshotError, JSON.stringify(b));
  });

  test("loads from disk; unreadable or invalid JSON throws SnapshotError", () => {
    const dir = mkdtempSync(join(tmpdir(), "excl-"));
    writeFileSync(join(dir, "ok.json"), JSON.stringify(FILE));
    writeFileSync(join(dir, "bad.json"), "{nope");
    assert.deepEqual(loadExclusionsFile(join(dir, "ok.json")).owners, parseExclusions(FILE).owners);
    assert.throws(() => loadExclusionsFile(join(dir, "bad.json")), SnapshotError);
    assert.throws(() => loadExclusionsFile(join(dir, "missing.json")), SnapshotError);
  });

  test("shipped example file is valid", () => {
    const p = loadExclusionsFile("exclusions.example.json");
    assert.deepEqual(p.byCategory.burn.owners, ["1nc1nerator11111111111111111111111111111111"]);
  });

  test("merge unions file and flag exclusions", () => {
    assert.deepEqual(mergeExclusions({ owners: [addr(2)] }, { owners: [addr(1), addr(2)], accounts: [addr(9)] }), {
      owners: [addr(1), addr(2)].sort(),
      accounts: [addr(9)],
    });
  });

  test("CLI --exclusions applies the file offline and records it in snapshot.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "excl-cli-"));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ mint: MINT, slot: 77, accounts: ACCOUNTS }));
    writeFileSync(join(dir, "ex.json"), JSON.stringify(FILE));
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--fixture", join(dir, "fixture.json"), "--exclusions", join(dir, "ex.json"), "--exclude-owner", addr(6), "--out", join(dir, "out")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(readFileSync(join(dir, "out", "snapshot.json"), "utf8"));
    assert.deepEqual(out.holders.map((h: { owner: string }) => h.owner), [addr(1), addr(3)]);
    assert.deepEqual(out.exclusions.accounts, [addr(1003)]);
    assert.equal(out.hash, snapshot({ accounts: ACCOUNTS, exclusions: mergeExclusions(parseExclusions(FILE), { owners: [addr(6)] }), mint: MINT, slot: 77 }).hash);
  });
});
