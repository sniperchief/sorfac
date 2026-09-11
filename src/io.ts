// Guarded loading of persisted phase outputs, and exit-code discipline.
//
// Audit fix. The research phases each read the previous phase's JSON with a bare
// readFileSync, so running a command out of order produced a raw Node ENOENT
// stack trace instead of saying which step had not been run yet. This module
// changes no methodology: it only turns an unhelpful crash into an actionable
// message, and makes a failed consistency check set a non-zero exit code.

import { existsSync, readFileSync } from "node:fs";

/** Which command produces each persisted artifact. */
const PRODUCED_BY: Record<string, string> = {
  "markets-": "npm run inventory",
  "t1m-": "npm run extract",
  "stats-": "npm run inventory && npx tsx src/05-stats.ts",
  "market-quality-": "npm run analyze-quality",
  "comparison-": "npm run compare",
  "freshness-validation-": "npm run validate-freshness",
  "anomaly-analysis-": "npm run analyze-anomaly",
  "prospective-": "npm run test-correction",
};

const producerFor = (path: string) => {
  const base = path.split(/[\\/]/).pop() ?? path;
  for (const [prefix, cmd] of Object.entries(PRODUCED_BY)) if (base.startsWith(prefix)) return cmd;
  return null;
};

/**
 * Read a required phase artifact, failing with an actionable message rather than
 * an ENOENT stack trace. Never fabricates data and never returns a default: a
 * missing prerequisite is fatal by design.
 */
export function loadRequired<T>(path: string, describedAs: string): T {
  if (!existsSync(path)) {
    const cmd = producerFor(path);
    console.error(`\nERROR: required input is missing.`);
    console.error(`  file:     ${path}`);
    console.error(`  contains: ${describedAs}`);
    console.error(`  produce it with: ${cmd ?? "the phase that generates it"}`);
    console.error(`\nThe pipeline runs in order:`);
    console.error(`  1. npm run inventory          pull the market registry from mainnet`);
    console.error(`  2. npm run extract            build T-1m observations`);
    console.error(`  3. npm run compare            Phase 2 calibration comparison`);
    console.error(`  4. npm run analyze-quality    Phase 3 market-quality analysis`);
    console.error(`  5. npm run validate-freshness Phase 4 out-of-sample validation`);
    console.error(`  6. npm run analyze-anomaly    Phase 5 anomaly investigation`);
    console.error(`  7. npm run test-correction    Phase 6 prospective correction test\n`);
    process.exit(1);
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`\nERROR: could not read ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    console.error(`\nERROR: ${path} is not valid JSON (truncated or partially written?).`);
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  regenerate it with: ${producerFor(path) ?? "the phase that generates it"}\n`);
    process.exit(1);
  }
}

/**
 * Parse an optional positive-integer CLI limit.
 *
 * Without this, a typo such as `npm run extract -- abc` became `Number("abc")`
 * = NaN, and `array.slice(0, NaN)` is an EMPTY array — so the run silently
 * overwrote the extraction output with zero rows and broke every later phase.
 */
export function parseLimitArg(arg: string | undefined, label = "limit"): number | undefined {
  if (arg === undefined) return undefined;
  const n = Number(arg);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`\nERROR: ${label} must be a positive integer, got ${JSON.stringify(arg)}.`);
    console.error(`  omit it to process the whole population, or pass e.g. 200 for a smoke run.\n`);
    process.exit(1);
  }
  return n;
}

/**
 * Mark the process as failed when an internal consistency check did not pass, so
 * a wrong result cannot scroll past unnoticed and still exit 0. The report is
 * still written: a reader needs to see WHICH check failed.
 */
export function failIfChecksFailed(checks: { name: string; ok: boolean }[]): void {
  const failed = checks.filter((c) => !c.ok);
  if (!failed.length) return;
  console.error(`\nERROR: ${failed.length} internal consistency check(s) FAILED:`);
  for (const c of failed) console.error(`  - ${c.name}`);
  console.error(`Treat the generated numbers as invalid until this is resolved.\n`);
  process.exitCode = 1;
}
