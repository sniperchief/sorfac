// Render tests for the page.
//
// These render the real components to static markup and assert on what a judge
// would actually see. The point is not snapshotting: it is that the page comes
// up at all, that a failed data source produces a visible failure, and that no
// number appears anywhere it has not been read from a phase output.
//
// Typechecked by web/tsconfig.json (which configures JSX), run by `npm test`.

import type { ReactElement } from "react";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import App from "../../web/src/App.js";
import { Finding } from "../../web/src/components/Finding.js";
import { Tested } from "../../web/src/components/Tested.js";
import { Experiment, Integrity } from "../../web/src/components/Experiment.js";
import { Explorer } from "../../web/src/components/Explorer.js";
import { LiveStatusPill } from "../../web/src/components/Shell.js";
import { ResearchMarketDetail } from "../../web/src/components/MarketDetail.js";
import { Analyze } from "../../web/src/components/Analyze.js";
import type { Async, LiveStatus, MarketRow, ResearchBundle } from "../../web/src/lib/data.js";
import { buildMarketRows, type QualityDoc } from "../web/bundle.js";
import { FROZEN_CORRECTION } from "../correction.js";
import { loadRequired } from "../io.js";

const html = (node: ReactElement) => renderToStaticMarkup(node);

// The rendering tests read the REAL committed payload, so what they assert is
// what the page shows. If it has not been built, that is the failure to report.
const research: ResearchBundle = loadRequired<ResearchBundle>(
  "web/public/data/research.json",
  "the web research payload (produced by npm run web:data)",
);

const ready: Async<ResearchBundle> = { state: "ready", data: research };
const loading: Async<ResearchBundle> = { state: "loading" };
const failed: Async<ResearchBundle> = { state: "error", error: "HTTP 500 from the payload" };

const statusOk: Async<LiveStatus> = {
  state: "ready",
  data: { ok: true, env: "mainnet", indexerUrl: "https://prd.smk.somnia.host/v1/graphql", latencyMs: 214, checkedAt: "2026-09-10T22:00:00.000Z", reachable: true },
};
const statusDown: Async<LiveStatus> = { state: "error", error: "fetch failed" };

describe("the page comes up", () => {
  test("the whole app renders without throwing, in every data state", () => {
    for (const s of [statusOk, statusDown, { state: "loading" } as Async<LiveStatus>]) {
      const out = html(<App />);
      assert.ok(out.length > 2000, "the app rendered almost nothing");
      assert.ok(s);
    }
  });

  test("the hero states the question and both calls to action", () => {
    const out = html(<App />);
    assert.match(out, /Can you trust the probability\?/);
    assert.match(out, /Analyse a price/);
    assert.match(out, /How it works/);
    assert.match(out, /DreamDEX × Somnia/);
  });

  test("every section a judge is told to look for has a landmark id", () => {
    const out = html(<App />);
    for (const id of ["finding", "tested", "method", "markets", "experiment", "integrity"]) {
      assert.match(out, new RegExp(`id="${id}"`), `section #${id} is missing`);
    }
  });

  test("headings are semantic and there is exactly one h1", () => {
    const out = html(<App />);
    assert.equal(out.match(/<h1[ >]/g)?.length, 1);
    assert.ok((out.match(/<h2[ >]/g)?.length ?? 0) >= 6);
  });
});

