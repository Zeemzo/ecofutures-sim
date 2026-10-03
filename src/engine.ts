// The ecosystem's actors. Each tick, everyone whose next move is due makes it, as a real transaction on the
// local chain. Who the actors are, how often each thing happens and which governance the programme meets all
// come from the run's scenario (config.ts); the defaults are the batch simulation's (test/sim/Ecosystem.t.sol).
import { encodeAbiParameters, keccak256, maxUint256, zeroAddress, getAddress, type Address } from "viem";
import { read, send, labelAddress, fund, addr, bulk, abis, type Key } from "./chain";
import {
  DAY, YEAR, RequestStatus, Step, CovenantStatus, SubjectKind, ChallengeState, Finding, WindowAction, Action, Outcome,
  OutcomeName, register, nameOf, countryName,
} from "./model";
import type { Scenario, Behaviour, CountryConfig } from "./config";

const N = (x: unknown) => Number(x);
const enc = (types: string[], values: unknown[]) =>
  encodeAbiParameters(types.map((type) => ({ type })), values as any);
const h = (...parts: (string | number | bigint)[]) =>
  keccak256(enc(parts.map((p) => (typeof p === "string" ? "string" : "uint256")), parts.map((p) => (typeof p === "number" ? BigInt(p) : p))));

export const LAST_EDITION = 12;

