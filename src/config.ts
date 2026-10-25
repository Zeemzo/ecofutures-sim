// Everything a run can be configured with: the contracts' parameters, the countries, the flows, how the actors
// behave, and when the run stops. A scenario is a named set of these.
import { Step } from "./model";

export type ContractConfig = {
  yearDays: number;
  /** The grace after a re-verification falls due (decided 9 Oct: 14 days). */
  maxVerificationDelayDays: number;
  acceptanceDays: number;
  watchdogDays: number;
  minAuctionDays: number;
  /** The winner of an auction passes its identity check within this, or the sale is called off. */
  kycDays: number;
  reviewDays: number;
  responseDays: number;
  panelDays: number;
  redrawDays: number;
  haltAfter: number;
  // the paper flow (EcoDeeds): the power, anchoring and attestation clocks, the Holder's 3 days to decide an
  // extension, a GTA's backstop and the landowner's own anchoring
  powerDays: number;
  anchoringDays: number;
  attestationDays: number;
  decisionDays: number;
  gtaAttestFromDays: number;
  guardianAnchorFromDays: number;
  // the term (Core) and the parties (EcoParties)
  restoreDays: number;
  damageDays: number;
  firstClaimDays: number;
  reseatDays: number;
  accessionDays: number;
  /** V, the default base fee, in USDT. */
  baseFee: number;
  verifierPermille: number;
  taxPermille: number;
  /** The Foundation's fee wallet: its share of each instalment. */
  foundationPermille: number;
  /** Square-metre-years per F² in an edition: 10,000,000 in production (1,000 hectare-years; TR3 Model 4). */
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
  /** V, the one fee lever (TR3 Model 4 §11), USDT; 0 = the protocol default (USD 30), never below the Council's Vmin. */
  baseFee: number;
  /** Fees 3-5 (TR3 Model B item 16, 20 Oct), USDT, paid upfront with the others and each paid out once its step is
   *  done: the power's registration to the Holder (only where the flow has a power), the agreement's to the verifier
   *  (only where it has an agreement to grant), and the covenant's -- fixed plus per hectare -- to the verifier at the
   *  flow's last attestation. What a request does not use goes back to the landowner when it ends. */
  powerFee: number;
  agreementFee: number;
  registrationFixed: number;
  registrationPerHa: number;
  /** The simulated landowners' plots: most near the typical size, one in a hundred as large as the largest
   *  (log-normal), none below a tenth of the typical, and never above what the open edition allows. */
  typicalHa: number;
  largestHa: number;
  /** What patrons pay for a covenant, in USDT a hectare a year of its term (never below the protocol's floor). */
  valuePerHaYear: number;
  holders: number;       // Trust Admins
  orgsPerHolder: number;
  verifiersPerOrg: number;
  weight: number;        // share of arrivals
};