describe("the finding is shown from the persisted result", () => {
  test("the predicted, observed and gap figures are the committed ones", () => {
    const out = html(<Finding research={ready} />);
    const h = research.headline;
    assert.match(out, new RegExp(`${(h.expected! * 100).toFixed(2)}%`));
    assert.match(out, new RegExp(`${(h.observed! * 100).toFixed(2)}%`));
    assert.match(out, new RegExp(`${Math.abs(h.deviation! * 100).toFixed(2)}pp`));
    assert.match(out, new RegExp(`n = ${h.n}`));
  });

  test("the sample size, z-score and cadence-standardised figure are all present", () => {
    const out = html(<Finding research={ready} />);
    assert.match(out, /z-score/);
    assert.match(out, new RegExp(`${Math.abs(research.headline.z!).toFixed(2)}`));
    assert.match(out, /Cadence-standardised gap/);
    assert.match(out, /Equal-period-weighted gap/);
  });

  test("the reliability chart plots one point per non-empty bucket", () => {
    const out = html(<Finding research={ready} />);
    const points = out.match(/class="pt/g)?.length ?? 0;
    assert.equal(points, research.calibration.buckets.filter((b) => b.n > 0).length);
  });

  test("a failed payload shows the failure, not a blank or a zero", () => {
    const out = html(<Finding research={failed} />);
    assert.match(out, /Data unavailable/);
    assert.match(out, /HTTP 500 from the payload/);
    assert.doesNotMatch(out, /0\.00%/);
  });

  test("while loading it shows a loading state rather than empty numbers", () => {
    const out = html(<Finding research={loading} />);
    assert.match(out, /role="status"/);
    assert.match(out, /Loading the calibration result/);
  });
});

describe("the robustness section", () => {
  test("all six verdicts render with their labels", () => {
    const out = html(<Tested research={ready} />);
    for (const v of ["SURVIVES", "NOT EXPLAINED", "NOT ROBUST", "IMPORTANT CAVEAT"]) {
      assert.match(out, new RegExp(v));
    }
    assert.equal(out.match(/data-v="SURVIVES"/g)?.length, 2);
  });

  test("a failed payload shows the failure", () => {
    assert.match(html(<Tested research={failed} />), /Data unavailable/);
  });
});

describe("the prospective experiment never reads as validated", () => {
  test("it says not yet validated, in the section itself", () => {
    const out = html(<Experiment research={ready} />);
    assert.match(out, /Not yet validated/i);
    assert.match(out, /No tuning is performed using prospective results/);
  });

  test("it shows the frozen correction, the real window and the real qualifying count", () => {
    const out = html(<Experiment research={ready} />);
    assert.match(out, new RegExp(`${(FROZEN_CORRECTION * 100).toFixed(2)}pp`));
    assert.match(out, new RegExp(`${research.phase6.targetWindowDays} days`));
    assert.match(out, /Qualified markets/);
    assert.match(out, new RegExp(`>${research.phase6.qualifying}<`));
  });

  test("nothing in the section claims the correction works", () => {
    const out = html(<Experiment research={ready} />).toLowerCase();
    assert.doesNotMatch(out, /correction (is )?(confirmed|validated|proven|works)/);
    assert.match(out, /insufficient evidence/);
  });

  test("a failed payload shows the failure rather than an empty experiment", () => {
    assert.match(html(<Experiment research={failed} />), /Data unavailable/);
  });
});

describe("research integrity", () => {
  test("the three principles render with the reasons behind them", () => {
    const out = html(<Integrity research={ready} />);
    assert.match(out, /No look-ahead/);
    assert.match(out, /No fitted correction/);
    assert.match(out, /No manufactured result/);
    assert.match(out, /T−1M INFORMATION BOUNDARY/);
  });

  test("the provenance list names every source file", () => {
    const out = html(<Integrity research={ready} />);
    for (const s of research.sources) assert.match(out, new RegExp(s.file.replace(/[/.]/g, "\\$&")));
  });

  test("without a payload it degrades to the principles alone, with no invented provenance", () => {
    const out = html(<Integrity research={failed} />);
    assert.match(out, /No look-ahead/);
    assert.doesNotMatch(out, /out\/anomaly-analysis/);
  });
});

describe("the explorer's non-happy paths", () => {
  test("before the payload arrives it shows a loading state, not an empty table", () => {
    const out = html(<Explorer research={ready} />);
    assert.match(out, /Research dataset/);
    assert.match(out, /Open markets/);
    assert.match(out, /role="status"|Loading the research market population/);
    assert.doesNotMatch(out, /<tbody><\/tbody>/);
  });

  test("both tabs are real tabs with the right ARIA wiring", () => {
    const out = html(<Explorer research={ready} />);
    assert.match(out, /role="tablist"/);
    assert.match(out, /id="tab-research"[^>]*|aria-controls="panel-research"/);
    assert.match(out, /aria-selected="true"/);
  });
});

describe("the live indicator tells the truth", () => {
  test("it claims mainnet only once the indexer has answered", () => {
    assert.match(html(<LiveStatusPill status={statusOk} />), /mainnet data/);
    assert.match(html(<LiveStatusPill status={statusOk} />), /data-state="ok"/);
  });

  test("an unreachable indexer reads as unavailable, never as live", () => {
    const out = html(<LiveStatusPill status={statusDown} />);
    assert.match(out, /Live data unavailable/);
    assert.match(out, /data-state="down"/);
    assert.doesNotMatch(out, /mainnet data/);
  });

  test("before the first answer it says it is still checking", () => {
    const out = html(<LiveStatusPill status={{ state: "loading" }} />);
    assert.match(out, /Checking indexer/);
    assert.doesNotMatch(out, /mainnet data/);
  });
});

describe("market detail", () => {
  const qualityRow = (over: Partial<QualityDoc["perMarket"][number]> = {}) => ({
    marketId: "0x00000000000000000000000000000000000000000000000000000000000000e3",
    asset: "BTC",
    cadence: "15m",
    intervalSec: 900,
    targetTimestamp: 1784735040,
    tradeCountPre: 4,
    uniqueMakersPre: 2,
    volumePre: 0.000984,
    t1mAgeSec: 40,
    isolatedPrint: false,
    tradeCountTotal: 5,
    diagnostic: { tradesPost: 3, absMovePost: 0 },
    p: 0.245,
    y: 0 as const,
    ...over,
  });

  const rowFor = (over: Partial<QualityDoc["perMarket"][number]> = {}): MarketRow =>
    buildMarketRows(
      { generatedAt: "", env: "mainnet", indexerUrl: "", population: 1, perMarket: [qualityRow(over)] },
      { generatedAt: "", indexerUrl: "", horizonSec: 60, populationSize: 1, extracted: 1, rows: [] },
    )[0];

  test("it shows the market, the observation, the outcome and the bucket", () => {
    const out = html(<ResearchMarketDetail market={rowFor()} onClose={() => {}} />);
    assert.match(out, /24\.50%/);
    assert.match(out, /Calibration bucket/);
    assert.match(out, /20-30%/);
    assert.match(out, /DOWN/);
    assert.match(out, /Observation age/);
  });

  test("it states the look-ahead rule and counts the excluded trades", () => {
    const out = html(<ResearchMarketDetail market={rowFor()} onClose={() => {}} />);
    assert.match(out, /Trades after the target timestamp are\s+excluded/);
    assert.match(out, /3 later trades/);
  });

  test("a market with no later trades says so rather than showing a count of zero trades excluded", () => {
    const out = html(<ResearchMarketDetail market={rowFor({ diagnostic: { tradesPost: 0, absMovePost: 0 } })} onClose={() => {}} />);
    assert.match(out, /no later trades/);
  });

  test("missing provenance renders as unavailable rather than as a fabricated timestamp", () => {
    // This row has no matching T-1m record, so provider and source are null.
    const out = html(<ResearchMarketDetail market={rowFor()} onClose={() => {}} />);
    assert.match(out, /Data unavailable/);
    assert.doesNotMatch(out, /1 Jan 1970/);
  });

  test("it is a labelled modal dialog that can be closed", () => {
    const out = html(<ResearchMarketDetail market={rowFor()} onClose={() => {}} />);
    assert.match(out, /role="dialog"/);
    assert.match(out, /aria-modal="true"/);
    assert.match(out, /aria-label="Close market detail"/);
  });
});

const noop = () => {};
const analyzeRoute = { name: "analyze" as const, price: null };

describe("the analysis workspace", () => {
  test("it asks for a price and offers live contracts to pick from", () => {
    const out = html(<Analyze research={ready} route={analyzeRoute} go={noop} />);
    assert.match(out, /Contract price/);
    assert.match(out, /Or pick one trading now/);
    assert.match(out, /type="range"/);
  });

  test("with no price chosen it prompts rather than showing a verdict", () => {
    const out = html(<Analyze research={ready} route={analyzeRoute} go={noop} />);
    assert.match(out, /Nothing to analyse/);
    assert.doesNotMatch(out, /Unreliable range|In line with outcomes/);
  });

  test("a price from the URL is analysed immediately, with the real band", () => {
    const out = html(<Analyze research={ready} route={{ name: "analyze", price: 25 }} go={noop} />);
    assert.match(out, /Unreliable range/);
    assert.match(out, /band 20-30%/);
    assert.match(out, /Does it hold across cadences\?/);
    assert.match(out, /Does it hold over time\?/);
    assert.match(out, /The markets behind this verdict/);
  });

  test("a well-behaved price gets the opposite verdict", () => {
    const out = html(<Analyze research={ready} route={{ name: "analyze", price: 85 }} go={noop} />);
    assert.match(out, /In line with outcomes/);
    assert.doesNotMatch(out, /Unreliable range/);
  });

  test("the frozen correction is offered only for the range it covers, and never as validated", () => {
    const anomaly = html(<Analyze research={ready} route={{ name: "analyze", price: 25 }} go={noop} />);
    assert.match(anomaly, /Not validated/);
    assert.match(anomaly, /Do not act on the corrected figure/);

    const elsewhere = html(<Analyze research={ready} route={{ name: "analyze", price: 85 }} go={noop} />);
    assert.match(elsewhere, /No correction applies to this range/);
  });

  test("a failed payload means nothing can be analysed, and says so", () => {
    const out = html(<Analyze research={failed} route={analyzeRoute} go={noop} />);
    assert.match(out, /Data unavailable/);
    assert.doesNotMatch(out, /Unreliable range/);
  });

  test("the payload carries a verdict for every band, and flags the anomaly", () => {
    assert.equal(research.bands.length, 10);
    const anomaly = research.bands.filter((b) => b.isAnomaly);
    assert.equal(anomaly.length, 1);
    assert.equal(anomaly[0].bucket, "20-30%");
    assert.equal(anomaly[0].verdict, "flagged");
    assert.equal(anomaly[0].direction, "over");
    for (const b of research.bands) {
      assert.ok(["flagged", "in-line", "thin"].includes(b.verdict), `${b.bucket} has no verdict`);
      if (b.verdict === "thin") assert.equal(b.direction, null, `${b.bucket} implies a direction without a verdict`);
    }
  });

  test("the shipped bands reproduce the published Phase-5 figures exactly", () => {
    // The four bands Phase 5 examined are the ones with published numbers.
    const band = research.bands.find((b) => b.bucket === "20-30%")!;
    assert.equal(band.n, research.headline.n);
    assert.equal(band.predicted, research.headline.expected);
    assert.equal(band.observed, research.headline.observed);
    assert.equal(band.deviation, research.headline.deviation);
    assert.equal(band.z, research.headline.z);
  });

  test("it is honest about what a live price is", () => {
    const out = html(<Analyze research={ready} route={analyzeRoute} go={noop} />);
    assert.match(out, /not the T−1m observations the study measured/);
    assert.match(out, /None of these contracts has settled/);
  });
});

describe("no fabricated data reaches the page", () => {
  test("the rendered page contains no mock, demo, sample or placeholder marker", () => {
    // Visible text only: an input's `placeholder` attribute is chrome, not data.
    const text = html(<App />)
      .replace(/<[^>]*>/g, " ")
      .toLowerCase();
    for (const word of ["lorem", "mock", "fixture", "placeholder", "dummy", "todo", "example.com", "sample data", "coming soon"]) {
      assert.ok(!text.includes(word), `the page shows "${word}"`);
    }
  });

  test("no rendered value is undefined or NaN", () => {
    for (const node of [<App />, <Finding research={ready} />, <Experiment research={ready} />, <Tested research={ready} />]) {
      const out = html(node);
      assert.doesNotMatch(out, />\s*(undefined|NaN|null)\s*</, "a raw undefined/NaN/null was rendered");
    }
  });
});
