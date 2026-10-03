// Everything a run can be configured with: the contracts' parameters, the countries, the flows, how the actors
// behave, and when the run stops. A scenario is a named set of these.
import { Step } from "./model";

export type ContractConfig = {
  yearDays: number;
  maxVerificationDelayDays: number;
  acceptanceDays: number;
  watchdogDays: number;
  backstopDays: number;
  minAuctionDays: number;
  reviewDays: number;
  responseDays: number;
  panelDays: number;
  redrawDays: number;
  haltAfter: number;
  /** V, the default base fee, in USDT. */
  baseFee: number;
  verifierPermille: number;
  taxPermille: number;
  serverPermille: number;
  /** Land-years per F² in the edition thresholds; 1,000,000 in production. */
  editionScale: number;
};

export type FlowDef = { id: number; name: string; steps: number[] };

export type CountryConfig = {
  code: number;          // ISO 3166 numeric
  name: string;
  short: string;         // two letters, for names on screen
  flowId: number;
  minTerm: number;
  maxTerm: number;
  listingDays: number;
  postSaleDays: number;
  baseFee: number;       // USDT; 0 = the protocol default V
  attestationFee: number;
  judgmentFee: number;
  holders: number;       // Trust Admins
  orgsPerHolder: number;
  verifiersPerOrg: number;
  weight: number;        // share of arrivals
};

export type Behaviour = {
  arrivalsPerYear: number;
  /** Years landowners keep arriving. */
  arrivalYears: number;
  /** At most this many requests in all (0 = no limit). */
  maxRequests: number;
  maxTermYears: number;
  // pre-mint fates, percent of requests
  cancelPct: number;
  claimLapsePct: number;
  abandonPct: number;
  preMintChallengePct: number;
  unsoldPct: number;
  pathBLapseNothingPct: number;
  pathBLapseUnattestedPct: number;
  // each review window: an independent verifier attests, or challenges; otherwise nobody acts
  attestPct: number;
  challengePct: number;
  // what panels find, as weights: dismiss, score, documents, breach, lapse, withdraw
  preMintOutcomes: number[];
  termOutcomes: number[];
  // verifiers: percent on time (0-20 days after due), a little late (20-28), very late (40-60)
  onTimePct: number;
  littleLatePct: number;
  /** Per thousand re-verifications, the verifier blocks the covenant for a breach. */
  blockPermille: number;
  /** Percent of blocks that end in cancellation rather than an unblock. */
  cancelOfBlockPct: number;
  resalePct: number;
  payeeSwitchPermille: number;
  overcharge: boolean;
  governanceCalendar: boolean;
};

export type Scenario = {
  id: string;
  name: string;
  summary: string;
  contracts: ContractConfig;
  countries: CountryConfig[];
  flows: FlowDef[];
  behaviour: Behaviour;
};

export const FLOWS: FlowDef[] = [
  { id: 1, name: "Path A under a power", steps: [Step.POWER, Step.POWER_ANCHOR, Step.DEED, Step.ATTEST, Step.MINT, Step.SALE] },
  { id: 2, name: "Path A", steps: [Step.DEED, Step.ATTEST, Step.MINT, Step.SALE] },
  { id: 3, name: "Path B: escrow until recorded", steps: [Step.DEED, Step.ATTEST, Step.MINT, Step.SALE, Step.RECORDING, Step.ATTEST] },
];

export const PRODUCTION: ContractConfig = {
  yearDays: 365, maxVerificationDelayDays: 30, acceptanceDays: 30, watchdogDays: 14, backstopDays: 14,
  minAuctionDays: 3, reviewDays: 30, responseDays: 7, panelDays: 7, redrawDays: 7, haltAfter: 3,
  baseFee: 50, verifierPermille: 70, taxPermille: 30, serverPermille: 10, editionScale: 1_000_000,
};

/** The contract settings a run cannot change: every timing, the halt threshold and the edition scale are production's. */
export const LOCKED: (keyof ContractConfig)[] = [
  "yearDays", "acceptanceDays", "watchdogDays", "backstopDays", "minAuctionDays", "reviewDays", "maxVerificationDelayDays",
  "responseDays", "panelDays", "redrawDays", "haltAfter", "editionScale",
];
/** A country's listing window (Covenant Lifecycle v5 §5: 330 days in every country). */
export const LISTING_DAYS = 330;
/** A path B country's post-sale window: no document sets it yet. */
export const POST_SALE_DAYS = 60;

const recordsAfterSale = (flows: FlowDef[], flowId: number) => flows.find((f) => f.id === flowId)?.steps.includes(Step.RECORDING) ?? false;

