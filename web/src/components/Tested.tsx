// "We tried to explain it away" — the investigation, as a timeline.
//
// Each entry is one explanation the research tested against the anomaly. The
// verdict and the sentence are product copy; every figure beside them is read
// from the persisted phase outputs at build time.

import type { Async, ResearchBundle } from "../lib/data";
import { ErrorState, Loading } from "./Shell";

export function Tested({ research }: { research: Async<ResearchBundle> }) {
  if (research.state === "loading") return <Loading label="Loading the robustness checks" rows={4} />;
  if (research.state === "error") {
    return <ErrorState title="The robustness checks could not be loaded." detail={`${research.error}. Run: npm run web:data`} />;
  }

  const { challenges } = research.data;

  return (
    <div className="timeline">
      {challenges.map((c, i) => (
        <article className="tl-item" key={c.id}>
          <div className="tl-idx">
            {String(i + 1).padStart(2, "0")} / {String(challenges.length).padStart(2, "0")}
          </div>
          <div className="tl-body">
            <div className="tl-head">
              <h3>{c.title}</h3>
              <span className="chip" data-v={c.verdict}>
                {c.verdict}
              </span>
            </div>
            <p className="tl-claim">{c.claim}</p>
            <div className="evidence">
              {c.evidence.map((e) => (
                <span className="ev" key={e.label}>
                  <span>{e.label}</span>
                  <b>{e.value}</b>
                </span>
              ))}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
