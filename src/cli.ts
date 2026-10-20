#!/usr/bin/env -S node --import tsx
// Usage:
//   holder-snapshot --mint <MINT> [--rpc URL] [--program token|token2022] [--min-slot N]
//                   [--top 100] [--exclusions exclusions.json] [--exclude-owner A,B] [--exclude-account X,Y] [--out DIR]
//   holder-snapshot --fixture accounts.json [...same flags]   (offline, re-hash a saved fixture)
// Writes <out>/fixture.json (raw accounts + slot) and <out>/snapshot.json (holders + hash).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { snapshot } from "./snapshot.ts";
import { loadExclusionsFile, mergeExclusions } from "./exclusions.ts";
import { fetchMintAccounts, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type FetchResult } from "./rpc.ts";

const { values } = parseArgs({
  options: {
    mint: { type: "string" },
    rpc: { type: "string", default: "https://api.mainnet-beta.solana.com" },
    program: { type: "string", default: "token2022" },
    "min-slot": { type: "string" },
    top: { type: "string", default: "100" },
    "exclude-owner": { type: "string", default: "" },
    "exclude-account": { type: "string", default: "" },
    exclusions: { type: "string" },
    fixture: { type: "string" },
    out: { type: "string", default: "out" },
  },
});

const list = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

async function main() {
  let data: FetchResult & { mint: string };
  if (values.fixture) {
    data = JSON.parse(readFileSync(values.fixture, "utf8"));
  } else {
    if (!values.mint) throw new Error("--mint or --fixture is required");
    const programId = values.program === "token" ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
    const r = await fetchMintAccounts({
      rpcUrl: values.rpc!,
      mint: values.mint,
      programId,
      minContextSlot: values["min-slot"] ? Number(values["min-slot"]) : undefined,
    });
    data = { mint: values.mint, ...r };
  }
  const exclusions = mergeExclusions(
    values.exclusions ? loadExclusionsFile(values.exclusions) : {},
    { owners: list(values["exclude-owner"]), accounts: list(values["exclude-account"]) },
  );
  const result = snapshot({
    accounts: data.accounts,
    mint: data.mint,
    slot: data.slot,
    top: Number(values.top),
    exclusions,
  });
  mkdirSync(values.out!, { recursive: true });
  if (!values.fixture) writeFileSync(join(values.out!, "fixture.json"), JSON.stringify(data, null, 2) + "\n");
  writeFileSync(join(values.out!, "snapshot.json"), JSON.stringify({ mint: data.mint, slot: data.slot, exclusions, ...result }, null, 2) + "\n");
  console.log(`slot ${data.slot}  accounts ${data.accounts.length}  holders ${result.totalHolders}  hash ${result.hash}`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