export type Behaviour = {
  /** Percent of requests whose landowner refuses to sign the Deed (the verifier keeps its fee). */
  refusePct: number;
  /** Percent of auction winners who have not passed the identity check when they win; of those, how many fail. */
  kycLatePct: number;
  kycFailPct: number;
  /** Per thousand verifications, the land is sold (the buyer accedes, or not, to the Grantor Agreement). */
  landSalePermille: number;
  accedePct: number;
  /** Percent of gem owners who use their stones each month (TR3 Model 4 §7-8): set into a new land they own, or fused. */
  gemUsePct: number;
  arrivalsPerYear: number;
  /** Stop admitting landowners when the last edition begins. */
  fillLand: boolean;
  /** Plots drawn up to the largest the open edition allows, so they grow with the editions, instead of from each
   *  country's typical and largest plot. Only to fill all 32 editions in a run. */
  landGrowsWithEditions: boolean;
  /** Years landowners keep arriving, when not filling the land. */
  arrivalYears: number;
  /** At most this many requests in all (0 = no limit). */
  maxRequests: number;
  maxTermYears: number;
  // pre-mint fates, percent of requests
  cancelPct: number;
  claimLapsePct: number;
  /** Percent of requests no verifier claims: after the acceptance window a Trust Admin assigns one (V12.1, rule 3). */
  unclaimedPct: number;
  /** Percent the claiming verifier rejects: no land, or no valid title (V12.1, rule 4). */
  rejectPct: number;
  abandonPct: number;
  preMintChallengePct: number;
  unsoldPct: number;
  pathBLapseNothingPct: number;
  pathBLapseUnattestedPct: number;
  // each review window: an independent verifier attests, or challenges; otherwise nobody acts
  attestPct: number;
  challengePct: number;
  // what panels find, as weights: dismiss, uphold, lapse, withdraw
  preMintOutcomes: number[];
  termOutcomes: number[];
  /** Which option a term challenge raises, as weights: 3A, 3B, 3C, 3D. */
  termOptions: number[];
  // verifiers: percent on time (0-20 days after due), a little late (20-28), very late (40-60)
  onTimePct: number;
  littleLatePct: number;
  /** Per thousand re-verifications, the verifier blocks the covenant for a breach. */
  blockPermille: number;
  /** Of blocks before the sale, percent cancelled rather than unblocked. In the term a breach is never cancelled
   *  (FM P7): the verifier cures it by re-verifying, or the landowner challenges the block (3E). */
  cancelOfBlockPct: number;
  /** Of blocks in the term, percent the landowner challenges as wrong (3E). */
  wrongBlockPct: number;
  /** Of breach blocks in the term, percent where the covenant's Holder files its cost of making good (FM v29 P7): set
   *  off against the consideration after the cure, void after an upheld 3E. Default 40. */
  enforcementPct?: number;
  /** Of Deeds awaiting attestation, percent the registry refuses: the verifier records a corrected Deed and the Holder
   *  draws the second signing from the verifier's unpaid fee (FM v29 P2). Default 4. */
  correctionPct?: number;
  resalePct: number;
  /** Of the times the EFT's owner sees TR3 waiting in its pool, percent it claims; otherwise the pool grows, and a
   *  sale passes it to the buyer (R, 14 Oct). Every last owner claims at the End Date. */
  patronClaimPct: number;
  /** Every holder claims its TR3 every this many days, as it accrues, so it is minted then: the landowner its own and
   *  its referrer's share, the EFT's owner the patron's. 1 is every 24 hours (Azeem, 20 Oct); 0 leaves the claims to
   *  re-verifications, the yearly round and the End Date (patronClaimPct). */
  claimDays: number;
  payeeSwitchPermille: number;
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
  // the power, granted and registered, is one step: the Holder records it once registered (the team's call, 20 Oct)
  { id: 1, name: "Path A under a power", steps: [Step.POWER, Step.DEED, Step.ATTEST, Step.MINT, Step.SALE] },
  { id: 2, name: "Path A", steps: [Step.DEED, Step.ATTEST, Step.MINT, Step.SALE] },
  // path B as FM v29 has it (13 Oct): no power; the agreement to grant recorded, not attested, before the mint; the
  // Deed recorded after the sale and attested
  { id: 3, name: "Path B: escrow until recorded", steps: [Step.AGREEMENT, Step.MINT, Step.SALE, Step.RECORDING, Step.ATTEST] },
];

export const PRODUCTION: ContractConfig = {
  yearDays: 365, maxVerificationDelayDays: 14, acceptanceDays: 30, watchdogDays: 21, minAuctionDays: 3, kycDays: 1,
  reviewDays: 30, responseDays: 7, panelDays: 7, redrawDays: 7, haltAfter: 3,
  powerDays: 30, anchoringDays: 14, attestationDays: 30, decisionDays: 3, gtaAttestFromDays: 21, guardianAnchorFromDays: 7,
  restoreDays: 60, damageDays: 14, firstClaimDays: 3, reseatDays: 30, accessionDays: 180,
  baseFee: 30, verifierPermille: 70, taxPermille: 30, foundationPermille: 10, editionScale: 10_000_000,
};

/** The contract settings production fixes: every timing, the halt threshold and the edition scale. A run may change
 *  them; the setup screen shows production's value beside any that differs. */
