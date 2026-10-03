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
  /** Stop admitting landowners when the last edition begins. */
  fillLand: boolean;
  /** Years landowners keep arriving, when not filling the land. */
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

/** The contract settings production fixes: every timing, the halt threshold and the edition scale. A run may change
 *  them; the setup screen shows production's value beside any that differs. */
export const TIMINGS: (keyof ContractConfig)[] = [
  "yearDays", "acceptanceDays", "watchdogDays", "backstopDays", "minAuctionDays", "reviewDays", "maxVerificationDelayDays",
  "responseDays", "panelDays", "redrawDays", "haltAfter", "editionScale",
];
/** A country's listing window (Covenant Lifecycle v5 §5: 330 days in every country). */
export const LISTING_DAYS = 330;
/** A path B country's post-sale window: no document sets it yet. */
export const POST_SALE_DAYS = 60;

/** A flow with steps after the sale holds the price in escrow until they are done: its country needs a post-sale window. */
export const recordsAfterSale = (flows: FlowDef[], flowId: number) => {
  const f = flows.find((x) => x.id === flowId);
  return !!f && f.steps.indexOf(Step.SALE) >= 0 && f.steps.indexOf(Step.SALE) < f.steps.length - 1;
};

/** The longest flow the contracts store (FlowCode.MAX_STEPS). */
export const MAX_FLOW_STEPS = 16;

/** The contracts' rules for a flow (EcoCountries._validateFlow), each broken one as a sentence. */
export function validateFlow(steps: number[]): string[] {
  const e: string[] = [];
  const name = (s: number) => ["", "the power", "the power's registration", "an agreement", "a deed", "a recording", "an attestation", "the mint", "the sale"][s] ?? `step ${s}`;
  if (steps.length < 4 || steps.length > MAX_FLOW_STEPS) e.push(`It has ${steps.length} steps; a flow has 4 to ${MAX_FLOW_STEPS}.`);
  let power = -1, mint = -1, anchored = false, deed = false;
  steps.forEach((st, i) => {
    const beforeMint = mint < 0;
    const next = steps[i + 1], prev = steps[i - 1];
    if (st === Step.MINT) {
      if (!beforeMint) e.push("It mints twice.");
      if (next !== Step.SALE) e.push("The mint must be followed at once by the sale.");
      if (power >= 0 && !anchored) e.push("The power must be registered before the mint.");
      mint = i;
    } else if (st === Step.SALE) {
      if (prev !== Step.MINT) e.push("The sale must come straight after the mint.");
    } else if (st === Step.POWER) {
      if (power >= 0) e.push("It grants the power twice.");
      if (!beforeMint) e.push("The power must come before the mint.");
      power = i;
    } else if (st === Step.POWER_ANCHOR) {
      if (power < 0) e.push("The power's registration needs the power before it.");
      else if (anchored) e.push("It registers the power twice.");
      if (!beforeMint) e.push("The power must be registered before the mint.");
      anchored = true;
    } else if (st === Step.ATTEST) {
      if (prev !== Step.AGREEMENT && prev !== Step.DEED && prev !== Step.RECORDING) e.push(`Attestation ${i + 1} attests nothing: it must follow an agreement, a deed or a recording.`);
    } else if (st === Step.AGREEMENT || st === Step.DEED || st === Step.RECORDING) {
      if (next !== Step.ATTEST) e.push(`${name(st)[0].toUpperCase()}${name(st).slice(1)} (step ${i + 1}) must be followed at once by an attestation.`);
      if (power >= 0 && !anchored) e.push("The power must be registered before any document.");
      if (st === Step.AGREEMENT && !beforeMint) e.push("An agreement must come before the mint.");
      if (st === Step.RECORDING && beforeMint) e.push("A recording comes after the sale; before the mint, use a deed.");
      if (st !== Step.AGREEMENT) deed = true;
    } else e.push(`Step ${i + 1} is not a step.`);
  });
  if (mint < 0) e.push("It never mints: a flow needs the mint, then the sale.");
  if (!deed) e.push("It records no deed or recording: the covenant needs one.");
  const last = steps[steps.length - 1];
  if (steps.length && last !== Step.SALE && last !== Step.ATTEST) e.push("It must end with the sale or an attestation.");
  return [...new Set(e)];
}

