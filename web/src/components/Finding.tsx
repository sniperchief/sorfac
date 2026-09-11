// The core finding: one probability band that keeps behaving differently.
//
// The centre of the page. The big numbers are the Phase-5 aggregate for the
// 20-30% bucket; the chart is the Phase-2 reliability curve with that bucket
// marked. Both read from the research bundle — nothing is recomputed here.

import type { Async, ResearchBundle } from "../lib/data";
import { ErrorState, Loading } from "./Shell";
import { DASH, UNAVAILABLE, int, num, pct, pp, signed } from "../lib/format";

type Bucket = ResearchBundle["calibration"]["buckets"][number];

const HOT = "20-30%";

/**
 * Reliability diagram: predicted probability against realised Up rate, one
 * point per fixed 10% bucket, area proportional to sample size. A perfectly
 * calibrated venue sits on the dashed diagonal.
 */
function ReliabilityChart({ buckets, hotDeviation }: { buckets: Bucket[]; hotDeviation: number | null }) {
  const W = 460;
  const H = 340;
  const P = { t: 14, r: 16, b: 34, l: 40 };
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;

  const x = (v: number) => P.l + v * iw;
  const y = (v: number) => P.t + (1 - v) * ih;

  const usable = buckets.filter((b) => b.n > 0 && b.meanPredicted != null && b.actualUpRate != null);
  const maxN = Math.max(1, ...usable.map((b) => b.n));
  const r = (n: number) => 3.2 + 6.8 * Math.sqrt(n / maxN);

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const hot = usable.find((b) => b.bucket === HOT) ?? null;

  return (
    <figure className="chart" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="chart-title chart-desc">
        <title id="chart-title">Reliability diagram of DreamDEX Event Contract probabilities</title>
        <desc id="chart-desc">
          {usable
            .map((b) => `${b.bucket}: predicted ${pct(b.meanPredicted, 1, DASH)}, observed ${pct(b.actualUpRate, 1, DASH)}, n=${b.n}`)
            .join("; ")}
        </desc>

        {ticks.map((t) => (
          <g key={`g${t}`}>
            <line className="grid-line" x1={P.l} x2={P.l + iw} y1={y(t)} y2={y(t)} />
            <text className="tick-text" x={P.l - 8} y={y(t) + 3.5} textAnchor="end">
              {Math.round(t * 100)}%
            </text>
            <text className="tick-text" x={x(t)} y={H - P.b + 16} textAnchor="middle">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}

        <line className="axis-line" x1={P.l} x2={P.l} y1={P.t} y2={P.t + ih} />
        <line className="axis-line" x1={P.l} x2={P.l + iw} y1={P.t + ih} y2={P.t + ih} />
        <line className="ideal" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} />

        <text className="tick-text" x={P.l + iw} y={H - 4} textAnchor="end">
          MARKET-IMPLIED PROBABILITY AT T−1M
        </text>
        <text
          className="tick-text"
          x={11}
          y={P.t + ih / 2}
          transform={`rotate(-90 11 ${P.t + ih / 2})`}
          textAnchor="middle"
        >
          OBSERVED UP RATE
        </text>

        <polyline
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.2}
          strokeOpacity={0.35}
          points={usable.map((b) => `${x(b.meanPredicted!)},${y(b.actualUpRate!)}`).join(" ")}
        />

        {hot ? (
          <>
            <line className="drop" x1={x(hot.meanPredicted!)} y1={y(hot.meanPredicted!)} x2={x(hot.meanPredicted!)} y2={y(hot.actualUpRate!)} />
            <text className="callout" x={x(hot.meanPredicted!) + 12} y={(y(hot.meanPredicted!) + y(hot.actualUpRate!)) / 2 + 4}>
              {pp(hotDeviation, 2, DASH)}
            </text>
          </>
        ) : null}

        {usable.map((b) => (
          <circle
            key={b.bucket}
            className={`pt${b.bucket === HOT ? " hot" : ""}`}
            cx={x(b.meanPredicted!)}
            cy={y(b.actualUpRate!)}
            r={r(b.n)}
          >
            <title>{`${b.bucket} — predicted ${pct(b.meanPredicted, 2, DASH)}, observed ${pct(b.actualUpRate, 2, DASH)}, n=${b.n}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption>
        Each point is one fixed 10% bucket; area is proportional to sample size. Points on the dashed line are
        perfectly calibrated. The 20–30% bucket is the only one that falls this far below it.
      </figcaption>
    </figure>
  );
}

function DevTable({
  caption,
  rows,
  hotLabel,
}: {
  caption: string;
  rows: { label: string; n: number; expected: number | null; observed: number | null; deviation: number | null; z: number | null; tooSmall: boolean }[];
  hotLabel?: string;
}) {
  return (
    <div>
      <p className="eyebrow" style={{ marginBottom: 8 }}>
        {caption}
      </p>
      <div className="tbl-scroll">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col">n</th>
              <th scope="col">Predicted</th>
              <th scope="col">Observed</th>
              <th scope="col">Gap</th>
              <th scope="col">z</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} data-hot={r.label === hotLabel ? "true" : undefined}>
                <th scope="row" style={{ fontWeight: 500, textAlign: "left" }}>
                  {r.label}
                  {r.tooSmall ? <span style={{ color: "var(--ink-mute)", fontSize: 11 }}> · below n=20</span> : null}
                </th>
                <td className="n">{int(r.n, DASH)}</td>
                <td className="n">{pct(r.expected, 2, DASH)}</td>
                <td className="n">{pct(r.observed, 2, DASH)}</td>
                <td className={`n ${(r.deviation ?? 0) < 0 ? "neg" : "pos"}`}>{pp(r.deviation, 2, DASH)}</td>
                <td className="n">{signed(r.z, 2, DASH)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Finding({ research }: { research: Async<ResearchBundle> }) {
  if (research.state === "loading") return <Loading label="Loading the calibration result" rows={5} />;
  if (research.state === "error") {
    return (
      <ErrorState
        title="The research bundle could not be loaded, so no result is shown."
        detail={`${research.error}. Run: npm run web:data`}
      />
    );
  }

  const { headline: h, calibration: c } = research.data;
  const observedW = Math.max(2, ((h.observed ?? 0) / Math.max(h.expected ?? 1, h.observed ?? 1)) * 100);
  const expectedW = Math.max(2, ((h.expected ?? 0) / Math.max(h.expected ?? 1, h.observed ?? 1)) * 100);

  return (
    <>
      <div className="finding">
        <div className="gapcard">
          <div className="gapcard-top">
            <span className="band">{h.bucket}</span>
            <span className="cnt">n = {int(h.n)}</span>
          </div>
          <div className="gapcard-body">
            <div className="gaprow">
              <span className="k">Predicted</span>
              <span className="v">{pct(h.expected)}</span>
            </div>
            <div className="gaprow">
              <span className="k">Observed</span>
              <span className="v">{pct(h.observed)}</span>
            </div>
            <div className="bars" aria-hidden="true">
              <div className="bar">
                <span>Predicted</span>
                <i style={{ width: `${expectedW}%` }} />
              </div>
              <div className="bar obs">
                <span>Observed</span>
                <i style={{ width: `${observedW}%` }} />
              </div>
            </div>
            <div className="gaprow gap">
              <span className="k">Calibration gap</span>
              <span className="v">{pp(h.deviation)}</span>
            </div>
          </div>
        </div>

        <div className="finding-side">
          <ReliabilityChart buckets={c.buckets} hotDeviation={h.deviation} />

          <div className="tbl-scroll">
            <table className="data">
              <caption className="eyebrow" style={{ textAlign: "left", paddingBottom: 8 }}>
                Robustness of the {h.bucket} result
              </caption>
              <tbody>
                <tr>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 400 }}>
                    z-score against the predicted rate
                  </th>
                  <td className="n">{signed(h.z)}</td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 400 }}>
                    Observed 95% interval (Wilson)
                  </th>
                  <td className="n">
                    {pct(h.ci95[0], 2, DASH)} – {pct(h.ci95[1], 2, DASH)}
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 400 }}>
                    Predicted rate inside that interval
                  </th>
                  <td className="n">{h.expectedOutsideCI ? "No — outside" : "Yes"}</td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 400 }}>
                    Cadence-standardised gap
                  </th>
                  <td className="n neg">{pp(h.standardisedDeviation)}</td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 400 }}>
                    Equal-period-weighted gap
                  </th>
                  <td className="n neg">{pp(h.equalPeriodWeighted)}</td>
                </tr>
                {h.outOfSample ? (
                  <tr>
                    <th scope="row" style={{ textAlign: "left", fontWeight: 400 }}>
                      Held-out period (n = {int(h.outOfSample.oosN)})
                    </th>
                    <td className="n neg">{pp(h.outOfSample.oosDiff)}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <details className="disclosure" style={{ marginTop: 28 }}>
        <summary>Statistical detail — cadence, sub-bands, neighbours and chronological periods</summary>
        <div className="disclosure-body">
          <p style={{ fontSize: 13.5, color: "var(--ink-soft)" }}>
            Bucket membership is Phase-2 semantics: {h.semantics}. Cells below n=20 are reported with their counts and
            carry no inference. Overall scores for this bucket: Brier {num(h.brier)}, log loss {num(h.logloss)}.
          </p>

          <DevTable
            caption="By cadence"
            hotLabel="All cadences"
            rows={[
              { label: "All cadences", n: h.n, expected: h.expected, observed: h.observed, deviation: h.deviation, z: h.z, tooSmall: false },
              ...h.perCadence.map((c2) => ({
                label: c2.cadence,
                n: c2.dev.n,
                expected: c2.dev.expected,
                observed: c2.dev.observed,
                deviation: c2.dev.deviation,
                z: c2.dev.z,
                tooSmall: c2.dev.tooSmall,
              })),
            ]}
          />

          <DevTable
            caption="Neighbouring probability regions — is it a local discontinuity?"
            hotLabel={h.bucket}
            rows={h.neighbours.map((b) => ({
              label: b.bucket,
              n: b.n,
              expected: b.expected,
              observed: b.observed,
              deviation: b.deviation,
              z: b.z,
              tooSmall: b.tooSmall,
            }))}
          />

          <DevTable
            caption={`Sub-bands inside ${h.bucket} — where in the band the gap sits`}
            rows={h.subBands.map((b) => ({
              label: b.subBand,
              n: b.n,
              expected: b.expected,
              observed: b.observed,
              deviation: b.deviation,
              z: b.z,
              tooSmall: b.tooSmall,
            }))}
          />

          <DevTable
            caption="Chronological periods — four equal-count windows, boundaries fixed before any result"
            rows={h.periods.map((p) => ({
              label: `${p.period} · ${p.startIso.slice(0, 10)} → ${p.endIso.slice(0, 10)}`,
              n: p.targetBucket.n,
              expected: p.targetBucket.expected,
              observed: p.targetBucket.observed,
              deviation: p.targetBucket.deviation,
              z: p.targetBucket.z,
              tooSmall: p.targetBucket.tooSmall,
            }))}
          />

          <p style={{ fontSize: 13, color: "var(--ink-mute)" }}>
            The magnitude is not stable across periods, and one of the four reverses sign. That caveat is the reason
            the prospective test exists, and the reason the correction candidate below is the conservative
            equal-period-weighted figure rather than the aggregate.
          </p>
        </div>
      </details>
    </>
  );
}

export const FINDING_UNAVAILABLE = UNAVAILABLE;
