# DreamDEX Event Contracts — Calibration Analysis

A read-only research pipeline that measures how well **DreamDEX Event Contract** prices on **Somnia mainnet** predict their own outcomes.

It answers one question: when the market says an event has a 25% chance, does it happen 25% of the time?

Everything below comes from live mainnet data. There is no mock data, no fixture, and no fabricated value anywhere in the pipeline.

---

## What this is, and what it is not

**It is** a completed six-phase empirical study of 16,418 settled binary markets, with every number reproducible from the commands below.

**It is not** a trading system, a confidence model, a price feed, or a validated calibration correction. See [Honest status](#honest-status).

## Requirements

- Node 20+ (developed on Node 24)
- Network access to the Somnia mainnet indexer

No wallet, private key, or credential of any kind is required or used. The SDK is constructed without a signing key, so the pipeline is structurally incapable of submitting a transaction.

```bash
npm install
npm run verify        # typecheck (research + web) + 283 tests
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DDX_ENV` | `mainnet` | `mainnet` or `testnet`. Anything else exits with an error. |
| `DDX_INDEXER` | derived from `DDX_ENV` | Override the indexer endpoint. Logs a warning when set. |
| `DDX_CONCURRENCY` | `8` | Parallel indexer requests. |
| `DDX_REFETCH` | unset | Re-pull cached datasets instead of reusing them. |

Every published result was produced on `mainnet` against `https://prd.smk.somnia.host/v1/graphql` with `@somnia-chain/markets-sdk@0.30.0`.

## Running the pipeline

The phases build on each other and must run in order. Each command tells you what to run first if a prerequisite is missing.

```bash
npm run inventory           # 1. pull the market registry from mainnet  (~15s)
npm run extract             # 2. build T-1m observations                (~110s)
npm run compare             # 3. Phase 2 calibration comparison
npm run analyze-quality     # 4. Phase 3 market quality and liquidity   (~90s first run)
npm run validate-freshness  # 5. Phase 4 out-of-sample validation
npm run analyze-anomaly     # 6. Phase 5 anomaly investigation
npm run test-correction     # 7. Phase 6 prospective correction test
```

`npm run audit` runs a live end-to-end smoke test: it confirms mainnet provenance, traces the full T-1m calculation on real settled markets, and asserts there is no look-ahead.

Results land in `out/` as paired `.json` (machine-readable) and `.txt` (human-readable) files. `out/` is not committed; the commands regenerate it.

## The web UI

Two pages.

**`/`** tells the story: the finding, the checks it survived, the methodology, an explorer
over every market it was measured on, and the live state of the Phase-6 prospective test.

**`/analyze`** is the tool. Give it what a contract costs — typed, dragged, or taken from a
contract trading on mainnet right now — and it runs the study's analysis over that price's
band: the deviation and its interval, the same figure split by cadence, the same figure
across four chronological periods, what the frozen correction would say (only for the range
it covers, and never as validated), and the settled markets underneath it. An analysis is
linkable: `/analyze?price=25`.

```bash
npm run web:build      # project out/*.json into the page payload, then bundle the app
npm run web            # serve it on http://localhost:5173
```

`npm run web:start` does both in one command. `npm run web:dev` runs Vite with hot reload
against a separately started `npm run web`.

The pages are a presentation layer and compute no statistics of their own. Figures are
projected from the `out/*.json` artifacts by `src/web/build-data.ts`, which calls the
project's own locked functions — Phase 2's `bucketIndex`, Phase 5's `deviationStats`,
`chronologicalPeriods` and `subBand` — rather than restating them. Extending the published
analysis from the four bands Phase 5 examined to all ten is guarded: the build refuses to
emit a payload unless it reproduces every published Phase-5 band and period exactly. Two read-only endpoints, `/api/live/status` and `/api/live/markets`, go through the
same key-less SDK client the pipeline uses.

```bash
npm run web:check      # assert the shipped page equals the recorded research
```

`web:check` rebuilds the payload from `out/*.json` and diffs every field against the file
the browser downloads, including all 2,437 explorer markets. It exits non-zero on any drift,
so a stale or hand-edited payload cannot be demoed as if it were the real result.

`web/public/data/` is committed. It holds the projected page payload, so a fresh clone shows
the real recorded finding immediately; regenerate it with `npm run web:data` after re-running
any phase. `web/dist/` is build output and is not committed.

There is no mock data and no demo mode. If the indexer is unreachable the live indicator
reads "live data unavailable" and the open-markets tab shows the error; if a figure is
absent from a phase output the page prints `Data unavailable` rather than a number. Run the
pipeline first — `npm run web:data` exits with the usual actionable message if a phase has
not been run.

| Variable | Purpose |
|---|---|
| `PORT` | Port for `npm run web`. Default `5173`. |
| `DDX_REPO_URL` | Repository link for the footer. Omitted entirely when unset. |
| `DDX_WEB_ROOT` | Static root to serve. Default `web/dist`. |

## Deploying

The repository is configured for Vercel, which serves the built page from a CDN and runs the
two live endpoints as serverless functions. Import the repository at vercel.com and accept
the defaults; `vercel.json` supplies the build command, the output directory, and the rewrite
that lets `/analyze` survive a refresh.

Any host that can run a Node process works too — `render.yaml` covers Render, and the same
two commands work on Railway or Fly.io:

```bash
npm ci && npm run build     # bundles the committed page payload
npm start                   # serves it, plus /api/live/*, on $PORT
```

A deploy never runs the research pipeline. `npm run build` bundles the payload committed in
`web/public/data`, and refuses to build if it is absent rather than shipping a page with an
empty study. Only `npm run web:build` regenerates that payload, and it needs `out/`.

| Variable | Purpose |
|---|---|
| `PORT` | Injected by the host. Node-server deploys only. |
| `DDX_ENV` | `mainnet` (default) or `testnet`. |
| `DDX_REPO_URL` | Repository link for the footer. Omitted when unset. |

A static-only host with no functions still serves the whole study, because the research half
is static JSON. The live indicator reads "live data unavailable" and the open-market list
shows an error, which is the designed degradation rather than a failure.

## Method in one paragraph

For each settled market we take the last trade at or before **60 seconds before that market's own expiry** (T-1m), scale it by the market's own collateral decimals into a probability, and score it against the realised outcome using ten fixed 10% buckets, Brier score, and log loss. Markets are keyed by `marketId`, never by pool address, because one pool has served 694 successive markets.

## Findings

The per-phase write-ups are not published in this repository. Every figure they contain is
regenerated by the commands above into `out/`, as a machine-readable `.json` and a human-readable
`.txt` per phase, and the headline results are summarised below.

| Phase | Question | Answer |
|---|---|---|
| 1 | Is there enough data? | Yes. 16,418 settled markets, but 80.5% never traded. |
| 2 | Is T-1m better than `lastPrice`? | Better calibrated (3.94pp vs 5.16pp error), worse on Brier, because `lastPrice` carries look-ahead. |
| 3 | Does liquidity explain calibration? | No. Trade count is uncorrelated with volume (rho -0.003) and is not a liquidity proxy here. |
| 4 | Does freshness generalise? | **No.** It reversed out-of-sample. Gate C. |
| 5 | Is the 20-30% anomaly real? | Survives cadence, regime, structure and out-of-sample testing at -11.17pp, z=-3.40. Gate A. |
| 6 | Does a -8.56pp correction work? | **Unknown.** The 30-day window has barely started. Gate D. |

### The headline result

Across 2,437 markets with a usable T-1m price, the 20-30% probability bucket resolves Up **13.37%** of the time against a predicted **24.54%** — a deviation of -11.17pp at z = -3.40. It is a sharp local discontinuity: its immediate neighbours sit within 2pp of zero. It is present in all three cadences at similar magnitude and is not explained by trade count, maker count, volume, dust, freshness, market duration, or late repricing.

## Honest status

The project makes no claim beyond what the data supports.

- The **-8.56pp correction is NOT validated.** Phase 6 evaluated it on **zero** qualifying markets, because its 30-day prospective window opened minutes before the phase ran. The result is Gate D, insufficient evidence. It is neither confirmed nor rejected.
- The **anomaly is not proven stationary.** One of four historical periods reversed sign, and equal-weighting periods attenuates it from -11.17pp to -8.56pp.
- The anomaly has **no established causal explanation.** Every variable measured across Phases 3 to 5 failed to explain it.
- **No confidence model has been built or validated.** Phase 4 explicitly recommended against building one.
- Freshness is **not** a validated reliability signal. It failed out-of-sample.
- The dataset spans **51 days** on a venue roughly seven weeks old whose composition changed materially mid-study. More history is the binding constraint on every open question.

What is defensible: the historical 20-30% anomaly is a real empirical finding in the completed retrospective analysis, and the pipeline that measured it is reproducible and leak-audited.

## Data integrity

- **No look-ahead.** The T-1m price is the last trade at or before `expiry - 60`. Verified on live markets by `npm run audit`, including markets whose only later trades were correctly ignored.
- **Per-market decimals.** Prices are scaled by each market's own `quoteDecimals`. Mainnet carries both 18-decimal and 6-decimal collateral, so a hardcoded `1e18` would misprice 12 markets by a factor of a trillion.
- **Pool recycling handled.** Reads are scoped to each market's own trading window and filtered by `marketId`.
- **Fails loudly.** A missing prerequisite, a bad argument, an invalid `DDX_ENV`, or a failed internal consistency check exits non-zero rather than emitting plausible-looking numbers.

## Layout

```
src/calibration.ts    Phase-1 calibration methodology (frozen)
src/extract-t1m.ts    the T-1m extractor
src/providers/        fill-tape and 60s-candle price providers
src/compare.ts        Phase-2 comparison
src/quality.ts        Phase-3 market-quality variables and cohorts
src/freshness.ts      Phase-4 chronological validation
src/anomaly.ts        Phase-5 anomaly analysis
src/correction.ts     Phase-6 frozen correction (-0.0856)
src/io.ts             guarded loading and exit-code discipline
src/run-*.ts          one command per phase
src/0*.ts             Phase-1 exploration scripts
src/web/              the web UI's data projection, live layer and thin server
api/                  the same live layer as serverless functions, for Vercel
web/                  the React + Vite single-page app
src/test/             283 tests
```

## Licence and data

Read-only public mainnet data. Oracle evidence for any market is verifiable at `https://prd.oracle.somnia.host/v1/graphql`, where the posted answer reproduces exactly as the median of its source prices.