/** Puts every locked setting at its production value; returns what it changed, for the person loading the file. */
export function toProduction(s: Scenario): string[] {
  const changed: string[] = [];
  for (const k of LOCKED) {
    if (s.contracts[k] !== PRODUCTION[k]) changed.push(`${k} ${s.contracts[k]} → ${PRODUCTION[k]}`);
    s.contracts[k] = PRODUCTION[k];
  }
  for (const c of s.countries) {
    const post = recordsAfterSale(s.flows, c.flowId) ? POST_SALE_DAYS : 0;
    if (c.listingDays !== LISTING_DAYS) changed.push(`${c.name} listing ${c.listingDays} → ${LISTING_DAYS} days`);
    if (c.postSaleDays !== post) changed.push(`${c.name} post-sale ${c.postSaleDays} → ${post} days`);
    c.listingDays = LISTING_DAYS;
    c.postSaleDays = post;
  }
  delete (s.behaviour as any).fillLand;
  return changed;
}

const country = (c: Partial<CountryConfig> & Pick<CountryConfig, "code" | "name" | "short" | "flowId">): CountryConfig => ({
  minTerm: 3, maxTerm: 100, listingDays: 330, postSaleDays: 0, baseFee: 0, attestationFee: 5, judgmentFee: 9,
  holders: 2, orgsPerHolder: 1, verifiersPerOrg: 2, weight: 25, ...c,
});

export const COUNTRIES_V11: CountryConfig[] = [
  country({ code: 144, name: "Sri Lanka", short: "LK", flowId: 1, maxTerm: 99, holders: 3, orgsPerHolder: 2, weight: 35 }),
  country({ code: 360, name: "Indonesia", short: "ID", flowId: 2, maxTerm: 29, weight: 20 }),
  country({ code: 392, name: "Japan", short: "JP", flowId: 2, weight: 20 }),
  country({ code: 76, name: "Brazil", short: "BR", flowId: 3, minTerm: 16, postSaleDays: 60, weight: 25 }),
];

/** Countries a user can add by ISO code, with their names. Any other code is accepted too. */
export const KNOWN_COUNTRIES: Record<number, [string, string]> = {
  144: ["Sri Lanka", "LK"], 360: ["Indonesia", "ID"], 392: ["Japan", "JP"], 76: ["Brazil", "BR"], 356: ["India", "IN"],
  36: ["Australia", "AU"], 554: ["New Zealand", "NZ"], 404: ["Kenya", "KE"], 170: ["Colombia", "CO"], 604: ["Peru", "PE"],
  458: ["Malaysia", "MY"], 608: ["Philippines", "PH"], 704: ["Viet Nam", "VN"], 764: ["Thailand", "TH"], 524: ["Nepal", "NP"],
  50: ["Bangladesh", "BD"], 566: ["Nigeria", "NG"], 710: ["South Africa", "ZA"], 840: ["United States", "US"], 826: ["United Kingdom", "GB"],
  124: ["Canada", "CA"], 484: ["Mexico", "MX"], 32: ["Argentina", "AR"], 152: ["Chile", "CL"], 218: ["Ecuador", "EC"],
};