export const TIMINGS: (keyof ContractConfig)[] = [
  "yearDays", "acceptanceDays", "watchdogDays", "minAuctionDays", "kycDays", "reviewDays", "maxVerificationDelayDays",
  "responseDays", "panelDays", "redrawDays", "haltAfter", "powerDays", "anchoringDays", "attestationDays", "decisionDays",
  "gtaAttestFromDays", "guardianAnchorFromDays", "restoreDays", "damageDays", "firstClaimDays", "reseatDays",
  "accessionDays", "editionScale",
];
/** A country's listing window (Flow Map v25: 358 days). */
export const LISTING_DAYS = 358;
/** A path B country's recording window: 30 days from the sale (Flow Map v25, p5). */
export const POST_SALE_DAYS = 30;

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
  let power = -1, mint = -1, deed = false;
  steps.forEach((st, i) => {
    const beforeMint = mint < 0;
    const next = steps[i + 1], prev = steps[i - 1];
    if (st === Step.MINT) {
      if (!beforeMint) e.push("It mints twice.");
      if (next !== Step.SALE) e.push("The mint must be followed at once by the sale.");
      mint = i;
    } else if (st === Step.SALE) {
      if (prev !== Step.MINT) e.push("The sale must come straight after the mint.");
    } else if (st === Step.POWER) {
      if (power >= 0) e.push("It grants the power twice.");
      if (!beforeMint) e.push("The power must come before the mint.");
      power = i;
    } else if (st === Step.POWER_ANCHOR) {
      e.push("The power's registration is no longer a step of its own: the Holder records the power once registered (20 Oct).");
    } else if (st === Step.ATTEST) {
      if (prev !== Step.AGREEMENT && prev !== Step.DEED && prev !== Step.RECORDING) e.push(`Attestation ${i + 1} attests nothing: it must follow an agreement, a deed or a recording.`);
    } else if (st === Step.AGREEMENT || st === Step.DEED || st === Step.RECORDING) {
      // flow B's agreement to grant is recorded, not attested: it may go straight to the mint (FM v29)
      if (next !== Step.ATTEST && !(st === Step.AGREEMENT && next === Step.MINT)) e.push(`${name(st)[0].toUpperCase()}${name(st).slice(1)} (step ${i + 1}) must be followed at once by an attestation${st === Step.AGREEMENT ? " or the mint" : ""}.`);
      if (st === Step.AGREEMENT && next === Step.MINT && power >= 0) e.push("Under a power, the agreement must be attested before the mint.");
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
  // fees 3-5 until counsel's figures are in (O1): USD 20 for the power's registration and for the agreement's, and for
  // the covenant's USD 30 (the notary and the registry) plus Sri Lanka's LC5 duty, 2 % of a USD 100/ha stated rental
  minTerm: 3, maxTerm: 99, listingDays: LISTING_DAYS, postSaleDays: 0, baseFee: 0,
  powerFee: 20, agreementFee: 20, registrationFixed: 30, registrationPerHa: 2,
  typicalHa: 10, largestHa: 500, valuePerHaYear: 50,
  holders: 2, orgsPerHolder: 1, verifiersPerOrg: 2, weight: 25, ...c,
});

export const COUNTRIES_V12: CountryConfig[] = [
  // plot sizes and values per hectare-year are placeholders until Ravi's figures are in (12 Oct)
  country({ code: 144, name: "Sri Lanka", short: "LK", flowId: 1, maxTerm: 99, holders: 3, orgsPerHolder: 2, weight: 35, typicalHa: 4, largestHa: 200, valuePerHaYear: 60 }),
  country({ code: 360, name: "Indonesia", short: "ID", flowId: 1, maxTerm: 27, weight: 20, typicalHa: 15, largestHa: 2_000, valuePerHaYear: 30 }),
  country({ code: 392, name: "Japan", short: "JP", flowId: 2, weight: 20, typicalHa: 3, largestHa: 150, valuePerHaYear: 80 }),
  country({ code: 76, name: "Brazil", short: "BR", flowId: 3, minTerm: 18, postSaleDays: POST_SALE_DAYS, weight: 25, typicalHa: 80, largestHa: 10_000, valuePerHaYear: 15 }),
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
  refusePct: 2, kycLatePct: 10, kycFailPct: 20, landSalePermille: 10, accedePct: 80, gemUsePct: 50,
  termOptions: [15, 35, 20, 30], wrongBlockPct: 25,
  arrivalsPerYear: 20, fillLand: false, landGrowsWithEditions: false, arrivalYears: 15, maxRequests: 0, maxTermYears: 24,
  cancelPct: 2, claimLapsePct: 2, unclaimedPct: 3, rejectPct: 1, abandonPct: 2, preMintChallengePct: 14, unsoldPct: 4,
  pathBLapseNothingPct: 8, pathBLapseUnattestedPct: 6,
  attestPct: 72, challengePct: 8,
  preMintOutcomes: [45, 30, 13, 12],
  termOutcomes: [50, 35, 8, 7],
  onTimePct: 90, littleLatePct: 7,
  blockPermille: 15, cancelOfBlockPct: 25, resalePct: 4, patronClaimPct: 60, claimDays: 1, payeeSwitchPermille: 15,
  governanceCalendar: true,
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const make = (id: string, name: string, summary: string, b: Partial<Behaviour>, countries = COUNTRIES_V12, c: Partial<ContractConfig> = {}): Scenario => ({
  id, name, summary, contracts: { ...PRODUCTION, ...c }, countries: clone(countries), flows: clone(FLOWS), behaviour: { ...DEFAULT_BEHAVIOUR, ...b },
});
const onlyCountry = (code: number) => COUNTRIES_V12.map((c) => ({ ...c, weight: c.code === code ? 100 : 0 }));

export const SCENARIOS: Scenario[] = [
  make("fifteen", "Fifteen years of arrivals", "The batch simulation: about eight landowners a year for fifteen years, every term run to its end.",
    { arrivalYears: 15, arrivalsPerYear: 7.5 }),
  make("fill", "Until Edition 32 fills", "Landowners keep arriving until all 32 editions are placed -- 320,000,000 TR3 -- and no land enters again; then every term runs out. Editions are 1/1,000 of production's size, so they fill in a few decades. Plots grow with the editions, up to the largest each allows, so that 32 editions can fill: real plots are far smaller (see the Countries tab). Each land takes a large share of these small editions, and many reach the 1,000,000 TR3 title limit; a land over the open edition's limit waits for the first edition that takes it.",
    { fillLand: true, landGrowsWithEditions: true, arrivalsPerYear: 30 }, COUNTRIES_V12, { editionScale: 10_000 }),
  make("good-day", "A good day, every edition", "Nothing goes wrong: no challenges, cancellations or lapses, verifiers on time, every review window attested, every EFT sold. Landowners arrive until all 32 editions have filled. Editions are 1/5,000 of production's size, so they fill in a few years. Plots grow with the editions, up to the largest each allows, so that 32 editions can fill: real plots are far smaller (see the Countries tab). Each land takes a large share of these small editions, and many reach the 1,000,000 TR3 title limit.",
    { fillLand: true, landGrowsWithEditions: true, arrivalsPerYear: 40, cancelPct: 0, claimLapsePct: 0, unclaimedPct: 0, rejectPct: 0, abandonPct: 0, preMintChallengePct: 0, unsoldPct: 0,
      pathBLapseNothingPct: 0, pathBLapseUnattestedPct: 0, attestPct: 100, challengePct: 0, onTimePct: 100, littleLatePct: 0,
      blockPermille: 0, governanceCalendar: false, refusePct: 0, kycLatePct: 0, landSalePermille: 0 }, COUNTRIES_V12, { editionScale: 2_000 }),
  make("slow-uptake", "Slow uptake", "Production editions and only three landowners a year for thirty years. No edition closes on time: Edition 1 stays open at its reward, however long it takes to fill.",
    { arrivalsPerYear: 3, arrivalYears: 30 }),
  make("one", "One covenant, start to finish", "A single Sri Lanka request with nothing going wrong: claim, verification, power, deed, mint, sale and every re-verification of its term. Use Next action to step through it.",
    { maxRequests: 1, arrivalsPerYear: 365, cancelPct: 0, claimLapsePct: 0, unclaimedPct: 0, rejectPct: 0, abandonPct: 0, preMintChallengePct: 0, unsoldPct: 0,
      pathBLapseNothingPct: 0, pathBLapseUnattestedPct: 0, attestPct: 100, challengePct: 0, onTimePct: 100, littleLatePct: 0, blockPermille: 0,
      resalePct: 0, payeeSwitchPermille: 0, governanceCalendar: false, maxTermYears: 3, refusePct: 0, kycLatePct: 0, landSalePermille: 0 }, onlyCountry(144)),
  make("challenges", "Challenge stress", "Half of all verifications challenged before the mint and two in five review windows challenged in the term, with every outcome equally likely.",
    { arrivalYears: 6, preMintChallengePct: 50, attestPct: 40, challengePct: 40, preMintOutcomes: [1, 1, 1, 1], termOutcomes: [1, 1, 1, 1], termOptions: [1, 1, 1, 1] }),
  make("holder-failure", "Trust Admin failure", "The governance calendar compressed: a Trust Admin frozen, one removed and replaced, a country suspended, a power revoked, all while covenants are in flight.",
    { arrivalYears: 8, arrivalsPerYear: 30 }),
  make("late", "Late and absent verifiers", "Verifiers late half the time and attestors rarely acting: reseats, unattested runs and release halts.",
    { arrivalYears: 8, onTimePct: 40, littleLatePct: 30, attestPct: 25, challengePct: 5 }),
  make("pathb", "Path B lapses", "Brazil only: sales held in escrow until the recording is attested, with many recordings missing or unattested.",
    { arrivalYears: 6, pathBLapseNothingPct: 30, pathBLapseUnattestedPct: 30 }, onlyCountry(76)),
  make("edition-race", "Edition race", "Editions 1/5,000 of production's size and many landowners: editions fill within months. Lands are placed in turn; a land needing more than the room left straddles into the next edition, which opens, and room returned goes to the open edition for the next land in turn. Plots grow with the editions, up to the largest each allows, so that 32 editions can fill: real plots are far smaller (see the Countries tab).",
    { fillLand: true, landGrowsWithEditions: true, arrivalsPerYear: 80 }, COUNTRIES_V12, { editionScale: 2_000 }),
  make("breaches", "Breaches and cancellations", "One verification in ten finds a breach; half the blocks before a sale end in cancellation, and term challenges mostly allege the landowner's breach (3D).",
    { arrivalYears: 6, blockPermille: 100, cancelOfBlockPct: 50, termOutcomes: [30, 60, 5, 5], termOptions: [5, 15, 10, 70] }),
  make("custom", "Custom", "Start from the defaults and set everything yourself.", {}),
];

export function cloneScenario(s: Scenario): Scenario {
  const c = clone(s);
  // settings saved by an earlier version (a file, or the app's own memory of the last setup) take the default for
  // anything added since: a 1.x country has no allowance, and a missing number reached the deploy as undefined
  c.behaviour = { ...DEFAULT_BEHAVIOUR, ...c.behaviour };
  // the Relics' use became the gems' (TR3 Model 4)
  const old = c.behaviour as any;
  if (old.relicUsePct !== undefined) { if (old.gemUsePct === undefined) old.gemUsePct = old.relicUsePct; delete old.relicUsePct; }
  // a term is 3, 6 ... 99 years (Model 4 §2.8): a saved setup's longest term rounds down to one
  c.behaviour.maxTermYears = Math.max(3, c.behaviour.maxTermYears - (c.behaviour.maxTermYears % 3));
  c.contracts = { ...PRODUCTION, ...c.contracts };
  c.countries = (c.countries ?? []).map((k: any) => {
    // before 20 Oct a country had an execution allowance, fixed + per hectare: it carries over as fee 5's (item 16)
    // and before TR3 Model 4 (25 Oct) a country set D and W: V is the one lever now
    const { allowanceFixed, allowancePerHa, deskRate, fieldRate, ...rest } = k;
    const was = allowanceFixed === undefined ? {} : { registrationFixed: allowanceFixed, registrationPerHa: allowancePerHa ?? 0 };
    const k2 = country({ ...was, ...rest });
    k2.maxTerm = Math.min(k2.maxTerm, 99); // terms end at 99 years (Model 4 §2.8)
    return k2;
  });
  if (!c.flows?.length) c.flows = clone(FLOWS);
  // and a flow under a power listed its registration as a step of its own: it is part of the power now (20 Oct)
  c.flows = c.flows.map((f) => ({ ...f, steps: f.steps.filter((x) => x !== Step.POWER_ANCHOR) }));
  return c;
}

/** Problems that would make the contracts refuse the configuration, or the run meaningless. */
export function validate(s: Scenario): string[] {
  const e: string[] = [];
  const c = s.contracts;
  if (c.verifierPermille + c.taxPermille >= 1000) e.push("The verifier's share and the platform tax must leave the guardian something.");
  if (c.foundationPermille >= c.taxPermille) e.push("The Foundation's share must be less than the platform tax.");
  if (c.yearDays < 2) e.push("The protocol year must be at least 2 days.");
  if (Math.abs(c.yearDays * 86400 - Math.round(c.yearDays * 86400)) > 1e-6) e.push("The protocol year must be a whole number of seconds (365.25 days is; 365.3 is not).");
  if (c.reviewDays * 2 > c.yearDays) e.push("The review window must be shorter than half a year: a covenant re-verifies twice a year at 0.5 ha and above.");
  if (c.haltAfter < 1) e.push("Releases halt after at least one unattested window.");
  if (c.editionScale < 1) e.push("The edition scale must be at least 1.");
  for (const k of ["acceptanceDays", "watchdogDays", "minAuctionDays", "kycDays", "reviewDays", "responseDays", "panelDays", "redrawDays",
    "powerDays", "anchoringDays", "attestationDays", "decisionDays", "restoreDays", "damageDays", "firstClaimDays", "reseatDays", "accessionDays"] as const)
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
    for (const f of ["flowId", "minTerm", "maxTerm", "listingDays", "postSaleDays", "baseFee", "powerFee", "agreementFee", "registrationFixed", "registrationPerHa", "typicalHa", "largestHa", "valuePerHaYear", "holders", "orgsPerHolder", "verifiersPerOrg", "weight"] as const)
      if (!Number.isFinite(k[f]) || k[f] < 0) e.push(`${k.name}: ${f} must be a number, 0 or more.`);
    if (!(k.typicalHa >= 0.01 && k.largestHa >= k.typicalHa)) e.push(`${k.name}: the typical plot must be at least 0.01 ha, and the largest at least the typical.`);
    if (k.minTerm < 3 || k.maxTerm > 99 || k.minTerm > k.maxTerm) e.push(`${k.name}: terms must run within 3-99 years, minimum first.`);
    else if (Math.ceil(k.minTerm / 3) * 3 > k.maxTerm) e.push(`${k.name}: a term is 3, 6 ... 99 years, and none lies within ${k.minTerm}-${k.maxTerm}.`);
    if (!s.flows.some((f) => f.id === k.flowId)) e.push(`${k.name}: flow ${k.flowId} is not defined.`);
    const f = s.flows.find((x) => x.id === k.flowId);
    if (!(k.listingDays > 0 && k.listingDays <= 364)) e.push(`${k.name}: the listing window must be 1-364 days (a sale must leave the winner's identity check inside the Deed's 365 days).`);
    if (f && recordsAfterSale(s.flows, k.flowId) && k.postSaleDays <= 0) e.push(`${k.name}: its flow records after the sale, so it needs a post-sale window.`);
    if (k.holders < 1 || k.orgsPerHolder < 1 || k.verifiersPerOrg < 1) e.push(`${k.name}: needs at least one Trust Admin, organisation and verifier.`);
    if (k.holders * k.orgsPerHolder < 2) e.push(`${k.name}: needs two verifier organisations before its first verification (Flow Map p6).`);
  }
  if (!s.countries.some((k) => k.weight > 0)) e.push("At least one country must receive arrivals.");
  // the Council's Vmin is the default V at launch: no country's V may be below it (TR3 Model 4 §11)
  for (const k of s.countries) if (k.baseFee !== 0 && k.baseFee < c.baseFee) e.push(`${k.name}: its V (${k.baseFee}) is below the default V (${c.baseFee}), the Council's Vmin at launch; the country vote would revert.`);
  if (!(Number.isInteger(s.behaviour.claimDays) && s.behaviour.claimDays >= 0)) e.push("TR3 claims: a whole number of days, 0 or more.");
  return e;
}
