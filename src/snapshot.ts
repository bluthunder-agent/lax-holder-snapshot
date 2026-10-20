import { createHash } from "node:crypto";

/** One token account. amount is raw base units (no decimals) as a decimal string or bigint. */
export interface TokenAccount {
  pubkey: string;
  owner: string;
  amount: string | bigint;
  mint?: string;
}

export interface Exclusions {
  /** Wallet owners to drop entirely (bonding curve, pools, burn, project wallets). */
  owners?: Iterable<string>;
  /** Individual token accounts to drop (for example a pool vault). */
  accounts?: Iterable<string>;
}

export interface SnapshotInput {
  accounts: readonly TokenAccount[];
  exclusions?: Exclusions;
  /** Number of holders to keep. Default 100. */
  top?: number;
  /** Optional metadata bound into the hash. If mint is set, every account with a mint must match. */
  mint?: string;
  slot?: number;
}

export interface Holder {
  rank: number;
  owner: string;
  /** Raw base units as a decimal string (safe above 2^53). */
  amount: string;
  /** Number of token accounts summed into this holder. */
  accounts: number;
}

export interface SnapshotResult {
  holders: Holder[];
  /** sha256 hex of the canonical encoding (see canonicalEncoding). */
  hash: string;
  /** Holders with a non zero balance after exclusions, before the top cut. */
  totalHolders: number;
}

export const FORMAT = "lax-holder-snapshot/v1";
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;

export class SnapshotError extends Error {}

function parseAmount(a: string | bigint, pubkey: string): bigint {
  let v: bigint;
  if (typeof a === "bigint") v = a;
  else if (typeof a === "string" && UINT_RE.test(a)) v = BigInt(a);
  else throw new SnapshotError(`account ${pubkey}: amount must be a non negative integer string or bigint`);
  if (v < 0n || v > U64_MAX) throw new SnapshotError(`account ${pubkey}: amount out of u64 range`);
  return v;
}

/** Byte order comparison of ASCII strings, independent of locale. */
export function cmpAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalEncoding(holders: readonly Holder[], meta: { mint?: string; slot?: number; top: number }): string {
  const header = `${FORMAT} mint=${meta.mint ?? "-"} slot=${meta.slot ?? "-"} top=${meta.top}`;
  return [header, ...holders.map((h) => `${h.rank},${h.owner},${h.amount}`)].join("\n") + "\n";
}

/**
 * Group token accounts by owner, apply exclusions, drop zero balances, rank by amount
 * descending with owner address ascending as tie break, keep the top N and hash.
 * Pure and deterministic: input order never changes the result.
 */
export function snapshot(input: SnapshotInput): SnapshotResult {
  const top = input.top ?? 100;
  if (!Number.isInteger(top) || top < 1) throw new SnapshotError("top must be a positive integer");
  if (input.slot !== undefined && (!Number.isSafeInteger(input.slot) || input.slot < 0))
    throw new SnapshotError("slot must be a non negative integer");
  if (input.mint !== undefined && !B58_RE.test(input.mint)) throw new SnapshotError("mint is not a base58 address");

  const exOwners = new Set(input.exclusions?.owners ?? []);
  const exAccounts = new Set(input.exclusions?.accounts ?? []);
  const seen = new Set<string>();
  const totals = new Map<string, { amount: bigint; accounts: number }>();

  for (const acc of input.accounts) {
    if (!B58_RE.test(acc.pubkey)) throw new SnapshotError(`bad account pubkey ${acc.pubkey}`);
    if (!B58_RE.test(acc.owner)) throw new SnapshotError(`account ${acc.pubkey}: bad owner ${acc.owner}`);
    if (seen.has(acc.pubkey)) throw new SnapshotError(`duplicate token account ${acc.pubkey}`);
    seen.add(acc.pubkey);
    if (input.mint !== undefined && acc.mint !== undefined && acc.mint !== input.mint)
      throw new SnapshotError(`account ${acc.pubkey}: mint ${acc.mint} does not match ${input.mint}`);
    const amount = parseAmount(acc.amount, acc.pubkey);
    if (exOwners.has(acc.owner) || exAccounts.has(acc.pubkey)) continue;
    if (amount === 0n) continue;
    const t = totals.get(acc.owner);
    if (t) {
      t.amount += amount;
      t.accounts += 1;
    } else totals.set(acc.owner, { amount, accounts: 1 });
  }

  const ranked = [...totals.entries()].sort(([oa, a], [ob, b]) =>
    a.amount === b.amount ? cmpAscii(oa, ob) : a.amount > b.amount ? -1 : 1,
  );
  const holders: Holder[] = ranked.slice(0, top).map(([owner, t], i) => ({
    rank: i + 1,
    owner,
    amount: t.amount.toString(),
    accounts: t.accounts,
  }));
  const hash = createHash("sha256")
    .update(canonicalEncoding(holders, { mint: input.mint, slot: input.slot, top }), "utf8")
    .digest("hex");
  return { holders, hash, totalHolders: ranked.length };
}