export const DEFAULT_BEHAVIOUR: Behaviour = {
  arrivalsPerYear: 20, arrivalYears: 15, maxRequests: 0, maxTermYears: 25,
  cancelPct: 2, claimLapsePct: 2, abandonPct: 2, preMintChallengePct: 14, unsoldPct: 4,
  pathBLapseNothingPct: 8, pathBLapseUnattestedPct: 6,
  attestPct: 72, challengePct: 8,
  preMintOutcomes: [35, 20, 20, 0, 13, 12],
  termOutcomes: [45, 15, 15, 15, 5, 5],
  onTimePct: 90, littleLatePct: 7,
  blockPermille: 15, cancelOfBlockPct: 25, resalePct: 4, payeeSwitchPermille: 15,
  overcharge: true, governanceCalendar: true,
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const make = (id: string, name: string, summary: string, b: Partial<Behaviour>, countries = COUNTRIES_V11): Scenario => ({
  id, name, summary, contracts: { ...PRODUCTION }, countries: clone(countries), flows: clone(FLOWS), behaviour: { ...DEFAULT_BEHAVIOUR, ...b },
});
const onlyCountry = (code: number) => COUNTRIES_V11.map((c) => ({ ...c, weight: c.code === code ? 100 : 0 }));

export const SCENARIOS: Scenario[] = [
  make("fifteen", "Fifteen years of arrivals", "The batch simulation: about eight landowners a year for fifteen years, every term run to its end.",
    { arrivalYears: 15, arrivalsPerYear: 7.5 }),
  make("one", "One covenant, start to finish", "A single Sri Lanka request with nothing going wrong: claim, verification, power, deed, mint, sale and every re-verification of its term. Use Next action to step through it.",
    { maxRequests: 1, arrivalsPerYear: 365, cancelPct: 0, claimLapsePct: 0, abandonPct: 0, preMintChallengePct: 0, unsoldPct: 0,
      pathBLapseNothingPct: 0, pathBLapseUnattestedPct: 0, attestPct: 100, challengePct: 0, onTimePct: 100, littleLatePct: 0, blockPermille: 0,
      resalePct: 0, payeeSwitchPermille: 0, governanceCalendar: false, maxTermYears: 5 }, onlyCountry(144)),
  make("challenges", "Challenge stress", "Half of all verifications challenged before the mint and two in five review windows challenged in the term, with every outcome equally likely.",
    { arrivalYears: 6, preMintChallengePct: 50, attestPct: 40, challengePct: 40, preMintOutcomes: [1, 1, 1, 0, 1, 1], termOutcomes: [1, 1, 1, 1, 1, 1] }),
  make("holder-failure", "Trust Admin failure", "The governance calendar compressed: a Trust Admin frozen, one removed and replaced, a country suspended, a power revoked, all while covenants are in flight.",
    { arrivalYears: 8, arrivalsPerYear: 30 }),
  make("late", "Late and absent verifiers", "Verifiers late half the time and attestors rarely acting: reseats, unattested runs and release halts.",
    { arrivalYears: 8, onTimePct: 40, littleLatePct: 30, attestPct: 25, challengePct: 5 }),
  make("pathb", "Path B lapses", "Brazil only: sales held in escrow until the recording is attested, with many recordings missing or unattested.",
    { arrivalYears: 6, pathBLapseNothingPct: 30, pathBLapseUnattestedPct: 30 }, onlyCountry(76)),
  make("breaches", "Breaches and cancellations", "One verification in ten finds a breach; half the blocks end in cancellation, and term challenges find the land in breach.",
    { arrivalYears: 6, blockPermille: 100, cancelOfBlockPct: 50, termOutcomes: [20, 10, 10, 50, 5, 5] }),
  make("custom", "Custom", "Start from the defaults and set everything yourself.", {}),
];

export function cloneScenario(s: Scenario): Scenario {
  const c = clone(s);
  toProduction(c);
  return c;
}

/** Problems that would make the contracts refuse the configuration, or the run meaningless. */
export function validate(s: Scenario): string[] {
  const e: string[] = [];
  const c = s.contracts;
  if (c.verifierPermille + c.taxPermille >= 1000) e.push("The verifier's share and the platform tax must leave the guardian something.");
  if (c.serverPermille >= c.taxPermille) e.push("The server fee must be less than the platform tax.");
  for (const k of LOCKED) if (c[k] !== PRODUCTION[k]) e.push(`${k} is fixed at its production value, ${PRODUCTION[k].toLocaleString("en-US")}.`);
  const codes = new Set<number>();
  for (const k of s.countries) {
    if (codes.has(k.code)) e.push(`Country ${k.code} appears twice.`);
    codes.add(k.code);
    if (!(k.code > 0 && k.code < 1000)) e.push(`${k.name}: the ISO numeric code must be 1-999.`);
    if (k.minTerm < 3 || k.maxTerm > 100 || k.minTerm > k.maxTerm) e.push(`${k.name}: terms must run within 3-100 years, minimum first.`);
    if (!s.flows.some((f) => f.id === k.flowId)) e.push(`${k.name}: flow ${k.flowId} is not defined.`);
    const f = s.flows.find((x) => x.id === k.flowId);
    if (k.listingDays !== LISTING_DAYS) e.push(`${k.name}: the listing window is fixed at ${LISTING_DAYS} days.`);
    if (f && k.postSaleDays !== (recordsAfterSale(s.flows, k.flowId) ? POST_SALE_DAYS : 0)) e.push(`${k.name}: the post-sale window is fixed at ${recordsAfterSale(s.flows, k.flowId) ? POST_SALE_DAYS : 0} days for its flow.`);
    if (k.holders < 1 || k.orgsPerHolder < 1 || k.verifiersPerOrg < 1) e.push(`${k.name}: needs at least one Trust Admin, organisation and verifier.`);
  }
  if (!s.countries.some((k) => k.weight > 0)) e.push("At least one country must receive arrivals.");
  return e;
}
