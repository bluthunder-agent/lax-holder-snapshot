import { createHash } from "node:crypto";

/** One token account: its address, its owner wallet, its raw balance in atomic units (base 10 integer string). */
export type TokenAccount = { pubkey: string; owner: string; amount: string };

/** rank starts at 1; amount is the BigInt sum of the owner's accounts as a base 10 integer string. */
export type Holder = { rank: number; owner: string; amount: string };

const UINT_RE = /^[0-9]+$/;

/**
 * Group token accounts by owner, leave out excluded accounts (owner or pubkey in `exclusions`)
 * and owners with a zero total, sort by amount descending then owner ascending (plain JavaScript
 * string comparison), keep the first `top` (an integer, 100 when absent).
 *
 * hash: sha256 (64 lowercase hex) of the UTF-8 text
 *   holders.map(h => `${h.rank},${h.owner},${h.amount}`).join('\n')
 * with no header and no trailing newline.
 *
 * Pure: no I/O, and the order of the accounts never changes the result.
 */
export function snapshot(input: {
  accounts: readonly TokenAccount[];
  exclusions?: readonly string[];
  top?: number;
}): { holders: Holder[]; hash: string } {
  const top = input.top ?? 100;
  if (!Number.isInteger(top) || top < 0) throw new TypeError("top must be a non negative integer");
  const excluded = new Set<string>(input.exclusions ?? []);
  const totals = new Map<string, bigint>();

  for (const acc of input.accounts) {
    if (typeof acc.pubkey !== "string" || typeof acc.owner !== "string")
      throw new TypeError("account pubkey and owner must be strings");
    if (typeof acc.amount !== "string" || !UINT_RE.test(acc.amount))
      throw new TypeError(`account ${acc.pubkey}: amount must be a base 10 integer string`);
    if (excluded.has(acc.owner) || excluded.has(acc.pubkey)) continue;
    totals.set(acc.owner, (totals.get(acc.owner) ?? 0n) + BigInt(acc.amount));
  }

  const ranked = [...totals.entries()]
    .filter(([, amount]) => amount > 0n)
    .sort(([oa, a], [ob, b]) => (a === b ? (oa < ob ? -1 : oa > ob ? 1 : 0) : a > b ? -1 : 1));
  const holders: Holder[] = ranked.slice(0, top).map(([owner, amount], i) => ({
    rank: i + 1,
    owner,
    amount: amount.toString(),
  }));
  const text = holders.map((h) => `${h.rank},${h.owner},${h.amount}`).join("\n");
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return { holders, hash };
}