// pre-mint fates
const F = { NORMAL: 0, CANCEL: 1, CLAIM_LAPSE: 2, ABANDON: 3, CHALLENGE: 4, UNSOLD: 5, LAPSE_NOTHING: 6, LAPSE_UNATTESTED: 7 };

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
  notes: Note[] = [];
  kinds: Record<string, number> = {};
  onNote: (n: Note) => void = () => {};

  sc: Scenario;
  b: Behaviour;
  private acceptance: number;
  private watchdog: number;
  private backstop: number;
  private response: number;
  private pathB = new Set<number>(); // countries whose flow records after the sale

  // the cast
  foundation = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  server = labelAddress("server");
  serverWallet = labelAddress("serverWallet");
  gtas: Address[] = [];
  patrons: Address[] = [];
  holders: Record<string, Address> = {};
  /** Each country's Trust Admins, in order of admission. */
  countryHolders = new Map<number, Address[]>();
  countryVerifiers = new Map<number, Address[]>();
  private guardianNonce = 0;
  private recruits = 0;

  // per request
  requests: number[] = [];
  nextAt = new Map<number, number>();
  done = new Set<number>();
  fate = new Map<number, number>();
  submitAt = new Map<number, number>();
  listings = new Map<number, number>();
  bidPlaced = new Set<bigint>();
  priceOf = new Map<number, bigint>();
  windowSeen = new Map<bigint, number>();
  windowPlan = new Map<bigint, number>();
  windowActAt = new Map<bigint, number>();
  verifyAt = new Map<bigint, number>();
  planFor = new Map<bigint, number>();
  blockResolveAt = new Map<bigint, number>();
  yearlyAt = new Map<bigint, number>();
  openChallenges: bigint[] = [];
  plan = new Map<bigint, number>();
  challengeOf = new Map<bigint, number>();
  expiredTokens: bigint[] = [];
  listedExpired = new Set<bigint>();

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
  private removed: Address = zeroAddress;
  private added: Address = zeroAddress;
  private suspended = 0;

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
    this.backstop = k.backstopDays * DAY;
    this.response = k.responseDays * DAY;
    for (const c of scenario.countries) {
      const f = scenario.flows.find((x) => x.id === c.flowId);
      if (f && f.steps[f.steps.length - 1] !== Step.SALE) this.pathB.add(c.code);
    }
  }

  /** Arrivals have stopped and every request has run its course: the programme is over. */
  get finished(): boolean {
    return this.requests.length > 0 && this.arrivalsOver() && this.done.size === this.requests.length;
  }

  arrivalsOver(): boolean {
    if (this.b.maxRequests > 0 && this.requests.length >= this.b.maxRequests) return true;
    return this.b.fillLand ? this.landFull : this.now >= this.start + this.b.arrivalYears * YEAR;
  }

  rand(n: number) { return this.rng.next(n); }

  /** Everything the actors know and plan, to return to later (with the chain's own snapshot of the same moment). */
  capture(): EngineState {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this)) {
      // the reads it remembers are part of what it knows: a replay must start from the same memory
      // and so is the scenario: a law change moves a country's term range in it
      if (typeof v === "function" || k === "b" || k === "rng" || k === "volatile" || k === "preReq" || k === "preTerm") continue;
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
  private static STABLE = new Set(["holderOf", "orgOf", "verifierCountry"]);
  private static VOLATILE = new Set(["inStanding", "isActiveHolder", "isFrozen", "getGTAs"]);

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
    this.actions++;
    const r = await send(who, c, fn, args);
    if (!r.ok) this.anomalies.push({ t: this.now, label, rid, error: r.error });
    else this.wrote(c);
    return r.ok;
  }

  /** A call whose failure is expected and harmless (a panel member who already voted, an extra approval). */
  async attempt(who: Address, c: Key, fn: string, args: readonly unknown[]): Promise<boolean> {
    this.actions++;
    const ok = (await send(who, c, fn, args)).ok;
    if (ok) this.wrote(c);
    return ok;
  }

  /** A Council action. A GTA the action names (a removal) neither proposes nor approves. */
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
        await this.attempt(g, "governance", "approve", [pid]);
      }
    }
    return this.act(gtas[0], "governance", "execute", [pid], label, rid);
  }

  // =====================================================================================
  // The cast
  // =====================================================================================

  async setup(progress: (msg: string) => void = () => {}): Promise<void> {
    for (const [a, n, r] of [
      [this.foundation, "Foundation", "foundation"], [this.server, "Server", "server"],
      [this.serverWallet, "Server wallet", "server"],
    ] as [Address, string, string][]) register(a, n, r);
    await fund(this.server);
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

  /** A country's Trust Admins, each with its organisations of verifiers. */
  async castCountry(c: CountryConfig) {
    let letter = 0;
    for (let i = 1; i <= c.holders; i++) {
      const ta = await this.admitHolder(`${c.short.toLowerCase()}${i}`, c, holderOrg(c.code, i), `${c.short}-TA${i}`);
      for (let o = 1; o <= c.orgsPerHolder; o++) {
        const L = LETTERS[letter++ % LETTERS.length];
        let first: Address | null = null;
        for (let v = 1; v <= c.verifiersPerOrg; v++) {
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
    if (await this.vote(Action.ADMIT_HOLDER, ["address", "uint16", "uint256", "string"], [a, c.code, BigInt(org), "ipfs://holder"], `admit ${name}`)) {
      if (!this.countryHolders.has(c.code)) this.countryHolders.set(c.code, []);
      this.countryHolders.get(c.code)!.push(a);
    }
    return a;
  }

  async addVerifier(holder: Address, org: number, inviter: Address, name: string): Promise<Address | null> {
    const v = register(labelAddress(`verifier.${name}`), name, "verifier");
    await fund(v);
    if (!(await this.act(holder, "admin", "addVerifier", [v, BigInt(org), inviter, "ipfs://org", "ipfs://accreditation"], `add ${name}`))) return null;
    const c = N(await this.q("admin", "verifierCountry", [v]));
    if (!this.countryVerifiers.has(c)) this.countryVerifiers.set(c, []);
    this.countryVerifiers.get(c)!.push(v);
    return v;
  }

  async newPatron(): Promise<Address> {
    const i = this.patrons.length;
    const p = register(labelAddress(`patron.${i}`), `Patron ${i + 1}`, "patron");
    await fund(p);
    await this.act(p, "usdt", "mint", [p, 100_000_000n * 10n ** 18n], "patron funds");
    await this.act(p, "usdt", "approve", [addr.bank, maxUint256], "patron approve");
    await this.act(p, "usdt", "approve", [addr.token, maxUint256], "patron approve");
    await this.act(this.server, "admin", "setKyc", [p, true], "kyc");
    this.patrons.push(p);
    return p;
  }

  async newGuardian(funds = 1_000_000n * 10n ** 18n): Promise<Address> {
    const n = ++this.guardianNonce;
    const g = register(labelAddress(`guardian.${n}`), `Guardian ${n}`, "guardian");
    await fund(g);
    await this.act(g, "usdt", "mint", [g, funds], "guardian funds");
    await this.act(g, "usdt", "approve", [addr.registry, maxUint256], "guardian approve");
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
  }

  async tick(t: number): Promise<void> {
    this.now = t;
    this.volatile.clear();
    const mean = YEAR / Math.max(0.1, this.b.arrivalsPerYear);
    while (!this.arrivalsOver() && t >= this.nextArrival) {
      if (this.b.fillLand && N(await read("tree", "currentEdition")) >= LAST_EDITION) {
        this.landFull = true;
        this.landFullAt = t;
        this.note("land-full", 0, `Edition ${LAST_EDITION}, the last, has begun: the land the editions schedule is taken. No more landowners are admitted; the covenants already made run out their terms.`);
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
  }

  /** The earliest moment anyone has something to do. */
  nextDue(): number {
    let m = this.arrivalsOver() ? Infinity : this.nextArrival;
    for (const rid of this.requests) if (!this.done.has(rid)) m = Math.min(m, this.nextAt.get(rid) ?? m);
    if (this.openChallenges.some((c) => c !== 0n)) m = Math.min(m, this.nextChallengePass);
    if (this.b.governanceCalendar) m = Math.min(m, this.start + (this.govStage + 1) * this.calendarYear());
    for (const x of [this.emergencyEndAt, this.unfreezeAt, this.feeSplitAt]) if (x) m = Math.min(m, x);
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
    const [fee, , att, jud] = await read<bigint[]>("countries", "quote", [country, BigInt(land)]);
    const g = await this.newGuardian(2n * (fee + att + jud) + 1000n * 10n ** 18n);
    const ref = this.rand(3) === 0 ? this.patrons[this.rand(this.patrons.length)] : zeroAddress;
    const rid = N(await read("registry", "nextRequestId"));
    const parcel = keccak256(enc(["string", "address"], ["parcel", g]));
    const ok = await this.act(g, "registry", "requestVerification",
      [country, BigInt(land), term, parcel, ref, fee + att + jud, "sim"], "request", rid);
    if (!ok) return 0;
    this.requests.push(rid);
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
      if (N(r.endReason) === 7) await this.term(rid, r.tokenId);
      else await this.finishCancelled(rid, r.tokenId);
      return;
    }
    if (status === RequestStatus.OPEN) {
      if (this.fate.get(rid) === F.CANCEL) {
        await this.act(r.guardian, "registry", "cancelRequest", [BigInt(rid)], "cancel", rid);
        this.nextAt.set(rid, t + DAY);
        return;
      }
      const v = await this.pickVerifier(N(r.country), r.barred, zeroAddress, r.guardian);
      if (v === zeroAddress) { this.nextAt.set(rid, t + 30 * DAY); return; }
      if (await this.act(v, "registry", "claim", [BigInt(rid)], "claim", rid)) {
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
        [BigInt(rid), score, 2 + this.rand(5), 1 + this.rand(3), h("title", rid), h("folios", rid), "ipfs://eft"], "submit", rid);
      this.nextAt.set(rid, t + DAY);
      return;
    }
    if (status === RequestStatus.VERIFIED) {
      const verifiedAt = N(r.verifiedAt);
      if (this.fate.get(rid) === F.CHALLENGE && !r.challenged && t <= verifiedAt + this.watchdog) {
        await this.raise(SubjectKind.REQUEST, BigInt(rid), rid, r.verifier, r.guardian, N(r.country));
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

  async holderCan(holder: Address): Promise<boolean> {
    const [active, frozen] = await Promise.all([this.q<boolean>("admin", "isActiveHolder", [holder]), this.q<boolean>("admin", "isFrozen", [holder])]);
    return active && !frozen;
  }

  private shortOf(country: number) {
    return this.sc.countries.find((c) => c.code === country)?.short ?? "XX";
  }

  async flow(rid: number, r: any, t: number): Promise<void> {
    const s = await read("registry", "stepContext", [BigInt(rid)]);
    const holder: Address = await this.q("admin", "holderOf", [r.verifier]);
    const holderCan = await this.holderCan(holder);
    const term = N(r.termYears);
    const step = N(s.step);
    this.nextAt.set(rid, t + 3 * DAY + this.rand(10) * DAY);
    if (step === Step.POWER) {
      if (!holderCan) return; // waits for a successor, or an unfreeze
      await this.act(holder, "deeds", "grantPower", [BigInt(rid), h("power", rid, t), BigInt(t + (term + 3) * YEAR)], "grantPower", rid);
    } else if (step === Step.POWER_ANCHOR) {
      if (this.b.governanceCalendar && !this.revokeDone && this.govStage >= 5) {
        // a Trust Admin revokes a power without the Council's authority: recorded, and it is frozen
        this.revokeDone = true;
        if (await this.vote(Action.REVOKE_POWER, ["uint256", "bool"], [BigInt(rid), false], "revokePower", rid)) {
          // an unauthorised revocation freezes the Trust Admin -- if it is still active; a removed one has no authority left
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
      await this.act(r.verifier, "deeds", "anchorPower", [BigInt(rid), h("reg", rid), "RG"], "anchorPower", rid);
    } else if (step === Step.DEED || step === Step.AGREEMENT) {
      const by = this.rand(2) === 0 || !holderCan ? r.verifier : holder;
      // each document its own: a flow may record several (an agreement, then a deed)
      await this.act(by, "deeds", "recordDocument", [BigInt(rid), h(step === Step.AGREEMENT ? "agreement" : "deed", rid, N(s.cursor)), BigInt(t), `${this.shortOf(N(r.country))}-REG`], "recordDeed", rid);
    } else if (step === Step.RECORDING) {
      const saleAt = N(r.saleAt), post = N(r.postSaleWindow);
      if (t > saleAt + post) {
        await this.act(holder, "registry", "lapseSale", [BigInt(rid)], "lapseSale", rid);
        this.fate.set(rid, F.NORMAL);
        this.listings.set(rid, 0);
        return;
      }
      if (this.fate.get(rid) === F.LAPSE_NOTHING || !holderCan) { this.nextAt.set(rid, saleAt + post + 1); return; }
      await this.act(holder, "deeds", "recordDocument", [BigInt(rid), h("recording", rid), BigInt(t), "R.7"], "recordRecording", rid);
    } else if (step === Step.ATTEST) {
      const saleAt = N(r.saleAt), post = N(r.postSaleWindow);
      if (saleAt !== 0 && (this.fate.get(rid) === F.LAPSE_UNATTESTED || t > saleAt + post)) {
        if (t > saleAt + post) await this.act(holder, "registry", "lapseSale", [BigInt(rid)], "lapseSale", rid);
        else this.nextAt.set(rid, saleAt + post + 1);
        return;
      }
      const doc = await read("deeds", "getDocument", [BigInt(rid), BigInt(N(s.cursor) - 1)]);
      let a = await this.pickIndependent(N(r.country), r.verifier, r.guardian, zeroAddress);
      if (a === zeroAddress) {
        // nobody independent: the backstop, once its delay has passed
        const recordedAt = N(doc.recordedAt);
        if (t <= recordedAt + this.backstop) { this.nextAt.set(rid, recordedAt + this.backstop + 1); return; }
        a = (await this.q<Address[]>("governance", "getGTAs"))[0];
      }
      await this.act(a, "deeds", "attest", [BigInt(rid), doc.docHash], "attest", rid);
      this.nextAt.set(rid, t + DAY);
    } else if (step === Step.MINT) {
      // Land and term must fit the edition current at the mint as well as at the request (Lifecycle v5 §5).
      const land = N(r.landUnits);
      const [minL, maxL, maxY] = await Promise.all([
        read("tree", "minLandUnits"), read("tree", "maxLandUnits"), read("tree", "maxYearsFor", [BigInt(land)]),
      ]);
      if (land < N(minL) || land > N(maxL) || term > N(maxY)) {
        if (await this.act(r.guardian, "registry", "abandonRequest", [BigInt(rid)], "abandon-stranded", rid)) {
          this.note("stranded", rid, `Request #${rid} is stranded: the edition moved on and its ${land / 100} ha no longer fit. The guardian abandons it, after paying the verifier and the attester.`);
        }
        return;
      }
      await this.act(r.guardian, "registry", "mint", [BigInt(rid)], "mint", rid);
      this.nextAt.set(rid, t + DAY);
    } else if (step === Step.SALE) {
      await this.sale(rid, r, t);
    }
  }

  async sale(rid: number, r: any, t: number): Promise<void> {
    const tid: bigint = r.tokenId;
    if (await read<boolean>("bank", "hasAuction", [tid])) {
      const au = await read("bank", "getAuction", [tid]);
      const endsAt = N(au.endsAt);
      if (t > endsAt) {
        await this.act(this.patrons[0], "bank", "settleAuction", [tid], "settle", rid);
        this.nextAt.set(rid, t + DAY);
        return;
      }
      // a bid leaves an hour's margin: within a step, each transaction's block moves the chain's clock on
      if (!this.bidPlaced.has(tid) && this.fate.get(rid) !== F.UNSOLD && t >= N(au.startsAt) && endsAt - t > 3600) {
        const p = await this.patronFor(tid);
        const start: bigint = au.startPrice;
        const price = start + (start * BigInt(this.rand(30))) / 100n;
        await this.topUp(p, price);
        if (await this.act(p, "bank", "bid", [tid, price], "bid", rid)) {
          this.bidPlaced.add(tid);
          this.priceOf.set(rid, price);
        }
      }
      this.nextAt.set(rid, endsAt + 1);
      return;
    }
    const [, deadline] = await read<[boolean, bigint]>("registry", "listingInfo", [tid]);
    const closeAt = N(r.listingFrom) + N(r.listingWindow);
    if (t > closeAt) {
      await this.act(this.patrons[0], "registry", "closeUnsold", [BigInt(rid)], "closeUnsold", rid);
      this.nextAt.set(rid, t + DAY);
      return;
    }
    const listed = this.listings.get(rid) ?? 0;
    const length = Math.max(this.sc.contracts.minAuctionDays, 7) * DAY;
    if (t + length > N(deadline) || listed >= 3) { this.nextAt.set(rid, closeAt + 1); return; }
    const c = await read("core", "getCovenant", [tid]);
    const floor = await read<bigint>("countries", "priceFloorFor", [c.landUnits, c.termYears, c.country]);
    const startPrice = floor + (floor * BigInt(this.rand(150))) / 100n;
    this.bidPlaced.delete(tid);
    if (await this.act(c.guardian, "bank", "listForAuction", [tid, startPrice, 0n, BigInt(length)], "list", rid)) {
      this.listings.set(rid, listed + 1);
      // the auction opens at once: a patron bids in the same visit, so a long step cannot skip the bidding
      if (this.fate.get(rid) !== F.UNSOLD) {
        const p = await this.patronFor(tid);
        const price = startPrice + (startPrice * BigInt(this.rand(30))) / 100n;
        await this.topUp(p, price);
        if (await this.act(p, "bank", "bid", [tid, price], "bid", rid)) {
          this.bidPlaced.add(tid);
          this.priceOf.set(rid, price);
        }
      }
    }
    this.nextAt.set(rid, t + 2 * DAY);
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
    let acct = st.acct;
    let w = st.w;
    const holder: Address = await this.q("admin", "holderOf", [c.verifier]);
    const holderCan = await this.holderCan(holder);
    let next = t + 30 * DAY;
    const termEnd = N(c.termEnd);

    if (status === CovenantStatus.BLOCKED) {
      if (!this.blockResolveAt.get(tid)) this.blockResolveAt.set(tid, t + 20 * DAY + this.rand(40) * DAY);
      if (t >= this.blockResolveAt.get(tid)!) {
        const cancel = this.rand(100) < this.b.cancelOfBlockPct;
        const fn = cancel ? "cancelCovenant" : "unblockCovenant";
        if (holderCan) await this.act(holder, "core", fn, [tid], cancel ? "cancel" : "unblock", rid);
        else await this.vote(cancel ? Action.CANCEL_COVENANT : Action.UNBLOCK_COVENANT, ["uint256"], [tid], cancel ? "council-cancel" : "council-unblock", rid);
        this.blockResolveAt.delete(tid);
        this.nextAt.set(rid, t + DAY);
        return;
      }
      this.nextAt.set(rid, this.blockResolveAt.get(tid)!);
      return;
    }

    // ---- the review window ----
    const openedAt = N(w.openedAt), closesAt = () => N(w.closesAt);
    if (openedAt !== 0 && openedAt !== this.windowSeen.get(tid)) {
      this.windowSeen.set(tid, openedAt);
      const p = this.rand(10_000) / 100;
      this.windowPlan.set(tid, p < this.b.attestPct ? 1 : p < this.b.attestPct + this.b.challengePct ? 2 : 0);
      const span = Math.max(1, Math.floor((closesAt() - openedAt) / DAY) - 3);
      this.windowActAt.set(tid, openedAt + Math.min(2 * DAY + this.rand(20) * DAY, span * DAY));
    }
    if (openedAt !== 0 && !w.settled) {
      const wp = this.windowPlan.get(tid) ?? 0;
      if (wp !== 0 && t >= this.windowActAt.get(tid)! && t <= closesAt() && N(w.action) === WindowAction.NONE) {
        if (wp === 1) {
          const a = await this.pickIndependent(N(c.country), c.verifier, c.guardian, zeroAddress);
          if (a !== zeroAddress) await this.act(a, "challenge", "attestVerification", [tid], "attestVerification", rid);
        } else {
          await this.raise(SubjectKind.COVENANT, tid, rid, c.verifier, c.guardian, N(c.country));
        }
        this.windowPlan.set(tid, 0);
      }
      if (t > closesAt() && N(w.action) !== WindowAction.CHALLENGED) {
        await this.act(this.patrons[0], "challenge", "closeWindow", [tid], "closeWindow", rid);
        st = await this.termState(tid); // closing released what the window cleared
        w = st.w;
        acct = st.acct;
      } else if (t <= closesAt()) {
        const plan = this.windowPlan.get(tid) ?? 0;
        next = Math.min(next, plan !== 0 ? this.windowActAt.get(tid)! : closesAt() + 1, closesAt() + 1);
      }
    }

    // ---- the seat ----
    if (st.vacant || (st.overdue && !st.undecided)) {
      await this.reseat(rid, tid, c, holder, holderCan);
      st = await this.termState(tid);
      c = st.c;
    }

    // ---- verification ----
    const due = st.due;
    const windowRan = N(w.openedAt) === 0 || w.settled || t > N(w.closesAt);
    const verifiedThrough = N(c.verifiedThrough);
    if (due !== 0 && this.planFor.get(tid) !== verifiedThrough + 1) {
      this.planFor.set(tid, verifiedThrough + 1);
      const d = this.rand(10_000) / 100;
      const delay = d < this.b.onTimePct ? this.rand(20) : d < this.b.onTimePct + this.b.littleLatePct ? 20 + this.rand(8) : 40 + this.rand(20);
      this.verifyAt.set(tid, due + delay * DAY);
    }
    const released = N(acct.released);
    const frozen = st.frozen;
    let cure = due === 0 && released < verifiedThrough && w.settled && !frozen;
    cure = cure || (released < verifiedThrough && w.settled && frozen && st.breachHold);
    if (!st.vacant && windowRan && !st.undecided) {
      if ((due !== 0 && t >= this.verifyAt.get(tid)! && t >= due) || cure) {
        const late = due !== 0 && t - due > this.sc.contracts.maxVerificationDelayDays * DAY;
        if (await this.act(c.verifier, "core", "verify", [tid, this.rescore(N(c.ecoScore)), 0, ""], "verify", rid)) {
          if (cure) this.note("cure", rid, `${nameOf(c.verifier)} re-verifies #${rid} to release instalments held by a finding.`);
          else if (late) this.note("late", rid, `${nameOf(c.verifier)} verifies #${rid} ${Math.round((t - due) / DAY)} days late.`);
          if (this.rand(1000) < this.b.blockPermille && t < termEnd) {
            await this.act(c.verifier, "core", "blockCovenant", [tid, "breach found on the land"], "block", rid);
          }
        }
        this.nextAt.set(rid, t + DAY);
        return;
      }
    }
    if (due !== 0) { const va = this.verifyAt.get(tid)!; next = Math.min(next, va > t ? va : t + 7 * DAY); }

    // ---- once a year: TR3, resale, payee, overcharge ----
    if (t >= (this.yearlyAt.get(tid) ?? 0)) {
      this.yearlyAt.set(tid, t + YEAR);
      await this.yearly(rid, tid, c);
    }
    next = Math.min(next, this.yearlyAt.get(tid)!);

    // ---- the end of the term ----
    if (t >= termEnd) {
      if (!this.listedExpired.has(tid)) {
        this.listedExpired.add(tid);
        this.expiredTokens.push(tid);
        this.note("term-ended", rid, `#${rid}'s term ends. Its last instalments release as their windows settle.`);
      }
      const total = N(acct.totalReleases);
      if (N(c.verifiedThrough) >= total && N(acct.released) >= total && w.settled) {
        if ((await read<bigint>("challenge", "poolBalance", [tid])) !== 0n) {
          await this.act(this.patrons[0], "challenge", "sweepReviewPool", [tid], "sweep", rid);
        }
        await this.claimTR3(rid, tid);
        this.note("complete", rid, `#${rid} is complete: every instalment released, the review pool settled.`);
        this.done.add(rid);
        return;
      }
    }
    this.nextAt.set(rid, next);
  }

  // What each due request's first look reads, fetched for all of them at once at the start of a tick. A
  // visit uses its prefetch once; anything it reads after acting is read fresh. Requests' states do not
  // depend on one another, so another request's visit earlier in the tick cannot make it stale.
  private preReq = new Map<number, any>();
  private preTerm = new Map<bigint, Awaited<ReturnType<Engine["termState"]>>>();

  async prefetch(rids: number[]) {
    const reqs = await Promise.all(rids.map((rid) => bulk.readContract({ address: addr.registry, abi: abis.registry, functionName: "getRequest", args: [BigInt(rid)] })));
    rids.forEach((rid, i) => this.preReq.set(rid, reqs[i]));
    const terms = rids.map((rid, i) => [rid, reqs[i] as any] as const).filter(([, r]) => N(r.status) === RequestStatus.ENDED && N(r.endReason) === 7);
    const states = await Promise.all(terms.map(([, r]) => this.termState(r.tokenId, true)));
    terms.forEach(([, r], i) => this.preTerm.set(r.tokenId, states[i]));
  }

  /** Everything a term visit looks at, read in one parallel wave. */
  async termState(tid: bigint, batched = false) {
    const r = <T = any>(c: Key, fn: string) => (batched
      ? bulk.readContract({ address: addr[c], abi: abis[c], functionName: fn, args: [tid] }) as Promise<T>
      : read<T>(c, fn, [tid]));
    const [c, acct, w, vacant, overdue, undecided, due, frozen, breachHold] = await Promise.all([
      r("core", "getCovenant"), r("bank", "getAccount"), r("challenge", "getWindow"),
      r<boolean>("challenge", "seatVacant"), r<boolean>("core", "isVerificationOverdue"),
      r<boolean>("challenge", "hasUndecidedChallenge"), r("core", "nextVerificationDue"),
      r<boolean>("bank", "isFrozen"), r<boolean>("challenge", "breachHold"),
    ]);
    return { c, acct, w, vacant, overdue, undecided, due: N(due), frozen, breachHold };
  }

  rescore(score: number): number {
    if (this.rand(10) !== 0) return 0;
    return Math.max(1, Math.min(100, score + this.rand(21) - 10));
  }

  async reseat(rid: number, tid: bigint, c: any, holder: Address, holderCan: boolean) {
    const next = await this.pickSuccessor(c.verifier, N(c.country));
    if (next === zeroAddress) return;
    if (getAddress(await read<Address>("core", "nominee", [tid])) !== next) {
      const ok = holderCan
        ? await this.act(holder, "core", "nominateVerifier", [tid, next], "nominate", rid)
        : await this.vote(Action.NOMINATE_VERIFIER, ["uint256", "address"], [tid, next], "council-nominate", rid);
      if (!ok) return;
    }
    await this.act(next, "core", "acceptSeat", [tid], "acceptSeat", rid);
  }

  async yearly(rid: number, tid: bigint, c: any) {
    await this.claimTR3(rid, tid);
    if (N(c.status) !== CovenantStatus.ACTIVE) return;
    const termEnd = N(c.termEnd);
    let owner = getAddress(await read<Address>("token", "ownerOf", [tid]));
    // resale
    if (this.rand(10_000) < this.b.resalePct * 100 && this.now + DAY < termEnd) {
      const buyer = await this.patronFor(tid);
      if (buyer !== owner) {
        const base = this.priceOf.get(rid) ?? 10n ** 21n;
        const price = (base * BigInt(80 + this.rand(80))) / 100n + 1n;
        await this.topUp(buyer, price);
        if (await this.act(owner, "token", "list", [tid, price], "resale-list", rid)) {
          await this.act(buyer, "token", "buy", [tid, price], "resale-buy", rid);
        }
      }
    }
    // the land changes hands
    if (this.rand(1000) < this.b.payeeSwitchPermille && this.now + DAY < termEnd) {
      const g2 = await this.newGuardian();
      if (await this.act(c.guardian, "core", "proposePayee", [tid, g2], "proposePayee", rid)) {
        await this.act(g2, "core", "acceptPayee", [tid], "acceptPayee", rid);
      }
    }
    if (!this.b.overcharge) return;
    // overcharge with an expired EFT of the same owner
    owner = getAddress(await read<Address>("token", "ownerOf", [tid]));
    const reward = await read("tree", "rewardOf", [tid]);
    if (N(c.edition) >= 3 && N(reward.multiplier) === 1 && this.now + DAY < termEnd && !(await read<boolean>("bank", "isFrozen", [tid]))) {
      for (const fuel of this.expiredTokens) {
        if (fuel === tid) continue;
        const fc = await read("core", "getCovenant", [fuel]);
        if (N(fc.status) !== CovenantStatus.ACTIVE || N(fc.edition) >= N(c.edition)) continue;
        if (await read<boolean>("overcharge", "spentAsFuel", [fuel])) continue;
        if (getAddress(await read<Address>("token", "ownerOf", [fuel])) !== owner) continue;
        await this.act(owner, "overcharge", "overcharge", [tid, fuel], "overcharge", rid);
        break;
      }
    }
  }

  async claimTR3(rid: number, tid: bigint) {
    const v = await read("tree", "rewardOf", [tid]);
    if (v.patronClaimable + v.guardianClaimable + v.referralClaimable === 0n) return;
    await this.act(this.patrons[0], "tree", "claim", [tid], "claimTR3", rid);
  }

  async finishCancelled(rid: number, tid: bigint) {
    if (tid !== 0n && N((await read("core", "getCovenant", [tid])).status) === CovenantStatus.CANCELLED) {
      const w = await read("challenge", "getWindow", [tid]);
      const closable = w.settled || (N(w.action) !== WindowAction.CHALLENGED && this.now > N(w.closesAt));
      if ((await read<bigint>("challenge", "poolBalance", [tid])) !== 0n && closable) {
        await this.act(this.patrons[0], "challenge", "sweepReviewPool", [tid], "sweepCancelled", rid);
      }
      await this.claimTR3(rid, tid);
      if ((await read<bigint>("challenge", "poolBalance", [tid])) !== 0n) {
        this.nextAt.set(rid, this.now + 30 * DAY);
        return;
      }
    }
    this.done.add(rid);
  }

  // =====================================================================================
  // Challenges
  // =====================================================================================

  async raise(kind: number, subject: bigint, rid: number, defendant: Address, guardian: Address, country: number, forced?: number): Promise<string> {
    const exclude = kind === SubjectKind.COVENANT ? (await read("challenge", "getWindow", [subject])).attestor : zeroAddress;
    const ch = await this.pickIndependent(country, defendant, guardian, exclude);
    if (ch === zeroAddress) return "No independent verifier is available to raise it.";
    const cid = await read<bigint>("challenge", "nextChallengeId");
    const r = await send(ch, "challenge", "raise", [kind, subject, "the record does not match the land"]);
    this.actions++;
    if (r.ok) this.wrote("challenge");
    if (!r.ok) {
      if (forced === undefined) this.anomalies.push({ t: this.now, label: "raise", rid, error: r.error });
      return `The challenge could not be raised: ${r.error}.`;
    }
    const weights = kind === SubjectKind.REQUEST ? this.b.preMintOutcomes.map((w, i) => (i === Outcome.BREACH ? 0 : w)) : this.b.termOutcomes;
    const o = forced ?? this.pick(weights);
    this.plan.set(cid, o);
    this.challengeOf.set(cid, rid);
    this.openChallenges.push(cid);
    this.nextChallengePass = Math.min(this.nextChallengePass, this.now + DAY);
    return `${nameOf(ch)} raises challenge ${cid}. The panel will find: ${OutcomeName[o]}.`;
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
        if (o === Outcome.WITHDRAW) {
          await this.act(c.challenger, "challenge", "withdraw", [cid], "withdraw", rid);
          continue;
        }
        if (state === ChallengeState.OPEN && t >= openedAt + 2 * DAY && this.rand(10) < 3) {
          await this.act(c.defendant, "challenge", "respond", [cid, "see the record"], "respond", rid);
          state = ChallengeState.RESPONDED;
        }
        if (state === ChallengeState.RESPONDED || t >= openedAt + this.response) {
          await this.act(this.patrons[0], "challenge", "seatPanel", [cid], "seatPanel", rid);
        }
      } else if (state === ChallengeState.SEATED) {
        const deadline = N(await read("challenge", "deadlineOf", [cid]));
        if (o === Outcome.LAPSE) {
          if (t >= deadline) await this.act(this.patrons[0], "challenge", "lapse", [cid], "lapse", rid);
          continue;
        }
        if (t < N(c.seatedAt) + Math.min(3 * DAY, Math.max(DAY, deadline - N(c.seatedAt) - DAY))) continue;
        const upheld = o === Outcome.SCORE || o === Outcome.DOCUMENTS;
        const f = o === Outcome.SCORE ? Finding.SCORE : o === Outcome.DOCUMENTS ? Finding.DOCUMENTS : Finding.NONE;
        let votes = 0;
        for (let k = 0; k < 3 && votes < 2; k++) {
          if (await this.attempt(c.panel[k], "challenge", "vote", [cid, upheld, f, o === Outcome.BREACH])) votes++;
        }
        if (N((await read("challenge", "getChallenge", [cid])).state) !== ChallengeState.DETERMINED && t >= deadline) {
          await this.act(this.patrons[0], "challenge", "lapse", [cid], "lapse", rid);
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
      await this.act(this.foundation, "governance", "endExpiredFreeze", [this.emergencyHolder], "endExpiredFreeze");
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
      this.note("gov", 0, `${first.name} gains another Trust Admin: the Council admits ${first.short}-TA${n}, which admits two verifiers.`);
      this.added = await this.admitHolder(`${first.short.toLowerCase()}${n}`, first, holderOrg(first.code, n), `${first.short}-TA${n}`);
      const v1 = await this.addVerifier(this.added, verifierOrg(first.code, n, 1), this.added, `${first.short}-N1`);
      if (v1) await this.addVerifier(this.added, verifierOrg(first.code, n, 1), v1, `${first.short}-N2`);
    } else if (y === 4) {
      const target = tas(second)[1] ?? tas(second)[0];
      if (!target) return;
      this.note("gov", 0, `The server freezes ${nameOf(target)} in an emergency. If the Council does not ratify it, it ends after 30 days.`);
      if (await this.act(this.server, "governance", "emergencyFreeze", [target], "emergencyFreeze")) {
        this.emergencyHolder = target;
        this.emergencyEndAt = t + 31 * DAY;
      }
    } else if (y === 6) {
      // the failing Trust Admin is one of the country's own, never the one just admitted to succeed it
      const own = tas(first).filter((x) => x !== this.added);
      const target = own[1] ?? own[0];
      if (!target || this.added === zeroAddress) return;
      this.note("gov", 0, `${nameOf(target)} fails. The Council removes it; until a successor is named, only the Council acts on its covenants.`);
      if (await this.vote(Action.REMOVE_HOLDER, ["address"], [target], `remove ${nameOf(target)}`)) this.removed = target;
    } else if (y === 7) {
      if (this.removed === zeroAddress) return;
      this.note("gov", 0, `The Council names ${nameOf(this.added)} the successor of ${nameOf(this.removed)}: its fee and its authority follow, with the shares held for it since the removal.`);
      if (await this.vote(Action.REPLACE_HOLDER, ["address", "address"], [this.removed, this.added], "replace Trust Admin")
        && (await read<bigint>("bank", "heldForSuccessor", [this.removed])) > 0n) {
        await this.act(this.foundation, "bank", "releaseHeldHolderFees", [this.removed], "releaseHeldHolderFees");
      }
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
      await this.act(this.foundation, "governance", "proposeFeeSplit", [this.serverWallet, k.verifierPermille + 5, k.taxPermille, k.serverPermille], "proposeFeeSplit");
      this.feeSplitAt = t + 48 * 3600 + 1;
    } else if (y === 14) {
      this.note("gov", 0, "The Council rotates: GTA 4 joins, GTA 1 leaves.");
      const gta4 = register(labelAddress("gta4"), "GTA 4", "GTA");
      await fund(gta4);
      await this.vote(Action.ADD_GTA, ["address", "string"], [gta4, "ipfs://gta4"], "add GTA 4");
      await this.vote(Action.REMOVE_GTA, ["address"], [this.gtas[0]], "remove GTA 1");
    }
  }

  // =====================================================================================
  // Choosing people
  // =====================================================================================

  async pickVerifier(country: number, barred: Address, lapsed: Address, guardian: Address): Promise<Address> {
    const vs = this.countryVerifiers.get(country) ?? [];
    const off = this.rand(vs.length);
    const order = vs.map((_, i) => vs[(off + i) % vs.length])
      .filter((v) => v !== getAddress(barred) && v !== getAddress(lapsed) && v !== getAddress(guardian));
    const ok = await Promise.all(order.map(async (v) => (await this.q<boolean>("admin", "inStanding", [v]))
      && this.holderCan(await this.q<Address>("admin", "holderOf", [v]))));
    return order.find((_, i) => ok[i]) ?? zeroAddress;
  }

  /** Of the country, in standing, another organisation and another Trust Admin than the defendant's. */
  async pickIndependent(country: number, defendant: Address, guardian: Address, exclude: Address): Promise<Address> {
    const vs = this.countryVerifiers.get(country) ?? [];
    const off = this.rand(vs.length);
    const [dh, dorg] = await Promise.all([this.q<Address>("admin", "holderOf", [defendant]), this.q<bigint>("admin", "orgOf", [defendant])]);
    const order = vs.map((_, i) => vs[(off + i) % vs.length])
      .filter((v) => v !== getAddress(defendant) && v !== getAddress(guardian) && v !== getAddress(exclude));
    const facts = await Promise.all(order.map((v) => Promise.all([
      this.q<boolean>("admin", "inStanding", [v]), this.q<bigint>("admin", "orgOf", [v]), this.q<Address>("admin", "holderOf", [v]),
    ])));
    return order.find((_, i) => facts[i][0] && facts[i][1] !== dorg && getAddress(facts[i][2]) !== getAddress(dh)) ?? zeroAddress;
  }

  /** Another of the same Trust Admin's verifiers, from another organisation than the one losing the seat; if
   *  it has none, the Trust Admin admits a verifier in a new organisation. */
  async pickSuccessor(current: Address, country: number): Promise<Address> {
    const vs = this.countryVerifiers.get(country) ?? [];
    const [hcur, ocur] = await Promise.all([this.q<Address>("admin", "holderOf", [current]), this.q<bigint>("admin", "orgOf", [current])]);
    for (const v of vs) {
      if (v === getAddress(current) || !(await this.q<boolean>("admin", "inStanding", [v]))) continue;
      const [hv, ov] = await Promise.all([this.q<Address>("admin", "holderOf", [v]), this.q<bigint>("admin", "orgOf", [v])]);
      if (getAddress(hv) === getAddress(hcur) && ov !== ocur) return v;
    }
    if (!(await this.holderCan(hcur))) return zeroAddress;
    const name = `${nameOf(current).split("-")[0]}-R${++this.recruits}`;
    const recruit = register(labelAddress(`recruit.${name}`), name, "verifier");
    await fund(recruit);
    const org = BigInt(3_000_000 + this.recruits); // a new organisation: the Trust Admin invites its first member
    if ((await send(hcur, "admin", "addVerifier", [recruit, org, hcur, "ipfs://org", "ipfs://accreditation"])).ok) {
      this.wrote("admin");
      vs.push(recruit);
      this.note("recruited", 0, `${nameOf(hcur)} has no verifier in another organisation free, and admits ${name} in a new one.`);
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
    for (let i = 0; i < this.patrons.length; i++) {
      const p = this.patrons[this.rand(this.patrons.length)];
      if (p !== getAddress(c.guardian) && p !== owner && p !== getAddress(c.verifier)) return p;
    }
    return this.patrons[1];
  }

  // =====================================================================================
  // Interventions: what a viewer can do between ticks
  // =====================================================================================

  async userRequest(country: number): Promise<string> {
    const rid = await this.arrival(country);
    return rid ? `Request #${rid} made in ${countryName(country)}.` : `${countryName(country)} is not taking requests.`;
  }

  async userChallenge(rid: number, outcome: number): Promise<string> {
    const r = await read("registry", "getRequest", [BigInt(rid)]);
    if (N(r.status) === RequestStatus.VERIFIED) {
      if (r.challenged || this.now > N(r.verifiedAt) + this.watchdog) return "The watchdog window has closed, or the verification was already challenged.";
      if (outcome === Outcome.BREACH) return "A pre-mint challenge cannot find the land in breach.";
      return this.raise(SubjectKind.REQUEST, BigInt(rid), rid, r.verifier, r.guardian, N(r.country), outcome);
    }
    if (r.tokenId === 0n) return "There is nothing to challenge yet: no verification is under review.";
    const tid: bigint = r.tokenId;
    const w = await read("challenge", "getWindow", [tid]);
    if (N(w.openedAt) === 0 || w.settled || this.now > N(w.closesAt) || N(w.action) !== WindowAction.NONE) {
      return "No review window is open for a challenge. One opens with each re-verification.";
    }
    const c = await read("core", "getCovenant", [tid]);
    this.windowPlan.set(tid, 0);
    return this.raise(SubjectKind.COVENANT, tid, rid, c.verifier, c.guardian, N(c.country), outcome);
  }

  async userBlock(rid: number): Promise<string> {
    const r = await read("registry", "getRequest", [BigInt(rid)]);
    if (r.tokenId === 0n) return "Only a minted covenant can be blocked.";
    const c = await read("core", "getCovenant", [r.tokenId]);
    const s = await send(c.verifier, "core", "blockCovenant", [r.tokenId, "breach reported by a viewer"]);
    this.actions++;
    if (s.ok) this.wrote("core");
    this.nextAt.set(rid, this.now);
    return s.ok ? `${nameOf(c.verifier)} blocks #${rid}. Its Trust Admin will unblock or cancel it.` : `The block was refused: ${s.error}.`;
  }

  async userFreezeDrip(rid: number, frozen: boolean): Promise<string> {
    const r = await read("registry", "getRequest", [BigInt(rid)]);
    if (r.tokenId === 0n) return "The covenant has no instalments yet.";
    const ok = await this.vote(Action.FREEZE_DRIP, ["uint256", "bool"], [r.tokenId, frozen], frozen ? "freeze drip" : "unfreeze drip", rid);
    return ok ? `The Council ${frozen ? "holds" : "releases"} #${rid}'s instalments.` : "The Council's vote failed; see Anomalies.";
  }

  async userEmergencyFreeze(holder: Address): Promise<string> {
    const s = await send(this.server, "governance", "emergencyFreeze", [holder]);
    this.actions++;
    if (s.ok) this.wrote("governance");
    return s.ok ? `The server freezes ${nameOf(holder)} in an emergency, for 30 days unless the Council ratifies it.` : `Refused: ${s.error}.`;
  }

  async userCountryStatus(country: number, enabled: boolean): Promise<string> {
    const ok = await this.vote(Action.SET_COUNTRY_STATUS, ["uint16", "uint8"], [country, enabled ? 1 : 2], enabled ? "resume" : "suspend");
    return ok ? `The Council ${enabled ? "resumes" : "suspends"} ${countryName(country)}.` : "The Council's vote failed.";
  }
}
