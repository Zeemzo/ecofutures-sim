// The ecosystem's actors. Each tick, everyone whose next move is due makes it, as a real transaction on the
// local chain. Who the actors are, how often each thing happens and which governance the programme meets all
// come from the run's scenario (config.ts). The rules they act under are V12's: the Covenant Flow Map v25.
import { encodeAbiParameters, keccak256, maxUint256, zeroAddress, getAddress, type Address } from "viem";
import { read, send, labelAddress, fund, addr, bulk, abis, type Key } from "./chain";
import {
  DAY, YEAR, RequestStatus, Step, CovenantStatus, BlockReason, ChallengeState, Option, OptionName, Holds, Action,
  Outcome, OutcomeName, Agreement, COMPLETED, register, nameOf, countryName,
} from "./model";
import type { Scenario, Behaviour, CountryConfig } from "./config";
import { Control } from "./control";

const N = (x: unknown) => Number(x);
const enc = (types: string[], values: unknown[]) =>
  encodeAbiParameters(types.map((type) => ({ type })), values as any);
const h = (...parts: (string | number | bigint)[]) =>
  keccak256(enc(parts.map((p) => (typeof p === "string" ? "string" : "uint256")), parts.map((p) => (typeof p === "number" ? BigInt(p) : p))));

export const LAST_EDITION = 21;

// pre-mint fates
const F = {
  NORMAL: 0, CANCEL: 1, CLAIM_LAPSE: 2, ABANDON: 3, CHALLENGE: 4, UNSOLD: 5, LAPSE_NOTHING: 6, LAPSE_UNATTESTED: 7,
  REFUSE: 8,
};

export type Note = { t: number; rid: number; kind: string; text: string };
export type Anomaly = { t: number; label: string; rid: number; error: string };

/** A small seeded generator, so a run can be replayed. */
class Rng {
  private s: number;
  get state() { return this.s; }
  set state(v: number) { this.s = v; }
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(n: number): number {
    if (n <= 0) return 0;
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  }
}

/** The organisation ids a country's cast uses: unique across countries, and apart from the Trust Admins' own. */
const holderOrg = (c: number, i: number) => 1_000_000 + c * 100 + i;
const verifierOrg = (c: number, i: number, o: number) => 2_000_000 + c * 1000 + i * 10 + o;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export type EngineState = { fields: Record<string, unknown>; rng: number };

export class Engine {
  now = 0;
  start = 0;
  rng: Rng;
  actions = 0;
  /** Transactions each address has sent (the platform's per-wallet count). */
  txBy = new Map<string, number>();
  anomalies: Anomaly[] = [];
  /** What the person at the screen has taken over: those steps wait for them instead of being sent. */
  control = new Control();
  notes: Note[] = [];
  kinds: Record<string, number> = {};
  onNote: (n: Note) => void = () => {};

  sc: Scenario;
  b: Behaviour;
  private acceptance: number;
  private watchdog: number;
  private response: number;
  private review: number;
  private grace: number;
  private pathB = new Set<number>(); // countries whose flow records after the sale

  // the cast
  foundation = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  server = labelAddress("server");
  emergency = labelAddress("emergency");
  feeWallet = labelAddress("foundationWallet");
  gtas: Address[] = [];
  patrons: Address[] = [];
  holders: Record<string, Address> = {};
  /** Each country's Trust Admins, in order of admission. */
  countryHolders = new Map<number, Address[]>();
  countryVerifiers = new Map<number, Address[]>();
  private guardianNonce = 0;
  private recruits = 0;
  private strangers = 0;

  // per request
  requests: number[] = [];
  /** Each request's country, from its creation. */
  countryOf: Record<number, number> = {};
  nextAt = new Map<number, number>();
  done = new Set<number>();
  fate = new Map<number, number>();
  submitAt = new Map<number, number>();
  /** When the document of the step now due is to be recorded (an extension asked moves it past the deadline). */
  stepPlan = new Map<number, number>();
  extended = new Set<number>();
  listings = new Map<number, number>();
  priceOf = new Map<number, bigint>();
  /** A winner who has not passed the identity check: whether it will pass. */
  kycOutcome = new Map<bigint, boolean>();
  windowSeen = new Map<bigint, number>();
  windowPlan = new Map<bigint, number>();
  windowActAt = new Map<bigint, number>();
  verifyAt = new Map<bigint, number>();
  planFor = new Map<bigint, number>();
  blockPlan = new Map<bigint, { at: number; how: number }>();
  yearlyAt = new Map<bigint, number>();
  landSaleAt = new Map<bigint, number>();
  openChallenges: bigint[] = [];
  plan = new Map<bigint, number>();
  challengeOf = new Map<bigint, number>();
  /** Relics waiting for their owner to use them. */
  relics: { id: bigint; owner: Address; edition: number }[] = [];
  relicPass = 0;

  // the calendar
  nextArrival = 0;
  nextChallengePass = 0;
  revokeDone = false;
  unfreezeAt = 0;
  unfreezeHolder: Address = zeroAddress;
  govStage = 0;
  emergencyEndAt = 0;
  emergencyHolder: Address = zeroAddress;
  feeSplitAt = 0;
  private frozenForReplacement: Address = zeroAddress;
  private added: Address = zeroAddress;
  private suspended = 0;

  reserveFinalized = false;

  /** The last edition has begun: the land the editions schedule is taken, and arrivals stop. */
  landFull = false;
  landFullAt = 0;

  constructor(seed: number, scenario: Scenario) {
    this.rng = new Rng(seed);
    this.sc = scenario;
    this.b = scenario.behaviour;
    const k = scenario.contracts;
    this.acceptance = k.acceptanceDays * DAY;
    this.watchdog = k.watchdogDays * DAY;
    this.response = k.responseDays * DAY;
    this.review = k.reviewDays * DAY;
    this.grace = k.maxVerificationDelayDays * DAY;
    for (const c of scenario.countries) {
      const f = scenario.flows.find((x) => x.id === c.flowId);
      if (f && f.steps[f.steps.length - 1] !== Step.SALE) this.pathB.add(c.code);
    }
  }

  /** Arrivals have stopped and every request has run its course: the programme is over. */
  get finished(): boolean {
    const allDone = this.requests.length > 0 && this.arrivalsOver() && this.done.size === this.requests.length;
    // a run that fills the editions ends with the programme: the Reserve finalised once the last edition has closed
    return allDone && (!this.landFull || this.reserveFinalized);
  }

  arrivalsOver(): boolean {
    // a landowner's request waiting for the person counts: it is theirs to make, not another arrival's
    const waiting = [...this.control.moves.values()].filter((m) => m.fn === "requestVerification").length;
    if (this.b.maxRequests > 0 && this.requests.length + waiting >= this.b.maxRequests) return true;
    return this.b.fillLand ? this.landFull : this.now >= this.start + this.b.arrivalYears * YEAR;
  }

  rand(n: number) { return this.rng.next(n); }
  chance(pct: number) { return this.rand(10_000) < pct * 100; }