/** Puts every timing, the edition scale and each country's windows back at production; returns what it changed. */
export function toProduction(s: Scenario): string[] {
  const changed: string[] = [];
  for (const k of TIMINGS) {
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
  arrivalsPerYear: 20, fillLand: false, arrivalYears: 15, maxRequests: 0, maxTermYears: 25,
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
const make = (id: string, name: string, summary: string, b: Partial<Behaviour>, countries = COUNTRIES_V11, c: Partial<ContractConfig> = {}): Scenario => ({
  id, name, summary, contracts: { ...PRODUCTION, ...c }, countries: clone(countries), flows: clone(FLOWS), behaviour: { ...DEFAULT_BEHAVIOUR, ...b },
});
const onlyCountry = (code: number) => COUNTRIES_V11.map((c) => ({ ...c, weight: c.code === code ? 100 : 0 }));

export const SCENARIOS: Scenario[] = [
  make("fifteen", "Fifteen years of arrivals", "The batch simulation: about eight landowners a year for fifteen years, every term run to its end.",
    { arrivalYears: 15, arrivalsPerYear: 7.5 }),
  make("fill", "Until the land is full", "Landowners keep arriving until the last edition begins; then every term runs out and the programme ends. The edition thresholds are 1/500 of production's, so the land fills in a few decades.",
    { fillLand: true }, COUNTRIES_V11, { editionScale: 2000 }),
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
  make("edition-race", "Edition race", "Edition thresholds 1/3,333 of production's and many landowners: editions move between verification and mint, stranding requests.",
    { fillLand: true, arrivalsPerYear: 80 }, COUNTRIES_V11, { editionScale: 300 }),
  make("breaches", "Breaches and cancellations", "One verification in ten finds a breach; half the blocks end in cancellation, and term challenges find the land in breach.",
    { arrivalYears: 6, blockPermille: 100, cancelOfBlockPct: 50, termOutcomes: [20, 10, 10, 50, 5, 5] }),
  make("custom", "Custom", "Start from the defaults and set everything yourself.", {}),
];

export function cloneScenario(s: Scenario): Scenario {
  const c = clone(s);
  c.behaviour = { ...DEFAULT_BEHAVIOUR, ...c.behaviour }; // a file saved before a setting existed takes its default
  return c;
}

/** Problems that would make the contracts refuse the configuration, or the run meaningless. */
export function validate(s: Scenario): string[] {
  const e: string[] = [];
  const c = s.contracts;
  if (c.verifierPermille + c.taxPermille >= 1000) e.push("The verifier's share and the platform tax must leave the guardian something.");
  if (c.serverPermille >= c.taxPermille) e.push("The server fee must be less than the platform tax.");
  if (c.yearDays < 2) e.push("The protocol year must be at least 2 days.");
  if (Math.abs(c.yearDays * 86400 - Math.round(c.yearDays * 86400)) > 1e-6) e.push("The protocol year must be a whole number of seconds (365.25 days is; 365.3 is not).");
  if (c.reviewDays * 2 > c.yearDays) e.push("The review window must be shorter than half a year: a covenant re-verifies twice a year at 0.5 ha and above.");
  if (c.maxVerificationDelayDays < c.reviewDays) e.push("The maximum verification delay must be at least the review window.");
  if (c.haltAfter < 1) e.push("Releases halt after at least one unattested window.");
  if (c.editionScale < 1) e.push("The edition scale must be at least 1.");
  for (const k of ["acceptanceDays", "watchdogDays", "backstopDays", "minAuctionDays", "reviewDays", "responseDays", "panelDays", "redrawDays"] as const)
    if (!(c[k] > 0)) e.push(`${k} must be more than 0 days.`);
  const ids = new Set<number>();
  for (const f of s.flows) {
    if (ids.has(f.id)) e.push(`Flow ${f.id} appears twice.`);
    ids.add(f.id);
    if (!(f.id >= 1 && f.id <= 255)) e.push(`Flow ${f.id}: its number must be 1-255.`);
    for (const x of validateFlow(f.steps)) e.push(`Flow ${f.id} (${f.name}): ${x}`);
  }
  const codes = new Set<number>();
  for (const k of s.countries) {
    if (codes.has(k.code)) e.push(`Country ${k.code} appears twice.`);
    codes.add(k.code);
    if (!(k.code > 0 && k.code < 1000)) e.push(`${k.name}: the ISO numeric code must be 1-999.`);
    if (k.minTerm < 3 || k.maxTerm > 100 || k.minTerm > k.maxTerm) e.push(`${k.name}: terms must run within 3-100 years, minimum first.`);
    if (!s.flows.some((f) => f.id === k.flowId)) e.push(`${k.name}: flow ${k.flowId} is not defined.`);
    const f = s.flows.find((x) => x.id === k.flowId);
    if (!(k.listingDays > 0)) e.push(`${k.name}: the listing window must be more than 0 days.`);
    if (f && recordsAfterSale(s.flows, k.flowId) && k.postSaleDays <= 0) e.push(`${k.name}: its flow records after the sale, so it needs a post-sale window.`);
    if (k.holders < 1 || k.orgsPerHolder < 1 || k.verifiersPerOrg < 1) e.push(`${k.name}: needs at least one Trust Admin, organisation and verifier.`);
  }
  if (!s.countries.some((k) => k.weight > 0)) e.push("At least one country must receive arrivals.");
  return e;
}
