import { readFileSync } from "node:fs";
import { SnapshotError, type Exclusions } from "./snapshot.ts";

/** Categories an exclusions file may contain. Every category is optional. */
export const EXCLUSION_CATEGORIES = ["curve", "pools", "burn", "project_wallets"] as const;
export type ExclusionCategory = (typeof EXCLUSION_CATEGORIES)[number];

/**
 * One entry: a bare base58 string is a wallet owner (all its token accounts are dropped);
 * an object names exactly one of owner or account (a single token account, e.g. a pool vault),
 * with an optional human readable label.
 */
export type ExclusionEntry = string | { owner: string; label?: string } | { account: string; label?: string };

export type ExclusionsFile = { version?: 1 } & Partial<Record<ExclusionCategory, ExclusionEntry[]>>;

export interface ParsedExclusions extends Exclusions {
  owners: string[];
  accounts: string[];
  /** Which category each excluded address came from, for audit output. */
  byCategory: Record<ExclusionCategory, { owners: string[]; accounts: string[] }>;
}

const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function addr(v: unknown, where: string): string {
  if (typeof v !== "string" || !B58_RE.test(v)) throw new SnapshotError(`${where}: not a base58 address`);
  return v;
}

/** Validate an exclusions object (already JSON parsed). Unknown keys and bad addresses throw SnapshotError. */
export function parseExclusions(data: unknown): ParsedExclusions {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new SnapshotError("exclusions file must be a JSON object");
  const obj = data as Record<string, unknown>;
  for (const k of Object.keys(obj))
    if (k !== "version" && !(EXCLUSION_CATEGORIES as readonly string[]).includes(k))
      throw new SnapshotError(`exclusions file: unknown key "${k}" (allowed: version, ${EXCLUSION_CATEGORIES.join(", ")})`);
  if (obj.version !== undefined && obj.version !== 1) throw new SnapshotError("exclusions file: version must be 1");

  const owners = new Set<string>();
  const accounts = new Set<string>();
  const byCategory = {} as ParsedExclusions["byCategory"];
  for (const cat of EXCLUSION_CATEGORIES) {
    const bucket = { owners: [] as string[], accounts: [] as string[] };
    byCategory[cat] = bucket;
    const list = obj[cat];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new SnapshotError(`exclusions file: ${cat} must be an array`);
    list.forEach((e, i) => {
      const where = `exclusions file: ${cat}[${i}]`;
      if (typeof e === "string") {
        bucket.owners.push(addr(e, where));
        return;
      }
      if (e === null || typeof e !== "object" || Array.isArray(e)) throw new SnapshotError(`${where}: must be an address string or object`);
      const o = e as Record<string, unknown>;
      for (const k of Object.keys(o))
        if (k !== "owner" && k !== "account" && k !== "label") throw new SnapshotError(`${where}: unknown key "${k}"`);
      if ((o.owner === undefined) === (o.account === undefined)) throw new SnapshotError(`${where}: give exactly one of owner or account`);
      if (o.label !== undefined && typeof o.label !== "string") throw new SnapshotError(`${where}: label must be a string`);
      if (o.owner !== undefined) bucket.owners.push(addr(o.owner, where));
      else bucket.accounts.push(addr(o.account, where));
    });
    bucket.owners.forEach((a) => owners.add(a));
    bucket.accounts.forEach((a) => accounts.add(a));
  }
  return { owners: [...owners].sort(), accounts: [...accounts].sort(), byCategory };
}

/** Read and validate an exclusions JSON file. */
export function loadExclusionsFile(path: string): ParsedExclusions {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new SnapshotError(`cannot read exclusions file ${path}: ${e instanceof Error ? e.message : e}`);
  }
  return parseExclusions(data);
}

/** Union of several exclusion sets (file plus CLI flags), sorted and de-duplicated. */
export function mergeExclusions(...sets: Exclusions[]): { owners: string[]; accounts: string[] } {
  const owners = new Set<string>(), accounts = new Set<string>();
  for (const s of sets) {
    for (const o of s.owners ?? []) owners.add(o);
    for (const a of s.accounts ?? []) accounts.add(a);
  }
  return { owners: [...owners].sort(), accounts: [...accounts].sort() };
}
