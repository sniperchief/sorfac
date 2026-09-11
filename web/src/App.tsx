import { Header, Section } from "./components/Shell";
import { Hero, StatStrip } from "./components/Hero";
import { Finding } from "./components/Finding";
import { Tested } from "./components/Tested";
import { Method } from "./components/Method";
import { Explorer } from "./components/Explorer";
import { Experiment, Integrity } from "./components/Experiment";
import { Analyze } from "./components/Analyze";
import { useLiveStatus, useResearch } from "./lib/data";
import { stampIso } from "./lib/format";
import { hrefFor, linkHandler, useRoute, type Route } from "./lib/router";

const TO_ANALYZE: Route = { name: "analyze", price: null };
const TO_HOME: Route = { name: "home" };

export default function App() {
  const research = useResearch();
  const status = useLiveStatus();
  const { route, go } = useRoute();
  const built = research.state === "ready" ? research.data.builtAt : null;
  const repo = research.state === "ready" ? research.data.repositoryUrl : null;

  const footer = (
    <footer className="foot">
      <div className="wrap foot-in">
        <div className="meta">
          DreamDEX Event Contracts · Somnia mainnet
          <br />
          Read-only calibration research. Not a trading system, not a price feed, not investment advice.
          {built ? (
            <>
              <br />
              Research payload built {stampIso(built)}.
            </>
          ) : null}
        </div>
        <nav className="foot-links" aria-label="Resources">
          <a href="https://somnia.network" target="_blank" rel="noreferrer noopener">
            Somnia
          </a>
          {repo ? (
            <a href={repo} target="_blank" rel="noreferrer noopener">
              GitHub repository
            </a>
          ) : null}
          <a href={hrefFor(TO_HOME)} onClick={linkHandler(go, TO_HOME)}>
            Overview
          </a>
          <a href={hrefFor(TO_ANALYZE)} onClick={linkHandler(go, TO_ANALYZE)}>
            Analyse a price
          </a>
        </nav>
      </div>
    </footer>
  );

  if (route.name === "analyze") {
    return (
      <>
        <a className="sr-only skip" href="#main">
          Skip to content
        </a>
        <Header status={status} onNavigate={go} />
        <div className="wsbar">
          <div className="wrap wsbar-in">
            <div>
              <h1>Analyse a price</h1>
              <p>
                Give it what a contract costs. It runs the study's own calibration analysis over that price's range,
                checks whether the result holds across cadences and over time, and shows the settled markets
                underneath it.
              </p>
            </div>
            <a className="backlink" href={hrefFor(TO_HOME)} onClick={linkHandler(go, TO_HOME)}>
              ← Back to the overview
            </a>
          </div>
        </div>
        <main id="main" className="wrap">
          <Analyze research={research} route={route} go={go} />
        </main>
        {footer}
      </>
    );
  }

  return (
    <>
      <a className="sr-only skip" href="#main">
        Skip to content
      </a>
      <Header status={status} onNavigate={go} />

      <main id="main">
        <Hero research={research} status={status} onNavigate={go} />
        <StatStrip research={research} />

        <Section
          id="finding"
          eyebrow="The core finding"
          title="One probability range keeps behaving differently."
          lede="Across the historical sample, markets priced between 20% and 30% showed a materially lower observed Up rate than their predicted probability. Every other band sits close to where it should."
        >
          <Finding research={research} />
        </Section>

        <Section
          id="tested"
          eyebrow="Robustness"
          title="We tried to explain it away."
          lede="A calibration gap is only interesting if it is not an artefact. Each explanation below was tested against the anomaly in a separate phase of the study, and each verdict is what the recorded output says."
        >
          <Tested research={research} />
        </Section>

        <Section
          id="method"
          eyebrow="Method"
          title="How one probability becomes one measurement."
          lede="The whole method is a refusal to look at anything the market could not have known yet."
        >
          <Method research={research} />
        </Section>

        <Section
          id="markets"
          eyebrow="Market explorer"
          title="Every market the result was measured on."
          lede="The settled population behind the calibration figures, one row per market, with the observation that produced its probability. Open markets from the live indexer are on the second tab."
        >
          <Explorer research={research} />
        </Section>

        <Section
          id="experiment"
          eyebrow="Prospective test"
          title="Now we're testing whether it holds."
          lede="A finding discovered in a dataset cannot be validated on that same dataset. So the correction was frozen and pointed at markets that did not exist when it was chosen."
          inverted
        >
          <Experiment research={research} />
        </Section>

        <Section
          id="integrity"
          eyebrow="Research integrity"
          title="Built to avoid hindsight."
          lede="Three constraints the pipeline enforces, each of them the reason a number on this page is smaller or less certain than it could have been."
        >
          <Integrity research={research} />
        </Section>

        <div className="wrap" style={{ paddingBottom: 64, paddingTop: 8 }}>
          <a className="btn" href={hrefFor(TO_ANALYZE)} onClick={linkHandler(go, TO_ANALYZE)}>
            Analyse a price →
          </a>
        </div>
      </main>

      {footer}
    </>
  );
}
