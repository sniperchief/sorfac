// Read-only SDK config. NO private key: ClientConfig does not require one, so the
// exchange object is constructed without any signing capability at all.
import { SomniaMarkets, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";

export type EnvName = "mainnet" | "testnet";

const ENV_NAMES = ["mainnet", "testnet"] as const;

/**
 * Validate DDX_ENV rather than casting it.
 *
 * Audit fix. This used to be an unchecked `as EnvName` cast, so a typo such as
 * `DDX_ENV=Mainnet` produced an env with no indexer URL. The SDK then threw a
 * raw NotConfiguredError stack trace, and — worse — every `ENV === "mainnet"`
 * ternary below fell through to the TESTNET chain and addresses while the output
 * filenames still carried the typo'd name. A misconfigured run could therefore
 * have mixed networks silently. Now it fails immediately and says what is wrong.
 */
function resolveEnv(): EnvName {
  const raw = process.env.DDX_ENV;
  if (raw === undefined || raw === "") return "mainnet";
  if ((ENV_NAMES as readonly string[]).includes(raw)) return raw as EnvName;
  console.error(`\nERROR: DDX_ENV must be one of ${ENV_NAMES.join(" | ")}, got ${JSON.stringify(raw)}.`);
  console.error(`  Unset it to use mainnet, which is what every published result was produced on.\n`);
  process.exit(1);
}

export const ENV: EnvName = resolveEnv();

// Discovered empirically (Phase 2): prd = mainnet (USDso, 18dp),
// dev = testnet (tUSDC, 6dp). Neither is published in the SDK dist.
const INDEXERS: Record<EnvName, string> = {
  mainnet: "https://prd.smk.somnia.host/v1/graphql",
  testnet: "https://dev.smk.somnia.host/v1/graphql",
};

export const INDEXER_URL = process.env.DDX_INDEXER ?? INDEXERS[ENV];

// An overridden indexer can point anywhere, so never let that pass unannounced:
// provenance has to be obvious when someone is watching a demo.
if (process.env.DDX_INDEXER) {
  console.warn(`WARNING: DDX_INDEXER overrides the ${ENV} endpoint -> ${INDEXER_URL}`);
}

export const exchange = new SomniaMarkets({
  chain: ENV === "mainnet" ? somniaMainnet : somniaShannon,
  addresses: ENV === "mainnet" ? SOMNIA_MAINNET_ADDRESSES : SOMNIA_TESTNET_ADDRESSES,
  indexerUrl: INDEXER_URL,
});

export const client = exchange.client;

export const ORACLE_BASE = "https://prd.oracle.somnia.host";

export const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