  /** Everything the actors know and plan, to return to later (with the chain's own snapshot of the same moment). */
  capture(): EngineState {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this)) {
      if (typeof v === "function" || k === "b" || k === "rng" || k === "volatile" || k === "preReq" || k === "preTerm" || k === "control") continue;
      fields[k] = v;
    }
    return { fields: structuredClone(fields), rng: this.rng.state };
  }

  restore(x: EngineState) {
    Object.assign(this, structuredClone(x.fields));
    this.b = this.sc.behaviour;
    this.rng.state = x.rng;
    this.volatile.clear();
    this.preReq.clear();
    this.preTerm.clear();
  }

  /** An index drawn with the given weights. */
  pick(weights: number[]): number {
    const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
    if (total <= 0) return 0;
    let r = this.rand(1_000_000) / 1_000_000 * total;
    for (let i = 0; i < weights.length; i++) { r -= Math.max(0, weights[i]); if (r < 0) return i; }
    return weights.length - 1;
  }

  // Reads the actors repeat constantly. Who a verifier's Trust Admin and organisation are changes only through
  // Admin or the Council; standing and freezes change with any verdict. The first are kept until Admin or
  // Governance is written to, the second until anything is.
  private stable = new Map<string, unknown>();
  private volatile = new Map<string, unknown>();
  private static STABLE = new Set(["holderOf", "orgOf", "verifierCountry", "holderCountry"]);
  private static VOLATILE = new Set(["inStanding", "takesWork", "isActiveHolder", "isFrozen", "getGTAs", "independentOf"]);

  async q<T = any>(c: Key, fn: string, args: readonly unknown[] = []): Promise<T> {
    const memo = Engine.STABLE.has(fn) ? this.stable : Engine.VOLATILE.has(fn) ? this.volatile : null;
    if (!memo) return read<T>(c, fn, args);
    const k = `${c}.${fn}(${args.join(",")})`;
    if (memo.has(k)) return memo.get(k) as T;
    const v = await read<T>(c, fn, args);
    memo.set(k, v);
    return v;
  }

  private wrote(c: Key) {
    this.volatile.clear();
    if (c === "admin" || c === "governance") this.stable.clear();
  }

  note(kind: string, rid: number, text: string) {
    this.kinds[kind] = (this.kinds[kind] ?? 0) + 1;
    const n = { t: this.now, rid, kind, text };
    this.notes.push(n);
    this.onNote(n);
  }

  /** Act as `who`. A revert the simulation did not plan for is recorded, not hidden. */
  async act(who: Address, c: Key, fn: string, args: readonly unknown[], label: string, rid = 0): Promise<boolean> {
    if (this.yours(who, c, fn, args, label, rid)) return false;
    this.actions++;
    const r = await send(who, c, fn, args);
    if (!r.ok) this.anomalies.push({ t: this.now, label, rid, error: r.error });
    else this.wrote(c);
    return r.ok;
  }

  /** A call whose failure is expected and harmless (a panel member who already voted, an extra approval). */
  async attempt(who: Address, c: Key, fn: string, args: readonly unknown[], rid = 0): Promise<boolean> {
    if (this.yours(who, c, fn, args, fn, rid)) return false;
    this.actions++;
    const ok = (await send(who, c, fn, args)).ok;
    if (ok) this.wrote(c);
    return ok;
  }

  /** A Council action: proposed (and typed) by one GTA, approved by the others until a majority of the seats has
   *  approved. A GTA the action names (a removal) neither proposes nor approves. */
  async vote(action: number, types: string[], values: unknown[], label: string, rid = 0): Promise<boolean> {
    const payload = enc(types, values);
    const gtas = (await this.q<Address[]>("governance", "getGTAs")).map((a) => getAddress(a));
    const named = action === Action.REMOVE_GTA ? getAddress(values[0] as Address) : null;
    let pid = 0n;
    for (const g of gtas) {
      if (g === named) continue;
      if (pid === 0n) {
        pid = await read<bigint>("governance", "nextProposalId");
        if (!(await this.act(g, "governance", "propose", [action, payload], `propose ${label}`, rid))) return false;
      } else {
        const [approvals, needed] = await read<[bigint, bigint]>("governance", "approvalsOf", [pid]);
        if (approvals >= needed) break;
        await this.attempt(g, "governance", "approve", [pid]);
      }
    }
    return this.act(gtas[0] === named ? gtas[1] : gtas[0], "governance", "execute", [pid], label, rid);
  }

  // =====================================================================================
  // The cast
  // =====================================================================================

  async setup(progress: (msg: string) => void = () => {}): Promise<void> {
    for (const [a, n, r] of [
      [this.foundation, "Foundation", "foundation"], [this.server, "Server", "server"],
      [this.emergency, "Emergency multisig", "foundation"], [this.feeWallet, "Foundation wallet", "foundation"],
    ] as [Address, string, string][]) register(a, n, r);
    await fund(this.server);
    await fund(this.emergency);
    for (let i = 1; i <= 3; i++) {
      const g = register(labelAddress(`gta${i}`), `GTA ${i}`, "GTA");
      await fund(g);
      this.gtas.push(g);
    }
    for (const c of this.sc.countries) {
      progress(`Admitting ${c.name}'s Trust Admins and their verifiers`);
      await this.castCountry(c);
    }
    progress("Identity-checking the patrons");
    for (let i = 0; i < 12; i++) await this.newPatron();
  }

  /** The server records a passed identity check. */
  async identify(a: Address) {
    if (!(await read<boolean>("admin", "isKyc", [a]))) await this.act(this.server, "admin", "setKyc", [a, true], "identity check");
  }

  /** A country's Trust Admins, each with its organisations of verifiers. */
  async castCountry(c: CountryConfig) {
    let letter = 0;
    for (let i = 1; i <= c.holders; i++) {
      const ta = await this.admitHolder(`${c.short.toLowerCase()}${i}`, c, holderOrg(c.code, i), `${c.short}-TA${i}`);
      for (let o = 1; o <= c.orgsPerHolder; o++) {
        const L = LETTERS[letter++ % LETTERS.length];
        let first: Address | null = null;
        for (let v = 1; v <= c.verifiersPerOrg; v++) {
          // the first member is invited by the Trust Admin; the rest by a member, calling as itself (FM p6)
          const added = await this.addVerifier(ta, verifierOrg(c.code, i, o), first ?? ta, `${c.short}-${L}${v}`);
          first = first ?? added;
        }
      }
    }
  }

  async admitHolder(key: string, c: CountryConfig, org: number, name: string): Promise<Address> {
    const a = register(labelAddress(`holder.${c.code}.${key}`), name, `Trust Admin, ${c.name}`);
    this.holders[key] = a;
    await fund(a);
    await this.identify(a);
    if (await this.vote(Action.ADMIT_HOLDER, ["address", "uint16", "uint256", "string"], [a, c.code, BigInt(org), "ipfs://holder-agreement"], `admit ${name}`)) {
      if (!this.countryHolders.has(c.code)) this.countryHolders.set(c.code, []);
      this.countryHolders.get(c.code)!.push(a);
    }
    return a;
  }

  async addVerifier(holder: Address, org: number, inviter: Address, name: string): Promise<Address | null> {
    const v = register(labelAddress(`verifier.${name}`), name, "verifier");
    await fund(v);
    await this.identify(v);
    if (!(await this.act(inviter, "admin", "addVerifier", [v, BigInt(org), inviter, "ipfs://org", "ipfs://accreditation"], `add ${name}`))) return null;
    const c = N(await this.q("admin", "verifierCountry", [v]));
    if (!this.countryVerifiers.has(c)) this.countryVerifiers.set(c, []);
    this.countryVerifiers.get(c)!.push(v);
    return v;
  }

  async newPatron(checked = true): Promise<Address> {
    const i = this.patrons.length;
    const p = register(labelAddress(`patron.${i}`), `Patron ${i + 1}`, "patron");
    await this.fundPatron(p);
    if (checked) await this.act(this.server, "admin", "setKyc", [p, true], "kyc");
    this.patrons.push(p);
    return p;
  }

  private async fundPatron(p: Address) {
    await fund(p);
    await this.act(p, "usdt", "mint", [p, 100_000_000n * 10n ** 18n], "patron funds");
    await this.act(p, "usdt", "approve", [addr.market, maxUint256], "patron approve");
    await this.act(p, "usdt", "approve", [addr.token, maxUint256], "patron approve");
    await this.act(p, "admin", "acceptAgreement", [Agreement.PATRON, h("patron subscription v1")], "patron subscription");
  }

  /** A bidder who has accepted the Patron Subscription but not yet passed the identity check (FM p8). */
  async stranger(): Promise<Address> {
    const n = ++this.strangers;
    const p = register(labelAddress(`stranger.${n}`), `New bidder ${n}`, "patron");
    await this.fundPatron(p);
    return p;
  }

  async newGuardian(funds = 1_000_000n * 10n ** 18n): Promise<Address> {
    const n = ++this.guardianNonce;
    const g = register(labelAddress(`guardian.${n}`), `Guardian ${n}`, "guardian");
    await fund(g);
    await this.act(g, "usdt", "mint", [g, funds], "guardian funds");
    await this.act(g, "usdt", "approve", [addr.registry, maxUint256], "guardian approve");
    await this.act(g, "admin", "acceptAgreement", [Agreement.GRANTOR, h("grantor agreement v1")], "grantor agreement");
    return g;
  }

  // =====================================================================================
  // The tick
  // =====================================================================================

  begin(t: number) {
    this.start = t;
    this.now = t;
    this.nextArrival = t + 2 * DAY;
    this.nextChallengePass = t;
    this.relicPass = t + 30 * DAY;
  }

  async tick(t: number): Promise<void> {
    this.now = t;
    this.volatile.clear();
    // an edition whose eight years are up is closed now, so its burn lands when it falls due, not at the next placement
    const open = N(await read("tree", "editionOpen"));
    if (open <= LAST_EDITION && N(await read("tree", "currentEdition")) !== open) await this.act(this.server, "tree", "closeEditionIfDue", [], "closeEdition");
    const mean = YEAR / Math.max(0.1, this.b.arrivalsPerYear);
    while (!this.arrivalsOver() && t >= this.nextArrival) {
      if (this.b.fillLand && N(await read("tree", "currentEdition")) > LAST_EDITION) {
        this.landFull = true;
        this.landFullAt = t;
        this.note("land-full", 0, `All ${LAST_EDITION} editions are closed: the programme's TR3 is committed or burned. No more landowners are admitted; the covenants already made run out their terms.`);
        break;
      }
      await this.arrival();
      this.nextArrival += Math.max(3600, Math.round(-Math.log(1 - this.rand(1_000_000) / 1_000_000) * mean));
    }
    await this.governance();
    const due = this.requests.filter((rid) => !this.done.has(rid) && (this.nextAt.get(rid) ?? 0) <= t);
    await this.prefetch(due);
    for (const rid of due) await this.advance(rid);
    this.preReq.clear();
    this.preTerm.clear();
    if (t >= this.nextChallengePass) {
      await this.challenges();
      this.nextChallengePass = t + DAY;
    }
    if (t >= this.relicPass) {
      await this.useRelics();
      this.relicPass = t + 30 * DAY;
    }
    // the end of the programme: the last edition closed and every term ended, the Reserve is burned (OV1)
    if (this.requests.length > 0 && this.done.size === this.requests.length && !this.reserveFinalized
      && N(await read("tree", "currentEdition")) > LAST_EDITION && N(await read("tree", "liveCovenants")) === 0) {
      const left = await read<bigint>("tree", "reserve");
      if (await this.act(this.server, "tree", "finalizeReserve", [], "finalizeReserve")) {
        this.reserveFinalized = true;
        this.note("reserve", 0, `The programme is over: the Overcharge Reserve is finalised and its ${(Number(left / 10n ** 15n) / 1000).toLocaleString("en-US")} TR3 are burned.`);
      }
    }
  }

  /** The earliest moment anyone has something to do. */
  nextDue(): number {
    let m = this.arrivalsOver() ? Infinity : this.nextArrival;
    for (const rid of this.requests) if (!this.done.has(rid)) m = Math.min(m, this.nextAt.get(rid) ?? m);
    if (this.openChallenges.some((c) => c !== 0n)) m = Math.min(m, this.nextChallengePass);
    if (this.relics.length) m = Math.min(m, this.relicPass);
    if (this.b.governanceCalendar) m = Math.min(m, this.start + (this.govStage + 1) * this.calendarYear());
    for (const x of [this.emergencyEndAt, this.unfreezeAt, this.feeSplitAt]) if (x) m = Math.min(m, x);
    if (this.landFull && !this.reserveFinalized && this.done.size === this.requests.length) m = Math.min(m, this.now + 30 * DAY);
    return Number.isFinite(m) ? m : this.now + 30 * DAY;
  }

  // =====================================================================================
  // Arrivals
  // =====================================================================================

  async arrival(forced?: number): Promise<number> {
    const cs = this.sc.countries;
    const country = forced ?? cs[this.pick(cs.map((c) => c.weight))].code;
    const c = await read("countries", "getCountry", [country]);
    if (N(c.status) !== 1) {
      this.note("refused", 0, `A landowner in ${countryName(country)} is turned away: the country is suspended.`);
      return 0;
    }
    if (N(await read("tree", "currentEdition")) > LAST_EDITION) {
      this.note("refused", 0, `A landowner in ${countryName(country)} is turned away: all ${LAST_EDITION} editions are closed.`);
      return 0;
    }
    const minLand = N(await read("tree", "minLandUnits"));
    const maxLand = N(await read("tree", "maxLandUnits"));
    let land = minLand + Math.floor(((maxLand - minLand) * this.rand(1000) ** 2) / 1_000_000);
    let [lo, hi] = (await read<[number, number]>("countries", "termRange", [country, BigInt(land)])).map(N);
    hi = Math.min(hi, Math.max(lo, this.b.maxTermYears));
    if (lo > hi) {
      land = minLand;
      [lo, hi] = (await read<[number, number]>("countries", "termRange", [country, BigInt(land)])).map(N);
      hi = Math.min(hi, Math.max(lo, this.b.maxTermYears));
    }
    if (lo > hi) {
      this.note("refused", 0, `A landowner in ${countryName(country)} is turned away: no term the country allows fits land the edition allows.`);
      return 0;
    }
    const term = lo + this.rand(hi - lo + 1);
    const [vf, af, jf] = await read<bigint[]>("countries", "quote", [country, BigInt(land)]);
    const fees = vf + af + jf;
    const g = await this.newGuardian(2n * fees + 1000n * 10n ** 18n);
    const ref = this.rand(3) === 0 ? this.patrons[this.rand(this.patrons.length)] : zeroAddress;
    const rid = N(await read("registry", "nextRequestId"));
    const parcel = keccak256(enc(["string", "address"], ["parcel", g]));
    const ok = await this.act(g, "registry", "requestVerification",
      [country, BigInt(land), term, parcel, ref, fees, "sim"], "request", rid);
    if (!ok) return 0;
    this.requests.push(rid);
    this.countryOf[rid] = country;
    this.fate.set(rid, forced !== undefined ? F.NORMAL : this.drawFate(country));
    this.nextAt.set(rid, this.now + DAY + this.rand(10) * DAY);
    this.kinds.request = (this.kinds.request ?? 0) + 1;
    return rid;
  }

  drawFate(country: number): number {
    const b = this.b;
    const f = this.rand(10_000) / 100;
    let x = b.cancelPct;
    if (f < x) return F.CANCEL;
    if (f < (x += b.claimLapsePct)) return F.CLAIM_LAPSE;
    if (f < (x += b.abandonPct)) return F.ABANDON;
    if (f < (x += b.refusePct)) return F.REFUSE;
    if (f < (x += b.preMintChallengePct)) return F.CHALLENGE;
    if (f < (x += b.unsoldPct)) return F.UNSOLD;
    if (this.pathB.has(country)) {
      if (f < (x += b.pathBLapseNothingPct)) return F.LAPSE_NOTHING;
      if (f < (x += b.pathBLapseUnattestedPct)) return F.LAPSE_UNATTESTED;
    }
    return F.NORMAL;
  }

  // =====================================================================================
  // Before activation
  // =====================================================================================

  async advance(rid: number): Promise<void> {
    const pre = this.preReq.get(rid);
    this.preReq.delete(rid);
    const r = pre ?? await read("registry", "getRequest", [BigInt(rid)]);
    const t = this.now;
    const status = N(r.status);
    if (status === RequestStatus.ENDED) {
      if (N(r.endReason) === COMPLETED) await this.term(rid, r.tokenId);
      else await this.finishCancelled(rid, r.tokenId);
      return;
    }
    // once all 21 editions have closed no land is placed: a request not yet minted cannot be, and its guardian
    // withdraws it once nobody holds a live claim on it
    const closed = (status === RequestStatus.OPEN || status === RequestStatus.CLAIMED) && N(await read("tree", "currentEdition")) > LAST_EDITION;
    if (closed) {
      const live = status === RequestStatus.CLAIMED && t <= N(r.claimedAt) + this.acceptance;
      if (live) { this.nextAt.set(rid, N(r.claimedAt) + this.acceptance + 1); return; }
      if (await this.act(r.guardian, "registry", "cancelRequest", [BigInt(rid)], "cancel-closed", rid)) {
        this.note("refused", rid, `Request #${rid} can no longer be verified: all ${LAST_EDITION} editions are closed. Its guardian withdraws it and is refunded in full.`);
      }
      this.nextAt.set(rid, t + DAY);
      return;
    }
    if (status === RequestStatus.OPEN) {
      if (this.fate.get(rid) === F.CANCEL) {
        await this.act(r.guardian, "registry", "cancelRequest", [BigInt(rid)], "cancel", rid);
        this.nextAt.set(rid, t + DAY);
        return;
      }
      // after an upheld 1A the challenger has three days' first claim (FM p15)
      const first = getAddress(r.firstClaimant);
      let v: Address = zeroAddress;
      if (first !== zeroAddress && t <= N(r.firstClaimUntil)) {
        if (this.rand(10) < 7) v = first;
        else { this.nextAt.set(rid, N(r.firstClaimUntil) + 1); return; }
      } else v = await this.pickVerifier(N(r.country), r.barred, zeroAddress, r.guardian);
      if (v === zeroAddress) { this.nextAt.set(rid, t + 30 * DAY); return; }
      if (await this.act(v, "registry", "claim", [BigInt(rid)], v === first ? "first claim" : "claim", rid)) {
        if (v === first) this.note("first-claim", rid, `${nameOf(v)}, whose challenge removed the verification, takes request #${rid} on its first claim.`);
        this.submitAt.set(rid, t + Math.min(5 * DAY + this.rand(20) * DAY, Math.max(DAY, this.acceptance - DAY)));
      }
      this.nextAt.set(rid, this.fate.get(rid) === F.CLAIM_LAPSE ? t + this.acceptance + DAY : (this.submitAt.get(rid) ?? t + 7 * DAY));
      return;
    }
    if (status === RequestStatus.CLAIMED) {
      const claimedAt = N(r.claimedAt);
      if (t > claimedAt + this.acceptance) {
        // the claim lapsed: another verifier takes it over
        this.fate.set(rid, F.NORMAL);
        const v = await this.pickVerifier(N(r.country), r.barred, r.verifier, r.guardian);
        if (v !== zeroAddress && (await this.act(v, "registry", "claim", [BigInt(rid)], "reclaim", rid))) {
          this.note("claim-lapsed", rid, `${nameOf(r.verifier)} let the claim on request #${rid} lapse; ${nameOf(v)} takes it over.`);
          this.submitAt.set(rid, t + Math.min(5 * DAY + this.rand(15) * DAY, Math.max(DAY, this.acceptance - DAY)));
        }
        const s = this.submitAt.get(rid) ?? 0;
        this.nextAt.set(rid, s > t ? s : t + 7 * DAY);
        return;
      }
      if (this.fate.get(rid) === F.CLAIM_LAPSE) { this.nextAt.set(rid, claimedAt + this.acceptance + DAY); return; }
      const score = 40 + this.rand(56);
      await this.act(r.verifier, "registry", "submitVerification",
        [BigInt(rid), score, 2 + this.rand(5), 1 + this.rand(3), h("title", rid), h("folios", rid), this.metadataOf(rid)], "submit", rid);
      this.nextAt.set(rid, t + DAY);
      return;
    }
    if (status === RequestStatus.VERIFIED) {
      const verifiedAt = N(r.verifiedAt);
      if (this.fate.get(rid) === F.CHALLENGE && !r.challenged && t <= verifiedAt + this.watchdog) {
        const option = this.rand(2) === 0 ? Option.W1A : Option.W1B;
        await this.raise(option, BigInt(rid), rid, r.verifier, r.guardian, N(r.country));
        this.fate.set(rid, F.NORMAL);
      }
      if (t <= verifiedAt + this.watchdog || r.challengeId !== 0n) { this.nextAt.set(rid, Math.min(t + 7 * DAY, verifiedAt + this.watchdog + 1)); return; }
      if (this.fate.get(rid) === F.ABANDON) {
        await this.act(r.guardian, "registry", "abandonRequest", [BigInt(rid)], "abandon", rid);
        this.nextAt.set(rid, t + DAY);
        return;
      }
    }
    await this.flow(rid, r, t);
  }

  metadataOf(rid: number) { return `ipfs://eft/${rid}`; }

  async holderCan(holder: Address): Promise<boolean> {
    const [active, frozen] = await Promise.all([this.q<boolean>("admin", "isActiveHolder", [holder]), this.q<boolean>("admin", "isFrozen", [holder])]);
    return active && !frozen;
  }

  private shortOf(country: number) {
    return this.sc.countries.find((c) => c.code === country)?.short ?? "XX";
  }

  /** The step's clock has run out: anyone ends the request (FM p12-13), refunding what is unearned. */
  private async lapseIfDue(rid: number, t: number): Promise<boolean> {
    const deadline = N(await read("deeds", "deadlineOf", [BigInt(rid)]));
    if (deadline === 0 || t <= deadline) return false;
    if (await this.act(this.server, "deeds", "lapse", [BigInt(rid)], "lapse", rid)) {
      this.note("lapsed", rid, `Request #${rid}'s paper clock ran out: it lapses, and the landowner is refunded what was not earned.`);
    }
    this.nextAt.set(rid, t + DAY);
    return true;
  }

  async flow(rid: number, r: any, t: number): Promise<void> {
    const s = await read("registry", "stepContext", [BigInt(rid)]);
    const holder: Address = await this.q("admin", "holderOf", [r.verifier]);
    const holderCan = await this.holderCan(holder);
    const term = N(r.termYears);
    const step = N(s.step);
    const preSale = N(s.saleAt) === 0;
    // the paper clocks are 14 days to anchor and 30 to attest: the actors move within days
    this.nextAt.set(rid, t + DAY + this.rand(5) * DAY);
    if (preSale && step !== Step.MINT && step !== Step.SALE && step !== Step.POWER && (await this.lapseIfDue(rid, t))) return;
    if (step === Step.POWER) {
      if (!holderCan) return; // waits for a successor, an unfreeze or the Council
      await this.act(holder, "deeds", "grantPower", [BigInt(rid), h("power", rid, t), BigInt(t + (term + 3) * YEAR)], "grantPower", rid);
    } else if (step === Step.POWER_ANCHOR) {
      if (this.b.governanceCalendar && !this.revokeDone && this.govStage >= 5) {
        // a Trust Admin revokes a power without the Council's authority: recorded, and it is frozen
        this.revokeDone = true;
        if (await this.vote(Action.REVOKE_POWER, ["uint256", "bool"], [BigInt(rid), false], "revokePower", rid)) {
          if (await read<boolean>("admin", "isFrozen", [holder])) {
            this.note("gov", rid, `${nameOf(holder)} revoked the power for request #${rid} without the Council's authority, and is frozen. The Council unfreezes it in 21 days.`);
            this.unfreezeHolder = holder;
            this.unfreezeAt = t + 21 * DAY;
          } else {
            this.note("gov", rid, `The power for request #${rid} is revoked without the Council's authority; ${nameOf(holder)} has already been removed, so there is no one to freeze.`);
          }
        }
        return;
      }
      await this.act(r.verifier, "deeds", "anchorPower", [BigInt(rid), h("reg", rid), "RG/0001"], "anchorPower", rid);
    } else if ((step === Step.DEED || step === Step.AGREEMENT) && preSale) {
      if (this.fate.get(rid) === F.REFUSE) {
        // the landowner will not sign: the verifier records it and keeps its verification fee
        if (await this.act(r.verifier, "deeds", "recordRefusal", [BigInt(rid)], "refusal", rid)) {
          this.note("refused", rid, `The landowner of #${rid} will not sign. ${nameOf(r.verifier)} records the refusal and keeps its verification fee.`);
        }
        return;
      }
      // now and then the notary is away: the verifier asks for 14 more days, and the Holder's silence grants them
      if (!this.extended.has(rid) && this.rand(100) < 5) {
        this.extended.add(rid);
        if (await this.act(r.verifier, "deeds", "askExtension", [BigInt(rid), h("the notary is away", rid)], "askExtension", rid)) {
          const deadline = N(await read("deeds", "deadlineOf", [BigInt(rid)]));
          this.stepPlan.set(rid, deadline + 2 * DAY);
          this.nextAt.set(rid, deadline + 2 * DAY);
          this.note("extension", rid, `The notary for #${rid} is away: ${nameOf(r.verifier)} asks for 14 more days to anchor the ${step === Step.AGREEMENT ? "agreement" : "Deed"}; ${nameOf(holder)} says nothing, which grants it.`);
          return;
        }
      }
      if ((this.stepPlan.get(rid) ?? 0) > t) { this.nextAt.set(rid, this.stepPlan.get(rid)!); return; }
      const by = this.rand(2) === 0 || !holderCan ? r.verifier : holder;
      await this.act(by, "deeds", "recordDocument", [BigInt(rid), h(step === Step.AGREEMENT ? "agreement" : "deed", rid, N(s.cursor)), BigInt(t), `${this.shortOf(N(r.country))}-REG`], "recordDocument", rid);
    } else if (step === Step.RECORDING) {
      const saleAt = N(r.saleAt), post = N(r.postSaleWindow);
      if (t > saleAt + post) {
        await this.act(this.server, "registry", "lapseSale", [BigInt(rid)], "lapseSale", rid);
        this.fate.set(rid, F.NORMAL);
        this.listings.set(rid, 0);
        return;
      }
      if (this.fate.get(rid) === F.LAPSE_NOTHING || !holderCan) { this.nextAt.set(rid, saleAt + post + 1); return; }
      await this.act(holder, "deeds", "recordDocument", [BigInt(rid), h("recording", rid), BigInt(t), "R.7/12.345"], "recordRecording", rid);
    } else if (step === Step.ATTEST) {
      const saleAt = N(r.saleAt), post = N(r.postSaleWindow);
      if (saleAt !== 0 && (this.fate.get(rid) === F.LAPSE_UNATTESTED || t > saleAt + post)) {
        if (t > saleAt + post) await this.act(this.server, "registry", "lapseSale", [BigInt(rid)], "lapseSale", rid);
        else this.nextAt.set(rid, saleAt + post + 1);
        return;
      }
      const doc = await read("deeds", "getDocument", [BigInt(rid), BigInt(N(s.cursor) - 1)]);
      const a = await this.pickAttester(N(r.country), r.verifier, r.guardian, N(doc.recordedAt));
      if (a === zeroAddress) { this.nextAt.set(rid, N(doc.recordedAt) + this.sc.contracts.gtaAttestFromDays * DAY + 1); return; }
      await this.act(a, "deeds", "attest", [BigInt(rid), doc.docHash, h("certified copy", rid, N(s.cursor)), `${this.shortOf(N(r.country))}-REG`], "attest", rid);
    } else if (step === Step.MINT) {
      if (N(await read("tree", "currentEdition")) > LAST_EDITION) {
        if (await this.act(r.guardian, "registry", "abandonRequest", [BigInt(rid)], "abandon-closed", rid)) {
          this.note("stranded", rid, `Request #${rid} cannot be minted: all ${LAST_EDITION} editions are closed. The guardian abandons it, after paying the verifier and the attester.`);
        }
        return;
      }
      await this.act(r.guardian, "registry", "mint", [BigInt(rid), this.metadataOf(rid)], "mint", rid);
    } else if (step === Step.SALE) {
      await this.sale(rid, r, t);
    }
  }

  /** A starting price the Market accepts: at least the floor for its cadence (FM p8). Below USD 500 x (2T + 1) the
   *  instalments are yearly; at or above it, twice a year, with the twice-a-year floor. */
  async startPrice(country: number, land: bigint, term: number): Promise<bigint> {
    const q = await read("lens", "quote", [country, land, term, 50]);
    let price: bigint = q.priceFloor + (q.priceFloor * BigInt(this.rand(150))) / 100n;
    if (price >= q.twiceAYearFrom && price < q.priceFloorTwice) price = q.priceFloorTwice + (q.priceFloorTwice * BigInt(this.rand(30))) / 100n;
    return price;
  }

  async sale(rid: number, r: any, t: number): Promise<void> {
    const tid: bigint = r.tokenId;
    // a sale settling: the winner's identity check, or (path B) the recording
    if (await read<boolean>("market", "inSettlement", [tid])) {
      const st = await read("market", "getSettlement", [tid]);
      if (st.kycPending) {
        const pass = this.kycOutcome.get(tid) ?? true;
        if (pass) {
          await this.act(this.server, "admin", "setKyc", [st.buyer, true], "kyc", rid);
          if (await this.act(this.patrons[0], "market", "confirmSale", [tid], "confirmSale", rid)) {
            this.note("kyc", rid, `${nameOf(st.buyer)} passes the identity check after winning #${rid}; the sale completes.`);
            this.patrons.push(getAddress(st.buyer));
          }
        } else if (await this.act(this.server, "market", "cancelStaleSale", [tid], "kyc failed", rid)) {
          this.note("kyc", rid, `${nameOf(st.buyer)} fails the identity check: the sale of #${rid} is called off, the price refunded, and the EFT goes back to its landowner to relist.`);
        }
        this.kycOutcome.delete(tid);
      }
      this.nextAt.set(rid, t + DAY);
      return;
    }
    if (await read<boolean>("market", "hasAuction", [tid])) {
      const au = await read("market", "getAuction", [tid]);
      const endsAt = N(au.endsAt);
      if (t > endsAt) {
        await this.act(this.patrons[0], "market", "settleAuction", [tid], "settle", rid);
        this.nextAt.set(rid, t + DAY);
        return;
      }
      this.nextAt.set(rid, endsAt + 1);
      return;
    }
    const closeAt = N(r.listingFrom) + N(r.listingWindow);
    if (t > closeAt) {
      await this.act(this.patrons[0], "registry", "closeUnsold", [BigInt(rid)], "closeUnsold", rid);
      this.nextAt.set(rid, t + DAY);
      return;
    }
    const [, deadline] = await read<[boolean, bigint]>("registry", "listingInfo", [tid]);
    const listed = this.listings.get(rid) ?? 0;
    const length = Math.max(this.sc.contracts.minAuctionDays, 7) * DAY;
    if (t + length > N(deadline) || listed >= 3) { this.nextAt.set(rid, closeAt + 1); return; }
    const c = await read("core", "getCovenant", [tid]);
    if (N(c.status) !== CovenantStatus.MINTED) { this.nextAt.set(rid, t + 7 * DAY); return; }
    const start = await this.startPrice(N(c.country), c.landUnits, N(c.termYears));
    if (await this.act(c.guardian, "market", "listForAuction", [tid, start, 0n, BigInt(length)], "list", rid)) {
      this.listings.set(rid, listed + 1);
      // the auction opens at once: a patron bids in the same visit, so a long step cannot skip the bidding
      if (this.fate.get(rid) !== F.UNSOLD) {
        // anyone bids; the winner's identity is checked after the auction (FM p8)
        const late = this.chance(this.b.kycLatePct);
        const p = late ? await this.stranger() : await this.patronFor(tid);
        if (late) this.kycOutcome.set(tid, !this.chance(this.b.kycFailPct));
        const price = start + (start * BigInt(this.rand(30))) / 100n;
        await this.topUp(p, price);
        if (await this.act(p, "market", "bid", [tid, price], "bid", rid)) this.priceOf.set(rid, price);
      }
    }
    this.nextAt.set(rid, t + length + 1);
  }

  // =====================================================================================
  // The term
  // =====================================================================================

  async term(rid: number, tid: bigint): Promise<void> {
    const t = this.now;
    let st = this.preTerm.get(tid) ?? await this.termState(tid);
    this.preTerm.delete(tid);
    let c = st.c;
    const status = N(c.status);
    if (status === CovenantStatus.CANCELLED || status === CovenantStatus.CLOSED) { await this.finishCancelled(rid, tid); return; }
    if (status === CovenantStatus.ENDED) { await this.afterEnd(rid, tid, st); return; }
    let w = st.w;
    // the covenant's Holder: the one at its mint, along its succession line -- not the sitting verifier's (R11)
    const holder = getAddress(await read<Address>("core", "holderOf", [tid]));
    const holderCan = await this.holderCan(holder);
    let next = t + 30 * DAY;
    const termEnd = N(c.termEnd);
    const openedAt = N(w.openedAt), closesAt = N(w.closesAt);
    const windowOpen = openedAt !== 0 && t <= closesAt;

    // ---- the review window ----
    if (openedAt !== 0 && openedAt !== this.windowSeen.get(tid)) {
      this.windowSeen.set(tid, openedAt);
      const p = this.rand(10_000) / 100;
      this.windowPlan.set(tid, p < this.b.attestPct ? 1 : p < this.b.attestPct + this.b.challengePct ? 2 : 0);
      const span = Math.max(1, Math.floor((closesAt - openedAt) / DAY) - 3);
      this.windowActAt.set(tid, openedAt + Math.min(2 * DAY + this.rand(20) * DAY, span * DAY));
    }
    if (windowOpen && getAddress(w.attestor) === zeroAddress) {
      const wp = this.windowPlan.get(tid) ?? 0;
      if (wp !== 0 && t >= this.windowActAt.get(tid)! && t + 3600 <= closesAt) {
        if (wp === 1) {
          const a = await this.pickWindowAttester(N(c.country), c.verifier, c.guardian, openedAt);
          if (a !== zeroAddress) await this.act(a, "challenge", "attestVerification", [tid, h("certified copy", tid, openedAt), "ipfs://copy"], "attestVerification", rid);
        } else if (!st.undecided) {
          const option = [Option.T3A, Option.T3B, Option.T3C, Option.T3D][this.pick(this.b.termOptions)];
          await this.raise(option, tid, rid, c.verifier, c.guardian, N(c.country));
        }
        this.windowPlan.set(tid, 0);
      } else if (wp !== 0) next = Math.min(next, this.windowActAt.get(tid)!);
      next = Math.min(next, closesAt + 1);
    }

    // ---- a block ----
    if (status === CovenantStatus.BLOCKED) {
      const reason = N(c.blockReason);
      if (reason === BlockReason.DEED) { await this.restoreDeed(rid, tid, c, holder, holderCan, st); return; }
      // a vacant seat is filled first, and a term that is over goes to its End Date: both are reached below
      if (reason === BlockReason.BREACH && !st.undecided && !st.seat.vacant && t < termEnd) {
        // in the term a breach is never cancelled (FM P7): the verifier re-verifies to cure it, once the window
        // has closed; or the landowner challenges the block as wrong (3E)
        if (!this.blockPlan.has(tid)) {
          this.blockPlan.set(tid, { at: t + 20 * DAY + this.rand(40) * DAY, how: this.chance(this.b.wrongBlockPct) ? 1 : 0 });
        }
        const bp = this.blockPlan.get(tid)!;
        if (t >= bp.at) {
          if (bp.how === 1) {
            await this.raise(Option.T3E, tid, rid, c.verifier, c.guardian, N(c.country));
            this.blockPlan.set(tid, { at: t + 60 * DAY, how: 0 });
          } else if (!windowOpen) {
            if (await this.act(c.verifier, "core", "verify", [tid, 0, 0, ""], "cure", rid)) {
              this.note("cure", rid, `${nameOf(c.verifier)} finds the breach on #${rid} cured and re-verifies: the block lifts, with what it held.`);
              this.blockPlan.delete(tid);
            }
          }
          this.nextAt.set(rid, windowOpen ? closesAt + 1 : t + DAY);
          return;
        }
        next = Math.min(next, bp.at);
      }
    }

    // ---- the seat ----
    if (!st.undecided && (st.seat.vacant || (st.overdue && t > st.due + this.grace + 10 * DAY))) {
      await this.reseat(rid, tid, c, holder, holderCan, st);
      st = await this.termState(tid);
      c = st.c;
      w = st.w;
    }

    // ---- verification ----
    const due = st.due;
    const verifiedThrough = N(c.verifiedThrough);
    if (due !== 0 && this.planFor.get(tid) !== verifiedThrough + 1) {
      this.planFor.set(tid, verifiedThrough + 1);
      const d = this.rand(10_000) / 100;
      const delay = d < this.b.onTimePct ? this.rand(10) : d < this.b.onTimePct + this.b.littleLatePct ? 10 + this.rand(8) : 25 + this.rand(20);
      this.verifyAt.set(tid, due + delay * DAY);
    }
    const windowClosed = N(w.openedAt) === 0 || t > N(w.closesAt);
    // off schedule: a newly seated verifier's first re-verification, or one option 3C made due
    const offSchedule = (st.seat.reverifyFirst || st.reverifyBy !== 0) && N(c.status) === CovenantStatus.ACTIVE;
    if (!st.seat.vacant && windowClosed && !st.undecided && N(c.status) === CovenantStatus.ACTIVE) {
      if ((due !== 0 && t >= this.verifyAt.get(tid)! && t >= due) || offSchedule) {
        const late = due !== 0 && t - due > this.grace;
        if (await this.act(c.verifier, "core", "verify", [tid, this.rescore(N(c.ecoScore)), 0, ""], "verify", rid)) {
          if (offSchedule) this.note("reverify", rid, `${nameOf(c.verifier)} re-verifies #${rid} off schedule.`);
          else if (late) this.note("late", rid, `${nameOf(c.verifier)} verifies #${rid} ${Math.round((t - due) / DAY)} days late: those days' TR3 go to the Reserve.`);
          if (this.rand(1000) < this.b.blockPermille && t < termEnd) {
            if (await this.act(c.verifier, "core", "blockCovenant", [tid, "breach found on the land"], "block", rid)) {
              this.note("block", rid, `${nameOf(c.verifier)} finds a breach on #${rid} and blocks it: instalments and TR3 pause.`);
            }
          }
        }
        this.nextAt.set(rid, t + DAY);
        return;
      }
    }
    if (due !== 0) { const va = this.verifyAt.get(tid)!; next = Math.min(next, va > t ? va : t + 7 * DAY); }
    if (!windowClosed) next = Math.min(next, N(w.closesAt) + 1);

    // ---- once a year: TR3, resale, the land ----
    if (t >= (this.yearlyAt.get(tid) ?? 0)) {
      this.yearlyAt.set(tid, t + YEAR);
      await this.yearly(rid, tid, c, st);
    }
    next = Math.min(next, this.yearlyAt.get(tid)!);
    if (this.landSaleAt.has(tid)) {
      await this.landSale(rid, tid);
      if (this.landSaleAt.has(tid)) next = Math.min(next, this.landSaleAt.get(tid)!);
    }

    // ---- the End Date ----
    if (t >= termEnd && !st.undecided) {
      const allVerified = N(c.verifiedThrough) >= N(st.acct.totalReleases);
      if (allVerified || t > termEnd + this.grace) {
        if (await this.act(this.patrons[0], "core", "closeTerm", [tid], "closeTerm", rid)) {
          this.note("term-ended", rid, `#${rid} reaches its End Date: the last instalment and the last TR3 release.`);
        }
        this.nextAt.set(rid, t + DAY);
        return;
      }
      next = Math.min(next, termEnd + this.grace + DAY);
    }
    this.nextAt.set(rid, Math.max(next, t + 3600));
  }

  /** Option 3A upheld: the Holder records a fresh grant within 60 days and another organisation attests it; or the
   *  covenant closes early and the unreleased escrow goes to the patron. */
  async restoreDeed(rid: number, tid: bigint, c: any, holder: Address, holderCan: boolean, st: any) {
    const t = this.now;
    const by = st.restoreBy;
    const rest = await read("deeds", "getRestoration", [tid]);
    if (by !== 0 && t > by) {
      if (await this.act(this.server, "core", "closeEarly", [tid], "closeEarly", rid)) {
        this.note("closed-early", rid, `#${rid}'s Deed was not restored in time: the covenant closes early; the unreleased escrow goes to the patron, the rest of its TR3 to the Reserve.`);
      }
      this.nextAt.set(rid, t + DAY);
      return;
    }
    if (N(rest.recordedAt) === 0 || N(rest.attestedAt) !== 0) {
      if (holderCan && this.rand(10) < 8) {
        await this.act(holder, "deeds", "recordRestoration", [tid, h("fresh grant", tid, t), BigInt(t), "LR/RESTORED"], "recordRestoration", rid);
      } else { this.nextAt.set(rid, by + 1); return; }
    } else {
      const a = await this.pickAttester(N(c.country), c.verifier, c.guardian, N(rest.recordedAt));
      if (a !== zeroAddress && await this.act(a, "deeds", "attestRestoration", [tid, rest.docHash, h("copy", tid), "LR/RESTORED"], "attestRestoration", rid)) {
        this.note("restored", rid, `#${rid}'s Deed is back on the register: the block lifts with back-pay.`);
      }
    }
    this.nextAt.set(rid, t + DAY + this.rand(5) * DAY);
  }

  /** After the End Date: the review pool, the last TR3, and the Relic. */
  async afterEnd(rid: number, tid: bigint, st: any) {
    const t = this.now;
    const w = st.w;
    if (N(w.openedAt) !== 0 && t <= N(w.closesAt)) { this.nextAt.set(rid, N(w.closesAt) + 1); return; }
    if ((await read<bigint>("challenge", "poolBalance", [tid])) !== 0n) {
      if (!(await this.act(this.patrons[0], "challenge", "sweepReviewPool", [tid], "sweep", rid))) { this.nextAt.set(rid, t + 7 * DAY); return; }
    }
    await this.claimTR3(rid, tid);
    const [, , toEndDate] = await read<[number, bigint, boolean]>("tree", "relicSource", [tid]);
    if (toEndDate && (await read<bigint>("overcharge", "relicOf", [tid])) === 0n) {
      const id = await read<bigint>("overcharge", "nextRelicId");
      if (await this.act(this.patrons[0], "overcharge", "mintRelic", [tid], "mintRelic", rid)) {
        const relic = await read("overcharge", "getRelic", [id]);
        const owner = getAddress(await read<Address>("overcharge", "ownerOf", [id]));
        this.relics.push({ id, owner, edition: N(relic.edition) });
        this.note("relic", rid, `#${rid}'s EFT becomes a Relic of edition ${N(relic.edition)} for ${nameOf(owner)}, worth up to ${(Number(relic.cap / 10n ** 15n) / 1000).toLocaleString("en-US")} TR3 of boost.`);
      }
    }
    this.note("complete", rid, `#${rid} is complete: every instalment released, the review pool settled.`);
    this.done.add(rid);
  }

  /** Relic owners apply a Relic to a later EFT they own, at the quote's commit less 5%; two of the same edition
   *  are sometimes transmuted into one an edition lower. */
  async useRelics() {
    const keep: { id: bigint; owner: Address; edition: number }[] = [];
    for (const r of this.relics) {
      if (!this.chance(this.b.relicUsePct)) { keep.push(r); continue; }
      const twin = keep.find((x) => x.owner === r.owner && x.edition === r.edition && r.edition >= 2);
      if (twin && this.rand(3) === 0) {
        const id = await read<bigint>("overcharge", "nextRelicId");
        if (await this.act(r.owner, "overcharge", "transmute", [twin.id, r.id], "transmute")) {
          keep.splice(keep.indexOf(twin), 1);
          keep.push({ id, owner: r.owner, edition: r.edition - 1 });
          this.note("relic", 0, `${nameOf(r.owner)} transmutes two edition-${r.edition} Relics into one of edition ${r.edition - 1}.`);
        }
        continue;
      }
      let used = false;
      for (const rid of this.requests) {
        if (this.done.has(rid)) continue;
        const req = await read("registry", "getRequest", [BigInt(rid)]);
        if (N(req.status) !== RequestStatus.ENDED || N(req.endReason) !== COMPLETED) continue;
        const tid: bigint = req.tokenId;
        const c = await read("core", "getCovenant", [tid]);
        if (N(c.status) !== CovenantStatus.ACTIVE || this.now >= N(c.termEnd)) continue;
        if (getAddress(await read<Address>("token", "ownerOf", [tid])) !== r.owner) continue;
        if ((await read("bank", "getAccount", [tid])).holds !== 0) continue;
        const [mE6, , , , commit] = await read<[bigint, bigint, bigint, bigint, bigint]>("overcharge", "quoteOvercharge", [tid, r.id]);
        if (mE6 === 0n || commit === 0n) continue;
        const rw = await read("tree", "rewardOf", [tid]);
        if (rw.mE6 !== 0n || rw.held) continue;
        if (await this.act(r.owner, "overcharge", "overcharge", [tid, r.id, (commit * 95n) / 100n], "overcharge", rid)) {
          this.note("overcharge", rid, `${nameOf(r.owner)} applies its edition-${r.edition} Relic to #${rid}: M = ${(Number(mE6) / 1e6).toFixed(2)}, ${(Number(commit / 10n ** 15n) / 1000).toLocaleString("en-US")} TR3 committed from the Reserve.`);
          used = true;
          break;
        }
      }
      if (!used) keep.push(r);
    }
    this.relics = keep;
  }

  // What each due request's first look reads, fetched for all of them at once at the start of a tick.
  private preReq = new Map<number, any>();
  private preTerm = new Map<bigint, Awaited<ReturnType<Engine["termState"]>>>();

  async prefetch(rids: number[]) {
    const reqs = await Promise.all(rids.map((rid) => bulk.readContract({ address: addr.registry, abi: abis.registry, functionName: "getRequest", args: [BigInt(rid)] })));
    rids.forEach((rid, i) => this.preReq.set(rid, reqs[i]));
    const terms = rids.map((rid, i) => [rid, reqs[i] as any] as const).filter(([, r]) => N(r.status) === RequestStatus.ENDED && N(r.endReason) === COMPLETED);
    const states = await Promise.all(terms.map(([, r]) => this.termState(r.tokenId, true)));
    terms.forEach(([, r], i) => this.preTerm.set(r.tokenId, states[i]));
  }

  /** Everything a term visit looks at, read in one parallel wave. */
  async termState(tid: bigint, batched = false) {
    const r = <T = any>(c: Key, fn: string) => (batched
      ? bulk.readContract({ address: addr[c], abi: abis[c], functionName: fn, args: [tid] }) as Promise<T>
      : read<T>(c, fn, [tid]));
    const [c, acct, w, seat, overdue, undecided, due, halted, reverifyBy, restoreBy] = await Promise.all([
      r("core", "getCovenant"), r("bank", "getAccount"), r("challenge", "getWindow"), r("parties", "getSeat"),
      r<boolean>("core", "isVerificationOverdue"), r<boolean>("challenge", "hasUndecidedChallenge"),
      r("core", "nextVerificationDue"), r<boolean>("challenge", "releasesHalted"), r("core", "reverifyBy"), r("core", "restoreBy"),
    ]);
    return { c, acct, w, seat, overdue, undecided, due: N(due), halted, reverifyBy: N(reverifyBy), restoreBy: N(restoreBy) };
  }

  rescore(score: number): number {
    if (this.rand(10) !== 0) return 0;
    return Math.max(1, Math.min(100, score + this.rand(21) - 10));
  }

  /** The seat is vacant (3B upheld, or a vacancy recorded), or the verifier is long overdue: the challenger's first
   *  claim, then the Holder's 30 days, then the Council (FM p4, p18). In a flow under a power, the Holder records the
   *  new verifier's power. */
  async reseat(rid: number, tid: bigint, c: any, holder: Address, holderCan: boolean, st: any) {
    const t = this.now;
    const seat = st.seat;
    if (seat.vacant && getAddress(seat.firstClaimant) !== zeroAddress && t <= N(seat.firstClaimUntil)) {
      if (this.rand(10) < 7 && await this.act(seat.firstClaimant, "parties", "claimSeat", [tid], "claimSeat", rid)) {
        this.note("reseat", rid, `${nameOf(seat.firstClaimant)}, whose challenge vacated the seat, takes #${rid} on its first claim.`);
        await this.replacementPower(rid, tid, holder, holderCan);
        return;
      }
      this.nextAt.set(rid, N(seat.firstClaimUntil) + 1);
      return;
    }
    const removed = seat.vacant ? seat.removed : c.verifier;
    const next = await this.pickSuccessor(removed, N(c.country), seat.removed);
    if (next === zeroAddress) return;
    const from = N(seat.firstClaimUntil) !== 0 ? N(seat.firstClaimUntil) : N(seat.vacantSince);
    const holderMay = holderCan && (!seat.vacant || t <= from + this.sc.contracts.reseatDays * DAY);
    if (getAddress(await read<Address>("parties", "nominee", [tid])) !== next) {
      const ok = holderMay
        ? await this.act(holder, "parties", "nominateVerifier", [tid, next], "nominate", rid)
        : await this.vote(Action.NOMINATE_VERIFIER, ["uint256", "address"], [tid, next], "council-nominate", rid);
      if (!ok) return;
    }
    if (await this.act(next, "parties", "acceptSeat", [tid], "acceptSeat", rid)) {
      this.note("reseat", rid, `${nameOf(next)} takes the seat on #${rid}${seat.vacant ? "" : `, its verifier ${nameOf(c.verifier)} long overdue`}.`);
      await this.replacementPower(rid, tid, holder, holderCan);
    }
  }

  private async replacementPower(rid: number, tid: bigint, holder: Address, holderCan: boolean) {
    const ctx = await read("registry", "stepContext", [BigInt(rid)]);
    if (!ctx.flowHasPower || !holderCan) return;
    const c = await read("core", "getCovenant", [tid]);
    await this.act(holder, "deeds", "recordReplacementPower", [tid, h("power", tid, this.now), h("reg", tid, this.now), "RG/R", BigInt(N(c.termEnd) + YEAR)], "replacementPower", rid);
  }

  async yearly(rid: number, tid: bigint, c: any, st: any) {
    await this.claimTR3(rid, tid);
    if (N(c.status) !== CovenantStatus.ACTIVE) return;
    const termEnd = N(c.termEnd);
    const owner = getAddress(await read<Address>("token", "ownerOf", [tid]));
    // resale: the buyer has passed its identity check and accepted the Patron Subscription
    if (this.rand(10_000) < this.b.resalePct * 100 && this.now + DAY < termEnd) {
      const buyer = await this.patronFor(tid);
      if (buyer !== owner) {
        const base = this.priceOf.get(rid) ?? 10n ** 21n;
        const price = (base * BigInt(80 + this.rand(80))) / 100n + 1n;
        await this.topUp(buyer, price);
        if (this.rand(2) === 0) {
          if (await this.act(owner, "token", "list", [tid, price], "resale-list", rid)) {
            await this.act(buyer, "token", "buy", [tid, price], "resale-buy", rid);
          }
        } else if (await this.act(buyer, "token", "makeOffer", [tid, price], "resale-offer", rid)) {
          await this.act(owner, "token", "acceptOffer", [tid, buyer, price], "resale-accept", rid);
        }
      }
    }
    // the land changes hands (FM P6): the verifier approves, and the buyer accedes to the Grantor Agreement or not
    if (this.rand(1000) < this.b.landSalePermille && this.now + YEAR < termEnd && !this.landSaleAt.has(tid) && N(st.acct.holds) === 0) {
      const g2 = await this.newGuardian();
      if (await this.act(c.guardian, "parties", "proposeLandSale", [tid, g2, h("transfer deed", tid, this.now)], "proposeLandSale", rid)
        && await this.act(c.verifier, "parties", "approveLandSale", [tid], "approveLandSale", rid)) {
        const accede = this.chance(this.b.accedePct);
        this.landSaleAt.set(tid, accede ? this.now + (10 + this.rand(60)) * DAY : this.now + this.sc.contracts.accessionDays * DAY + DAY);
        this.note("land-sale", rid, `The land under #${rid} is sold to ${nameOf(g2)}: payments wait until it accedes to the Grantor Agreement.`);
      }
    }
  }

  async landSale(rid: number, tid: bigint) {
    if (this.now < this.landSaleAt.get(tid)!) return;
    this.landSaleAt.delete(tid);
    const s = await read("parties", "getSale", [tid]);
    if (s.acceded || N(s.approvedAt) === 0) return;
    if (this.now <= N(s.approvedAt) + this.sc.contracts.accessionDays * DAY) {
      if (await this.act(s.buyer, "parties", "accede", [tid, h("grantor agreement", tid)], "accede", rid)) {
        this.note("land-sale", rid, `${nameOf(s.buyer)} accedes to the Grantor Agreement on #${rid}: the held instalments are paid to it.`);
      }
    } else if (await this.act(this.server, "parties", "lapseAccession", [tid], "lapseAccession", rid)) {
      this.note("land-sale", rid, `${nameOf(s.buyer)} did not accede within six months: #${rid}'s landowner share goes to the patron from now on.`);
    }
  }

  async claimTR3(rid: number, tid: bigint) {
    const v = await read("tree", "rewardOf", [tid]);
    if (v.patronClaimable + v.guardianClaimable + v.referralClaimable === 0n) return;
    await this.act(this.patrons[0], "tree", "claim", [tid], "claimTR3", rid);
  }

  async finishCancelled(rid: number, tid: bigint) {
    if (tid !== 0n) {
      const c = await read("core", "getCovenant", [tid]);
      if (N(c.status) === CovenantStatus.CANCELLED && N(c.termStart) !== 0) {
        const w = await read("challenge", "getWindow", [tid]);
        if (N(w.openedAt) !== 0 && this.now <= N(w.closesAt)) { this.nextAt.set(rid, N(w.closesAt) + 1); return; }
        if ((await read<bigint>("challenge", "poolBalance", [tid])) !== 0n) {
          if (!(await this.act(this.patrons[0], "challenge", "sweepReviewPool", [tid], "sweepCancelled", rid))) {
            this.nextAt.set(rid, this.now + 30 * DAY);
            return;
          }
        }
        await this.claimTR3(rid, tid);
      }
    }
    this.done.add(rid);
  }

  // =====================================================================================
  /** A step the person has taken over is not sent: it waits on the screen as their move. */
  private yours(who: Address, c: Key, fn: string, args: readonly unknown[], label: string, rid: number): boolean {
    if (!this.control.mine(who, rid, `${c}.${fn}`)) return false;
    this.control.propose(this.now, who, c, fn, args, label, rid);
    return true;
  }

  // Challenges
  // =====================================================================================

  /** Raise a challenge under `option`. The challenger is an independent verifier of the country -- or, for 3E,
   *  the landowner itself. */
  async raise(option: number, subject: bigint, rid: number, verifier: Address, guardian: Address, country: number, forced?: number): Promise<string> {
    let ch: Address;
    if (option === Option.T3E) ch = getAddress(guardian);
    else {
      const exclude = option >= Option.T3A ? (await read("challenge", "getWindow", [subject])).attestor : zeroAddress;
      ch = await this.pickIndependent(country, verifier, guardian, exclude);
      if (ch === zeroAddress) return "No independent verifier is available to raise it.";
    }
    const cid = await read<bigint>("challenge", "nextChallengeId");
    const args = [option, subject, h("evidence", subject, this.now), "ipfs://evidence"];
    if (forced === undefined && this.yours(ch, "challenge", "raise", args, "raise", rid)) return "";
    if (option === Option.T3E) await fund(ch);
    const r = await send(ch, "challenge", "raise", args);
    this.actions++;
    if (r.ok) this.wrote("challenge");
    if (!r.ok) {
      if (forced === undefined) this.anomalies.push({ t: this.now, label: `raise ${OptionName[option]}`, rid, error: r.error });
      return `The challenge could not be raised: ${r.error}.`;
    }
    const weights = option <= Option.W1B ? this.b.preMintOutcomes : this.b.termOutcomes;
    const o = forced ?? this.pick(weights);
    this.plan.set(cid, o);
    this.challengeOf.set(cid, rid);
    this.openChallenges.push(cid);
    this.nextChallengePass = Math.min(this.nextChallengePass, this.now + DAY);
    this.note("challenge", rid, `${nameOf(ch)} raises challenge ${cid} on #${rid}, option ${OptionName[option]}. The panel will find it ${OutcomeName[o]}.`);
    return `${nameOf(ch)} raises challenge ${cid} (${OptionName[option]}). The panel will find it ${OutcomeName[o]}.`;
  }

  async challenges() {
    const t = this.now;
    for (let i = 0; i < this.openChallenges.length; i++) {
      const cid = this.openChallenges[i];
      if (cid === 0n) continue;
      const c = await read("challenge", "getChallenge", [cid]);
      const rid = this.challengeOf.get(cid) ?? 0;
      const o = this.plan.get(cid)!;
      let state = N(c.state);
      const openedAt = N(c.openedAt);
      if (state === ChallengeState.OPEN || state === ChallengeState.RESPONDED) {
        const deadline = N(await read("challenge", "deadlineOf", [cid]));
        if (o === Outcome.WITHDRAW) {
          await this.act(c.challenger, "challenge", "withdraw", [cid], "withdraw", rid);
          continue;
        }
        if (t >= deadline) { await this.act(this.server, "challenge", "lapse", [cid], "lapse", rid); continue; }
        if (state === ChallengeState.OPEN && t >= openedAt + 2 * DAY && this.rand(10) < 3) {
          if (await this.act(c.defendant, "challenge", "respond", [cid, "see the record"], "respond", rid)) state = ChallengeState.RESPONDED;
        }
        if (state === ChallengeState.RESPONDED || t >= openedAt + this.response) {
          await this.act(this.server, "challenge", "seatPanel", [cid], "seatPanel", rid);
        }
      } else if (state === ChallengeState.SEATED) {
        const deadline = N(await read("challenge", "deadlineOf", [cid]));
        if (o === Outcome.LAPSE) {
          if (t >= deadline) await this.act(this.server, "challenge", "lapse", [cid], "lapse", rid);
          continue;
        }
        if (t < N(c.seatedAt) + Math.min(3 * DAY, Math.max(DAY, deadline - N(c.seatedAt) - DAY))) continue;
        const upheld = o === Outcome.UPHOLD;
        let votes = 0;
        for (let k = 0; k < 3 && votes < 2; k++) {
          if (await this.attempt(c.panel[k], "challenge", "vote", [cid, upheld], rid)) votes++;
        }
        const after = await read("challenge", "getChallenge", [cid]);
        if (N(after.state) === ChallengeState.SEATED && t >= deadline) await this.act(this.server, "challenge", "lapse", [cid], "lapse", rid);
        else if (N(after.state) === ChallengeState.DETERMINED) {
          this.note("verdict", rid, `Challenge ${cid} (${OptionName[N(c.option)]}) is ${upheld ? "upheld" : "dismissed"}.`);
        }
      } else {
        this.openChallenges[i] = 0n; // decided, lapsed or withdrawn
        this.nextAt.set(rid, t);
      }
    }
  }

  // =====================================================================================
  // Governance, on a calendar
  // =====================================================================================

  /** How long one stage of the governance calendar lasts: a year, or less when a scenario compresses it. */
  calendarYear(): number {
    return this.sc.id === "holder-failure" ? Math.round(YEAR * 0.4) : YEAR;
  }

  async governance() {
    const t = this.now;
    if (this.emergencyEndAt !== 0 && t >= this.emergencyEndAt) {
      await this.act(this.server, "governance", "endExpiredFreeze", [this.emergencyHolder], "endExpiredFreeze");
      this.emergencyEndAt = 0;
    }
    if (this.unfreezeAt !== 0 && t >= this.unfreezeAt) {
      await this.vote(Action.UNFREEZE_HOLDER, ["address"], [this.unfreezeHolder], "unfreeze");
      this.unfreezeAt = 0;
    }
    if (this.feeSplitAt !== 0 && t >= this.feeSplitAt) {
      await this.act(this.foundation, "governance", "executeFeeSplit", [], "executeFeeSplit");
      this.feeSplitAt = 0;
    }
    if (t < this.start + (this.govStage + 1) * this.calendarYear()) return;
    const y = ++this.govStage;
    if (this.calendarYear() === YEAR || y % 2 === 0) await this.newPatron(); // a new identity-checked patron a year
    if (!this.b.governanceCalendar) return;
    const cs = this.sc.countries;
    const first = cs[0], second = cs[1] ?? cs[0], third = cs[2] ?? cs[cs.length - 1];
    const tas = (c: CountryConfig) => this.countryHolders.get(c.code) ?? [];
    if (y === 1) {
      const n = tas(first).length + 1;
      this.note("gov", 0, `${first.name} gains another Trust Admin: the Council admits ${first.short}-TA${n}, which opens an organisation of two verifiers.`);
      this.added = await this.admitHolder(`${first.short.toLowerCase()}${n}`, first, holderOrg(first.code, n), `${first.short}-TA${n}`);
      const v1 = await this.addVerifier(this.added, verifierOrg(first.code, n, 1), this.added, `${first.short}-N1`);
      if (v1) await this.addVerifier(this.added, verifierOrg(first.code, n, 1), v1, `${first.short}-N2`);
    } else if (y === 2) {
      this.note("gov", 0, "The Council records the Foundation's amended Articles on chain.");
      await this.vote(Action.RECORD_DOCUMENT, ["bytes32", "bytes32", "string"], [h("ARTICLES"), h("articles", t), "ipfs://articles"], "record the Articles");
    } else if (y === 4) {
      const target = tas(second)[1] ?? tas(second)[0];
      if (!target) return;
      this.note("gov", 0, `The emergency multisig freezes ${nameOf(target)}. Unless the Council ratifies it by day 30, it ends then.`);
      if (await this.act(this.emergency, "governance", "emergencyFreeze", [target], "emergencyFreeze")) {
        this.emergencyHolder = target;
        this.emergencyEndAt = t + 31 * DAY;
      }
    } else if (y === 6) {
      // the failing Trust Admin is one of the country's own, never the one just admitted to succeed it
      const own = tas(first).filter((x) => x !== this.added);
      const target = own[1] ?? own[0];
      if (!target || this.added === zeroAddress) return;
      this.note("gov", 0, `${nameOf(target)} is failing. The Council freezes it: no new covenants, and its 1% is withheld.`);
      if (await this.vote(Action.FREEZE_HOLDER, ["address"], [target], `freeze ${nameOf(target)}`)) this.frozenForReplacement = target;
    } else if (y === 7) {
      if (this.frozenForReplacement === zeroAddress) return;
      await this.jointReplacement(this.frozenForReplacement, this.added, first);
    } else if (y === 8) {
      const c = cs.find((x) => this.pathB.has(x.code)) ?? cs[cs.length - 1];
      const min = Math.min(c.maxTerm, c.minTerm + 4);
      const proposer = tas(c)[0];
      if (!proposer || min === c.minTerm) return;
      this.note("gov", 0, `${c.name}'s law changes: the minimum term rises from ${c.minTerm} to ${min} years, for new requests only.`);
      const sid = await read<bigint>("countries", "nextProposalId");
      if (await this.act(proposer, "countries", "proposeSettings",
        [c.code, { flowId: c.flowId, minTermYears: min, maxTermYears: c.maxTerm, listingWindow: c.listingDays * DAY, postSaleWindow: c.postSaleDays * DAY }, h("counsel")], "settings")) {
        if (await this.vote(Action.APPLY_SETTINGS, ["uint256"], [sid], `apply ${c.name} settings`)) c.minTerm = min;
      }
    } else if (y === 9) {
      const tid = await this.someActive();
      if (tid === 0n) return;
      this.note("gov", 0, `A road takes 30% of the land under EFT ${tid}: the Council records the compulsory acquisition; that share of the escrow goes to the patron, of the TR3 to the Reserve.`);
      await this.vote(Action.ACQUISITION, ["uint256", "uint16", "bytes32"], [tid, 300, h("gazette", tid)], "acquisition");
    } else if (y === 10 && cs.length > 1) {
      this.note("gov", 0, `The Council suspends ${third.name}: no new requests; covenants already there carry on.`);
      if (await this.vote(Action.SET_COUNTRY_STATUS, ["uint16", "uint8"], [third.code, 2], `suspend ${third.name}`)) this.suspended = third.code;
    } else if (y === 11 && this.suspended) {
      this.note("gov", 0, `The Council resumes ${countryName(this.suspended)}.`);
      await this.vote(Action.SET_COUNTRY_STATUS, ["uint16", "uint8"], [this.suspended, 1], "resume");
    } else if (y === 12) {
      const k = this.sc.contracts;
      if (k.verifierPermille + 5 + k.taxPermille >= 1000) return;
      this.note("gov", 0, `The Foundation proposes a new fee split: the verifier's share from ${k.verifierPermille / 10}% to ${(k.verifierPermille + 5) / 10}%, after a 48-hour timelock.`);
      await this.act(this.foundation, "governance", "proposeFeeSplit", [this.feeWallet, k.verifierPermille + 5, k.taxPermille, k.foundationPermille], "proposeFeeSplit");
      this.feeSplitAt = t + 48 * 3600 + 1;
    } else if (y === 13) {
      const tid = await this.someActive();
      if (tid === 0n) return;
      this.note("gov", 0, `The Council finds deliberate fraud behind EFT ${tid}: its TR3 ends, to the Reserve. The covenant and its instalments continue.`);
      await this.vote(Action.END_REWARD, ["uint256"], [tid], "end reward");
    } else if (y === 14) {
      this.note("gov", 0, "The Council rotates: GTA 4 joins, GTA 1 leaves.");
      const gta4 = register(labelAddress("gta4"), "GTA 4", "GTA");
      await fund(gta4);
      await this.identify(gta4);
      await this.vote(Action.ADD_GTA, ["address", "string"], [gta4, "ipfs://gta4"], "add GTA 4");
      await this.vote(Action.REMOVE_GTA, ["address"], [this.gtas[0]], "remove GTA 1");
    }
  }

  /** A Holder's replacement: the country's other Holders and the GTAs vote, more than half of them (FM p19, G3). */
  async jointReplacement(holder: Address, successor: Address, c: CountryConfig) {
    this.note("gov", 0, `The Council and ${c.name}'s other Trust Admins vote to replace ${nameOf(holder)} with ${nameOf(successor)}: its fee and authority follow, with the shares withheld since its freeze.`);
    const gtas = (await this.q<Address[]>("governance", "getGTAs")).map((a) => getAddress(a));
    const id = (await read<bigint>("governance", "replacementCount")) + 1n;
    if (!(await this.act(gtas[0], "governance", "proposeReplacement", [holder, successor], "proposeReplacement"))) return;
    const electors = [...gtas.slice(1), ...(this.countryHolders.get(c.code) ?? []).filter((x) => x !== holder)];
    for (const v of electors) {
      const [votes, needed] = await read<[bigint, bigint]>("governance", "replacementVotesOf", [id]);
      if (votes >= needed) break;
      await this.attempt(v, "governance", "voteReplacement", [id]);
    }
    if (await this.act(this.server, "governance", "executeReplacement", [id], "executeReplacement")
      && (await read<bigint>("bank", "heldForSuccessor", [holder])) > 0n) {
      await this.act(this.server, "bank", "releaseHeldHolderFees", [holder], "releaseHeldHolderFees");
    }
  }

  async someActive(): Promise<bigint> {
    for (const rid of this.requests) {
      if (this.done.has(rid)) continue;
      const r = await read("registry", "getRequest", [BigInt(rid)]);
      if (N(r.endReason) !== COMPLETED) continue;
      const c = await read("core", "getCovenant", [r.tokenId]);
      if (N(c.status) === CovenantStatus.ACTIVE && this.now + YEAR < N(c.termEnd)) return r.tokenId;
    }
    return 0n;
  }

  // =====================================================================================
  // Choosing people
  // =====================================================================================

  async pickVerifier(country: number, barred: Address, lapsed: Address, guardian: Address): Promise<Address> {
    const vs = this.countryVerifiers.get(country) ?? [];
    const off = this.rand(vs.length);
    const order = vs.map((_, i) => vs[(off + i) % vs.length])
      .filter((v) => v !== getAddress(barred) && v !== getAddress(lapsed) && v !== getAddress(guardian));
    const ok = await Promise.all(order.map(async (v) => (await this.q<boolean>("admin", "takesWork", [v]))
      && this.holderCan(await this.q<Address>("admin", "holderOf", [v]))));
    return order.find((_, i) => ok[i]) ?? zeroAddress;
  }

  /** A verifier of the country who takes work and is independent of `defendant`: another organisation, never in its
   *  organisation before (FM p2). */
  async pickIndependent(country: number, defendant: Address, guardian: Address, exclude: Address): Promise<Address> {
    const vs = this.countryVerifiers.get(country) ?? [];
    const off = this.rand(vs.length);
    const order = vs.map((_, i) => vs[(off + i) % vs.length])
      .filter((v) => v !== getAddress(defendant) && v !== getAddress(guardian) && v !== getAddress(exclude));
    const facts = await Promise.all(order.map((v) => Promise.all([
      this.q<boolean>("admin", "takesWork", [v]), this.q<boolean>("admin", "independentOf", [v, defendant]),
    ])));
    return order.find((_, i) => facts[i][0] && facts[i][1]) ?? zeroAddress;
  }

  /** A document's attester: an independent verifier; else another Holder of the country; else a GTA, from day 21. */
  async pickAttester(country: number, verifier: Address, guardian: Address, recordedAt: number): Promise<Address> {
    const v = await this.pickIndependent(country, verifier, guardian, zeroAddress);
    if (v !== zeroAddress) return v;
    const own = await this.q<Address>("admin", "holderOf", [verifier]);
    for (const hd of this.countryHolders.get(country) ?? []) {
      if (getAddress(hd) !== getAddress(own) && (await this.holderCan(hd))) return hd;
    }
    if (this.now >= recordedAt + this.sc.contracts.gtaAttestFromDays * DAY) return (await this.q<Address[]>("governance", "getGTAs"))[0];
    return zeroAddress;
  }

  /** A review window's attester: an independent verifier, another Holder, or a GTA from day 21 of the window. */
  async pickWindowAttester(country: number, verifier: Address, guardian: Address, openedAt: number): Promise<Address> {
    const v = await this.pickIndependent(country, verifier, guardian, zeroAddress);
    if (v !== zeroAddress) return v;
    const own = await this.q<Address>("admin", "holderOf", [verifier]);
    for (const hd of this.countryHolders.get(country) ?? []) {
      if (getAddress(hd) !== getAddress(own) && (await this.holderCan(hd))) return hd;
    }
    if (this.now >= openedAt + (this.review * 7) / 10) return (await this.q<Address[]>("governance", "getGTAs"))[0];
    return zeroAddress;
  }

  /** Any verifier of the country who takes work and is not of an organisation the removed one left; if none, its
   *  Trust Admin admits one in a new organisation. */
  async pickSuccessor(removed: Address, country: number, lost: Address = zeroAddress): Promise<Address> {
    const vs = this.countryVerifiers.get(country) ?? [];
    const orgRemoved = await this.q<bigint>("admin", "orgOf", [removed]);
    for (const v of vs) {
      // a verifier that lost the seat is never reseated on it
      if (v === getAddress(removed) || v === getAddress(lost) || !(await this.q<boolean>("admin", "takesWork", [v]))) continue;
      const ov = await this.q<bigint>("admin", "orgOf", [v]);
      if (ov === orgRemoved || (await this.q<boolean>("admin", "independentOf", [v, removed]))) {
        if (await this.holderCan(await this.q<Address>("admin", "holderOf", [v]))) return v;
      }
    }
    const hcur = await this.q<Address>("admin", "holderOf", [removed]);
    if (!(await this.holderCan(hcur))) return zeroAddress;
    const name = `${nameOf(removed).split("-")[0]}-R${++this.recruits}`;
    const recruit = register(labelAddress(`recruit.${name}`), name, "verifier");
    await fund(recruit);
    await this.identify(recruit);
    const org = BigInt(3_000_000 + this.recruits); // a new organisation: the Trust Admin invites its first member
    if ((await send(hcur, "admin", "addVerifier", [recruit, org, hcur, "ipfs://org", "ipfs://accreditation"])).ok) {
      this.wrote("admin");
      vs.push(recruit);
      this.note("recruited", 0, `${nameOf(hcur)} has no verifier free for the seat, and admits ${name} in a new organisation.`);
      return recruit;
    }
    return zeroAddress;
  }

  /** A patron with less than `need` tops up: late editions' parcels sell for far more. */
  async topUp(p: Address, need: bigint) {
    if ((await read<bigint>("usdt", "balanceOf", [p])) < need) {
      await this.act(p, "usdt", "mint", [p, need * 4n + 10n ** 24n], "patron top-up");
    }
  }

  async patronFor(tid: bigint): Promise<Address> {
    const c = await read("core", "getCovenant", [tid]);
    const owner = N(c.termStart) !== 0 ? getAddress(await read<Address>("token", "ownerOf", [tid])) : zeroAddress;
    const holder = getAddress(N(c.status) === CovenantStatus.MINTED || N(c.termStart) !== 0
      ? await read<Address>("core", "holderOf", [tid]) : await this.q<Address>("admin", "holderOf", [c.verifier]));
    for (let i = 0; i < this.patrons.length; i++) {
      const p = this.patrons[this.rand(this.patrons.length)];
      if (p !== getAddress(c.guardian) && p !== owner && p !== getAddress(c.verifier) && p !== holder) return p;
    }
    return this.patrons[1];
  }

  // =====================================================================================
  // Interventions: what a viewer can do between ticks
  // =====================================================================================

  /** A request someone made from the screen, not the simulation: its actors take it on from here, with nothing
   *  planned to go wrong. */
  adopt(rid: number, country: number) {
    if (this.countryOf[rid] !== undefined) return;
    this.requests.push(rid);
    this.countryOf[rid] = country;
    this.fate.set(rid, F.NORMAL);
    this.nextAt.set(rid, this.now + DAY);
  }

  async userRequest(country: number): Promise<string> {
    const rid = await this.arrival(country);
    return rid ? `Request #${rid} made in ${countryName(country)}.` : `${countryName(country)} is not taking requests.`;
  }

  /** A viewer raises a challenge: 1A before the mint, else 3B in an open review window (3D outside one). */
  async userChallenge(rid: number, outcome: number): Promise<string> {
    const r = await read("registry", "getRequest", [BigInt(rid)]);
    if (N(r.status) === RequestStatus.VERIFIED) {
      if (r.challenged || this.now > N(r.verifiedAt) + this.watchdog) return "The watchdog window has closed, or the verification was already challenged.";
      return this.raise(Option.W1A, BigInt(rid), rid, r.verifier, r.guardian, N(r.country), outcome);
    }
    if (r.tokenId === 0n) return "There is nothing to challenge yet: no verification is under review.";
    const tid: bigint = r.tokenId;
    const c = await read("core", "getCovenant", [tid]);
    if (N(c.termStart) === 0) return "The covenant has not started its term.";
    const w = await read("challenge", "getWindow", [tid]);
    const open = N(w.openedAt) !== 0 && this.now <= N(w.closesAt);
    this.windowPlan.set(tid, 0);
    return this.raise(open ? Option.T3B : Option.T3D, tid, rid, c.verifier, c.guardian, N(c.country), outcome);
  }

  async userBlock(rid: number): Promise<string> {
    const r = await read("registry", "getRequest", [BigInt(rid)]);
    if (r.tokenId === 0n) return "Only a minted covenant can be blocked.";
    const c = await read("core", "getCovenant", [r.tokenId]);
    const s = await send(c.verifier, "core", "blockCovenant", [r.tokenId, "breach reported by a viewer"]);
    this.actions++;
    if (s.ok) this.wrote("core");
    this.nextAt.set(rid, this.now);
    return s.ok ? `${nameOf(c.verifier)} blocks #${rid}. It cures the breach by re-verifying, or the landowner challenges the block.` : `The block was refused: ${s.error}.`;
  }

  async userFreezeDrip(rid: number, frozen: boolean): Promise<string> {
    const r = await read("registry", "getRequest", [BigInt(rid)]);
    if (r.tokenId === 0n) return "The covenant has no instalments yet.";
    const ok = await this.vote(Action.FREEZE_DRIP, ["uint256", "bool"], [r.tokenId, frozen], frozen ? "freeze drip" : "unfreeze drip", rid);
    return ok ? `The Council ${frozen ? "holds" : "releases"} #${rid}'s instalments.` : "The Council's vote failed; see Anomalies.";
  }

  async userEmergencyFreeze(holder: Address): Promise<string> {
    const s = await send(this.emergency, "governance", "emergencyFreeze", [holder]);
    this.actions++;
    if (s.ok) this.wrote("governance");
    return s.ok ? `The emergency multisig freezes ${nameOf(holder)}, for 30 days unless the Council ratifies it.` : `Refused: ${s.error}.`;
  }

  async userCountryStatus(country: number, enabled: boolean): Promise<string> {
    const ok = await this.vote(Action.SET_COUNTRY_STATUS, ["uint16", "uint8"], [country, enabled ? 1 : 2], enabled ? "resume" : "suspend");
    return ok ? `The Council ${enabled ? "resumes" : "suspends"} ${countryName(country)}.` : "The Council's vote failed.";
  }
}

export { Holds };
