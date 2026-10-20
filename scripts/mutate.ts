// Mutation check: apply each planted bug in turn and require the test suite to FAIL.
// A mutant that survives means a rule is not covered by a test. Exit code 1 if any survive.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const TESTS = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
import { MUTANTS } from "./mutants.ts";

let survived = 0;
for (const m of MUTANTS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.error(`MISSING  ${m.name}: pattern not found in ${m.file}`);
    survived++;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", "--test", ...TESTS], { encoding: "utf8" });
    if (r.status === 0) {
      console.error(`SURVIVED ${m.name}`);
      survived++;
    } else {
      console.log(`killed   ${m.name}`);
    }
  } finally {
    writeFileSync(m.file, original);
  }
}
console.log(`${MUTANTS.length - survived}/${MUTANTS.length} mutants killed`);
process.exit(survived ? 1 : 0);
