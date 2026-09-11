// The prospective correction experiment, and the integrity principles.
//
// The most important thing this section does is refuse to overclaim. The
// correction is frozen, the window has barely opened, zero markets qualify, and
// the section says exactly that in the largest type available to it.

import type { Async, ResearchBundle } from "../lib/data";
import { ErrorState, Loading } from "./Shell";
import { UNAVAILABLE, dayUnix, int, num, pp, stampIso } from "../lib/format";

export function Experiment({ research }: { research: Async<ResearchBundle> }) {
  if (research.state === "loading") return <Loading label="Loading the prospective experiment state" rows={4} />;
  if (research.state === "error") {
    return <ErrorState title="The prospective experiment state could not be loaded." detail={`${research.error}. Run: npm run web:data`} />;
  }

  const p = research.data.phase6;
  const passed = p.leakageAudit.filter((c) => c.ok).length;

  const cells = [
    { k: "Correction", v: pp(-p.correction) },
    { k: "Started", v: dayUnix(p.cutoff) },
    { k: "Evaluation window", v: `${int(p.targetWindowDays)} days` },
    { k: "Qualified markets", v: int(p.qualifying) },
  ];

  const funnel = [
    { k: "Markets expiring after the cutoff", v: p.funnel.prospective },
    { k: "Settled", v: p.funnel.settled },
    { k: "With a recorded outcome", v: p.funnel.withOutcome },
    { k: "With a T−1m prediction", v: p.funnel.withPrediction },
    { k: `Qualifying (${p.cadence}, ${p.bucket})`, v: p.qualifying },
  ];

  return (
    <div className="exp">
      <div>
        <span className="exp-status">
          <span className="dot" aria-hidden="true" />
          {p.statusLabel}
        </span>

        <div className="exp-grid">
          {cells.map((c) => (
            <div className="exp-cell" key={c.k}>
              <div className="k">{c.k}</div>
              <div className="v">{c.v}</div>
            </div>
          ))}
        </div>

        <div className="notvalid" role="note">
          <strong>Not yet validated</strong>
          <p>
            The experiment will evaluate the fixed correction after the preregistered observation window. No tuning is
            performed using prospective results. With {int(p.qualifying)} qualifying markets the current verdict is
            gate {p.gate}: insufficient evidence, which is neither confirmation nor rejection.
          </p>
        </div>
      </div>

      <div className="exp-panel">
        <p className="eyebrow" style={{ marginBottom: 14 }}>
          Preregistration
        </p>
        <p style={{ fontSize: 14.5, color: "rgba(244,244,239,0.82)", lineHeight: 1.6 }}>
          Historical analysis found a conservative {pp(-p.correction)} correction candidate for the {p.bucket} region.
          Instead of fitting it to the same data that discovered the anomaly, the value was frozen at{" "}
          <span className="mono">{num(p.correction, 4)}</span> as a module constant and a prospective test opened on
          new {p.cadence} markets.
        </p>

        <div className="funnel">
          {funnel.map((f) => (
            <div className="fstep" key={f.k}>
              <span>{f.k}</span>
              <b>{int(f.v)}</b>
            </div>
          ))}
          <div className="fstep" style={{ borderBottom: 0 }}>
            <span>Target sample before evaluation</span>
            <b>{int(p.targetSample)}</b>
          </div>
        </div>

        <p className="mono" style={{ fontSize: 11, color: "rgba(244,244,239,0.5)", marginTop: 16, lineHeight: 1.7 }}>
          {passed}/{p.leakageAudit.length} leakage checks passing · window opened {stampIso(p.cutoffIso)} ·{" "}
          {num(p.elapsedDays, 2)} days elapsed · dataset {stampIso(p.datasetFetchedAt)}
        </p>
      </div>
    </div>
  );
}

export function Integrity({ research }: { research: Async<ResearchBundle> }) {
  const r = research.state === "ready" ? research.data : null;

  const principles = [
    {
      h: "No look-ahead",
      mark: "T−1M INFORMATION BOUNDARY",
      p: `Every probability is the last trade at or before ${r ? r.stats.horizonSec : 60} seconds before that market's own expiry. Later trades exist in the data and are excluded from the number, not merely ignored.`,
    },
    {
      h: "No fitted correction",
      mark: "FROZEN BEFORE EVALUATION",
      p: r
        ? `The ${pp(-r.phase6.correction)} candidate was frozen as a constant before the prospective window opened, and ${r.phase6.leakageAudit.filter((c) => c.ok).length} of ${r.phase6.leakageAudit.length} leakage checks confirm it was never re-estimated from prospective data.`
        : UNAVAILABLE,
    },
    {
      h: "No manufactured result",
      mark: "INSUFFICIENT ≠ INCONCLUSIVE",
      p: "Insufficient data produces an explicitly inconclusive result rather than a fabricated score. Where a value cannot be read from a recorded output, this page shows that it is unavailable.",
    },
  ];

  return (
    <>
      <div className="principles">
        {principles.map((x) => (
          <div className="principle" key={x.h}>
            <div className="mark">{x.mark}</div>
            <h3>{x.h}</h3>
            <p>{x.p}</p>
          </div>
        ))}
      </div>

      {r ? (
        <details className="disclosure" style={{ marginTop: 22 }}>
          <summary>Provenance — every figure on this page and the file it came from</summary>
          <div className="disclosure-body">
            <p style={{ fontSize: 13.5, color: "var(--ink-soft)" }}>
              This page renders a projection of the committed research outputs. It performs no calibration of its own,
              and {r.integrity.checksPassed} of {r.integrity.checksTotal} recorded consistency and leakage checks
              passed in the runs that produced them. The out-of-sample split was placed at{" "}
              {stampIso(r.integrity.splitBoundaryIso)}, giving {int(r.integrity.trainN)} development and{" "}
              {int(r.integrity.testN)} held-out markets.
            </p>
            <div className="tbl-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Source file</th>
                    <th scope="col">Generated</th>
                  </tr>
                </thead>
                <tbody>
                  {r.sources.map((s) => (
                    <tr key={s.file}>
                      <th scope="row" style={{ textAlign: "left", fontWeight: 400, fontFamily: "var(--mono)", fontSize: 12 }}>
                        {s.file}
                      </th>
                      <td className="n">{stampIso(s.generatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mono" style={{ fontSize: 11.5, color: "var(--ink-mute)" }}>
              env {r.env} · indexer {r.indexerUrl} · payload built {stampIso(r.builtAt)}
            </p>
          </div>
        </details>
      ) : null}
    </>
  );
}
