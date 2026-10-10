// Audits a run from the chain alone: every event since block 0, every failed transaction, and the state now,
// checked against the protocol's rules as V12 has them. Writes sim/out/audit-<name>/{events.jsonl,failed.jsonl,audit.json}.
//
//   RPC=http://127.0.0.1:8545 NAME=live npx tsx scripts/audit.ts
//
// Sources, as each check names them: the Covenant Flow Map v25 (FM, by page), the TR3 Final Model v6 and the
// Overcharge & Reserve addendum, the V12 decisions (D1-D15, contracts/docs/decisions/V12_Decisions.md), the build
// notes (contracts/docs/build-notes/V12_Build_Notes.md), and the contract function that enforces the rule.
//
// Dropped from V11's audit, because V12 removed what they tested: tr3-settled, tr3-settled-mints and tr3-accounted
// (Tree.settle and PlaceSettled are gone: a place is never settled, its stream is released at each verification and
// the rest credited to the Reserve; tr3-supply-breakdown and tr3-stream-conservation replace them); tr3-burned (now one
// component of the supply breakdown); the V11 edition model where a land spans editions (D1: a land goes wholly into
// one edition); RewardStarted's `projected` (the allocation is fixed at the mint, the score applied per release);
// backstop-delay (EcoDeeds has no backstop delay: a GTA attests from gtaAttestFrom, see gta-attest-from); the
// same-Trust-Admin reseat rule (gone: reseat-rule tests V12's); the term finding/inBreach of a verdict (the option alone
// decides it now, see challenge-consequences); and the loose judgment/refund transactions of events-match-transfers
// (JudgmentPaid names its voters and RequestEnded's refund goes to the request's guardian, so every payment is exact).
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { decodeEventLog, decodeFunctionData, getAddress, getContractAddress, parseAbiItem, zeroAddress, type Abi, type Log } from "viem";
import { loadDeployment, abis, bulk, addr, type Key } from "../src/chain";
import { Step, CovenantStatus, BlockReason, Option, Holds, RequestStatus } from "../src/model";

const NAME = process.env.NAME ?? "live";
// the analysis folder: v11/sim inside the contracts repo, sim/ beside the simulator on its own
const SIM = "../sim/"; // the analysis folder, sim/ in this repository
const OUT = process.env.AUDIT_OUT ? new URL(`file://${process.env.AUDIT_OUT.replace(/\/?$/, "/")}`) : new URL(`${SIM}out/audit-${NAME}/`, import.meta.url);
mkdirSync(OUT, { recursive: true });
// The addresses: from DEPLOYMENT if given, else from the chain. The app deploys from anvil's first account in a
// fixed order (the currency, the forwarder, then Admin's implementation and proxy), so Admin's proxy is its fourth
// contract (nonce 3); Admin's directory names the rest.
if (process.env.DEPLOYMENT) await loadDeployment(JSON.parse(readFileSync(process.env.DEPLOYMENT, "utf8")));
else {
  const adminAddr = getContractAddress({ from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", nonce: 3n });
  const dir = await bulk.readContract({ address: adminAddr, abi: abis.admin, functionName: "directory" }) as any;
  const usdt = await bulk.readContract({ address: dir.registry, abi: abis.registry, functionName: "currency" }) as `0x${string}`;
  const scale = await bulk.readContract({ address: dir.tree, abi: abis.tree, functionName: "editionScale" }) as bigint;
  await loadDeployment({ ...dir, usdt, lens: zeroAddress, forwarder: zeroAddress, editionScale: Number(scale), deployedAt: 0 });
}

const DAY = 86400;
const N = (x: unknown) => Number(x);
const B = (x: unknown) => BigInt(x as any);
const L = (a: unknown) => String(a).toLowerCase();
const Z = zeroAddress.toLowerCase();
const keyOf = new Map<string, Key>();
for (const k of Object.keys(abis) as Key[]) if (addr[k] && L(addr[k]) !== Z) keyOf.set(L(getAddress(addr[k])), k);
// the contracts that hold money: the Registry (upfront), the Market (the price in escrow), the Bank (the term's
// instalments) and EcoChallenge (the review pools)
const protocol = new Set((["registry", "market", "bank", "challenge"] as Key[]).map((k) => L(getAddress(addr[k]))));

// =====================================================================================
// 1. Pull the chain
// =====================================================================================

const head = await bulk.getBlock({ blockTag: "latest" });
const last = head.number!;
const now = N(head.timestamp);
const at = { blockNumber: last };
console.log(`chain head ${last}, ${new Date(now * 1000).toISOString().slice(0, 10)}`);

type Ev = { block: number; tx: string; i: number; ord: number; t: number; c: Key; name: string; a: Record<string, any> };
const events: Ev[] = [];
const transfers: { tx: string; from: string; to: string; value: bigint }[] = [];
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const STEP = 4000n;
const blocksWithLogs = new Set<bigint>();
const raw: Log[] = [];
for (let from = 0n; from <= last; from += STEP) {
  const to = from + STEP - 1n > last ? last : from + STEP - 1n;
  const logs = await bulk.getLogs({ fromBlock: from, toBlock: to });
  for (const l of logs) { raw.push(l); blocksWithLogs.add(l.blockNumber!); }
}
const times = new Map<bigint, number>();
const blockList = [...blocksWithLogs];
for (let i = 0; i < blockList.length; i += 500) {
  const bs = await Promise.all(blockList.slice(i, i + 500).map((n) => bulk.getBlock({ blockNumber: n })));
  for (const b of bs) times.set(b.number!, N(b.timestamp));
}
for (const l of raw) {
  const c = keyOf.get(L(l.address));
  if (!c) continue;
  if (c === "usdt") {
    try {
      const d = decodeEventLog({ abi: [transferEvent], data: l.data, topics: l.topics as any });
      transfers.push({ tx: l.transactionHash!, from: L((d.args as any).from), to: L((d.args as any).to), value: (d.args as any).value });
    } catch {}
    continue;
  }
  try {
    const d = decodeEventLog({ abi: abis[c], data: l.data, topics: l.topics as any, strict: false }) as any;
    events.push({ block: N(l.blockNumber), tx: l.transactionHash!, i: N(l.logIndex), ord: N(l.blockNumber) * 100000 + N(l.logIndex), t: times.get(l.blockNumber!)!, c, name: d.eventName, a: d.args ?? {} });
  } catch {}
}
events.sort((x, y) => x.ord - y.ord);
console.log(`${events.length} protocol events, ${transfers.length} USDT transfers`);

// failed transactions: every block's receipts
type Failed = { block: number; t: number; from: string; to: string; fn: string; expected: boolean };
const failed: Failed[] = [];
let txCount = 0;
const allAbi = Object.values(abis).flat() as Abi;
for (let from = 1n; from <= last; from += 250n) {
  const nums: bigint[] = [];
  for (let n = from; n < from + 250n && n <= last; n++) nums.push(n);
  const blocks = await Promise.all(nums.map((n) => bulk.getBlock({ blockNumber: n, includeTransactions: true })));
  const receipts = await Promise.all(blocks.flatMap((b) => b.transactions.map((tx: any) => bulk.getTransactionReceipt({ hash: tx.hash }))));
  const txs = blocks.flatMap((b) => b.transactions.map((tx: any) => ({ tx, t: N(b.timestamp), block: N(b.number) })));
  txCount += txs.length;
  txs.forEach(({ tx, t, block }, i) => {
    if (receipts[i].status === "success") return;
    let fn = tx.input.slice(0, 10);
    try { fn = decodeFunctionData({ abi: allAbi, data: tx.input }).functionName; } catch {}
    const target = keyOf.get(L(tx.to)) ?? tx.to;
    // the simulation tries these knowing they may fail (Engine.attempt): an extra Council approval or country
    // vote, a panel member who already voted or whose vote came after the decision
    const expected = (target === "governance" && (fn === "approve" || fn === "voteCountry")) || (target === "challenge" && fn === "vote");
    failed.push({ block, t, from: tx.from, to: String(target), fn, expected });
  });
}
console.log(`${txCount} transactions, ${failed.length} failed (${failed.filter((f) => !f.expected).length} unexpected)`);

writeFileSync(new URL("events.jsonl", OUT), events.map((e) => JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n"));
writeFileSync(new URL("failed.jsonl", OUT), failed.map((f) => JSON.stringify(f)).join("\n"));

/** D16: a covenant's block causes as Core keeps them (bits: 1 breach, 2 Deed off the register, 4 partition). */
const causeBit = (reason: number) => (reason === 2 ? 2 : reason === 3 ? 4 : 1);
const topCause = (causes: number) => (causes & 2 ? 2 : causes & 4 ? 3 : 1);
/** A cause lifted on its own (a Deed restored, a partition ended): another still standing keeps the covenant blocked. */
function liftCause(c: any, bit: number) {
  c.causes = (c.causes ?? 0) & ~bit;
  if (c.causes) { c.status = CovenantStatus.BLOCKED; c.blockReason = topCause(c.causes); }
}

// =====================================================================================
// 2. The checks
// =====================================================================================

type Check = { id: string; area: string; rule: string; source: string; checked: number; failures: { ref: string; detail: string }[] };
const checks: Check[] = [];
const observations: Record<string, unknown> = {};
type C = { ok(): void; fail(ref: string, detail: string): void; test(cond: boolean, ref: string, detail: () => string): void };
function check(id: string, area: string, rule: string, source: string): C {
  const c: Check = { id, area, rule, source, checked: 0, failures: [] };
  checks.push(c);
  return {
    ok() { c.checked++; },
    fail(ref: string, detail: string) { c.checked++; c.failures.push({ ref, detail }); },
    test(cond: boolean, ref: string, detail: () => string) { if (cond) c.checked++; else this.fail(ref, detail()); },
  };
}
const idx = new Map<string, Ev[]>();
const byTx = new Map<string, Ev[]>();
for (const e of events) {
  const k = `${e.c}.${e.name}`;
  (idx.get(k) ?? idx.set(k, []).get(k)!).push(e);
  (byTx.get(e.tx) ?? byTx.set(e.tx, []).get(e.tx)!).push(e);
}
const E = (k: string) => idx.get(k) ?? [];
/** The events of `e`'s transaction named `k`, optionally filtered. */
const inTx = (e: Ev, k: string, pred: (x: Ev) => boolean = () => true) => (byTx.get(e.tx) ?? []).filter((x) => `${x.c}.${x.name}` === k && pred(x));
const usd = (v: bigint) => (Number(v / 10n ** 12n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
const days = (x: number) => `${(x / DAY).toLocaleString("en-US", { maximumFractionDigits: 2 })} days`;
const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const short = (a: string) => `${String(a).slice(0, 8)}…`;
const reqOfToken = new Map<bigint, number>();
for (const e of E("registry.CovenantMinted")) reqOfToken.set(B(e.a.tokenId), N(e.a.requestId));
const R = (tid: bigint) => `#${reqOfToken.get(tid) ?? "?"} (EFT ${tid})`;
const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].map(L).sort()) === JSON.stringify([...b].map(L).sort());

// ---- the configuration the contracts run with, read from the chain ----
const rd = (k: Key, fn: string, args: unknown[] = []) => bulk.readContract({ address: addr[k], abi: abis[k], functionName: fn, args, ...at }) as Promise<any>;
const [coreClocks, deedClocks, partyClocks] = await Promise.all([rd("core", "clocks"), rd("deeds", "clocks"), rd("parties", "clocks")]);
const cfg = Object.fromEntries(await Promise.all(([
  ["year", "core", "yearLength"], ["maxDelay", "core", "maxVerificationDelay"], ["acceptance", "registry", "acceptanceWindow"],
  ["watchdog", "registry", "watchdogWindow"], ["minAuction", "market", "minAuctionDuration"], ["kyc", "market", "kycWindow"],
  ["review", "challenge", "reviewWindow"], ["response", "challenge", "responseWindow"], ["panel", "challenge", "panelWindow"],
  ["redraw", "challenge", "redrawWindow"], ["haltAfter", "challenge", "haltAfterRuns"], ["emergency", "governance", "EMERGENCY_FREEZE"],
  ["cooldown", "governance", "EMERGENCY_COOLDOWN"],
] as [string, Key, string][]).map(async ([k, c, fn]) => [k, N(await rd(c, fn))]))) as Record<string, number>;
Object.assign(cfg, {
  restore: N(coreClocks[0]), damage: N(coreClocks[1]),
  power: N(deedClocks[0]), anchoring: N(deedClocks[1]), attestation: N(deedClocks[2]), decision: N(deedClocks[3]),
  gtaFrom: N(deedClocks[4]), guardianFrom: N(deedClocks[5]),
  firstClaim: N(partyClocks[0]), reseat: N(partyClocks[1]), accession: N(partyClocks[2]),
});
const deadline = cfg.response + cfg.panel + cfg.redraw;
const USD = B(await rd("bank", "usd"));
const editionScale = B(await rd("tree", "editionScale"));
const defaultV0 = B(await rd("countries", "defaultBaseFee"));

// EcoFees, in bigint: the same arithmetic the contracts use
const WAD = 10n ** 18n;
const isqrt = (x: bigint) => { if (x === 0n) return 0n; let z = (x + 1n) / 2n, y = x; while (z < y) { y = z; z = (x / z + z) / 2n; } return y; };
const scaleFor = (u: bigint) => WAD + isqrt(((u * WAD) / 100n) * WAD);
const reviewFeeOf = (u: bigint, d: bigint) => (d * (scaleFor(u) + WAD / 2n)) / WAD;
const deskOf = (v: bigint) => (v * 4n) / 50n;
const floorOf = (u: bigint, years: bigint, d: bigint, twice: boolean) => reviewFeeOf(u, d) * (twice ? 2n : 1n) * (years === 0n ? 1n : years) * 100n;
const poolPermilleOf = (tax: bigint, fnd: bigint) => { const ap = tax - fnd; return ap - ap / 2n; };
const trancheSplit = (tranche: bigint, vp: bigint, tax: bigint, fnd: bigint) => {
  const ap = tax - fnd;
  const gross = (tranche * 1000n) / (1000n - (ap - ap / 2n));
  const v = (gross * vp) / 1000n, f = (gross * fnd) / 1000n, h = (gross * (ap / 2n)) / 1000n;
  return { v, f, h, g: tranche - v - f - h };
};
// the TR3 model: 21 editions of 10,000,000 TR3; edition n holds SCALE x F^2 land-years
const fib = (n: number) => { let a = 0n, b = 1n; if (n === 0) return 0n; for (let i = 1; i < n; i++) [a, b] = [b, a + b]; return b; };
const LAST_EDITION = 21;
const PER_EDITION = 10_000_000n * WAD;
const MAX_SUPPLY = BigInt(LAST_EDITION) * PER_EDITION;
const MAX_BASE = 1_000_000n * WAD;
const capOf = (n: number) => editionScale * fib(n) * fib(n);

// =====================================================================================
// The checks, in the order they are reported. Each names the rule and its source.
// =====================================================================================

// Money: the upfront payment
const upCons = check("upfront-conservation", "Money", "What the landowner paid at the request (verification fee + attestation fee + judgment fee + execution allowance) = what was paid out of it + what the Registry still holds for it; each refund is exactly what was left", "FM p9; D10; EcoRegistry._finish");
const upParts = check("upfront-parts", "Money", "Each part goes out whole, once, to its payee: the verification fee to the request's verifier at the first attestation (or a refusal or abandonment); the judgment fee to the watchdog judges who voted, or else to the verifier; the attestation fee to the attester of the flow's last document; the allowance only to the request's Holder, never more than it", "FM p8-9; D10, D12; EcoRegistry._payShare, _payVerifier, onAttested, _payJudgment, payAllowance");
// Money: the sale and the term
const saleCons = check("sale-conservation", "Money", "Sale price = review pool + every instalment released + payouts to the patron + an End Date's held payout + balance still held", "FM p9; EcoBank");
const bankRep = check("bank-replay", "Money", "Each account replayed from its events (balance, instalments released, years of consideration paid, holds) is the account the Bank holds now", "EcoBank");
const pool1 = check("pool-share", "Money", "The review pool is the configured share of the sale (half the tax after the Foundation's: 1% in production), sent to EcoChallenge at the finalisation", "FM p9; EcoFees.reviewPool; EcoBank.openAccount");
const split4 = check("instalment-split", "Money", "Each release pays the annual consideration first, then splits the rest four ways on its gross-equivalent: verifier, Foundation and Holder their permille, the landowner the residual (with the consideration)", "FM p9; EcoBank._distribute; EcoFees.trancheSplit");
const consC = check("consideration-first", "Money", "Each release pays the consideration owed for the protocol years begun so far (USD 10 a hectare, at least USD 50), before the split, the first year's from the first instalment; at an End Date with a breach or Deed hold the consideration owed goes to the landowner before the patron", "FM p9; D11; EcoBank._considerationOwed, closeAccount");
const relC = check("release-schedule", "Money", "Instalments are released only as verifications cover them, and then all that are covered (up to the term's last); never while a hold is set (breach, vacancy, Deed, halt, accession, Council)", "FM p9, P7; EcoBank._releaseTo, setHold");
const vshare = check("verifier-share", "Money", "Over a completed term with one fee split, the verifier earns its permille of the gross-equivalent of everything not paid as consideration: (price - pool - consideration) x 7 / 99 in production, within rounding", "FM p9; EcoFees.trancheSplit");
const hfee = check("holder-fee", "Money", "The Holder's share goes to the covenant's Holder fixed at the mint, along its succession line (never a reseated verifier's Holder); it is withheld exactly when that Holder is removed or frozen, and released only to its successor (or itself once unfrozen)", "D7; FM p19; EcoBank._distribute, releaseHeldHolderFees; Core.holderOf");
const poolC = check("pool-conservation", "Money", "A review pool's funding = what it paid out + what it still holds", "FM p17; EcoChallenge");
const winFee = check("window-fee", "Money", "An attested review window that covered a new interval pays its attester one act's fee (the pool / the term's acts) when it settles; an unattested, off-schedule or forfeited (3A upheld) window pays nothing", "FM p17; EcoChallenge._settle; build notes (off-schedule windows carry no fee)");
const chFee = check("challenge-fee-split", "Money", "A decided term challenge is paid one act's fee: 40% shared equally by the judges who voted, and when upheld the other 60% to the challenger; a lapse pays the judges who voted their 40%; a withdrawal pays nothing. A watchdog challenge pays its judges the judgment fee, the first voter the remainder; with no voter it stays for the verifier", "FM p15-17; EcoChallenge._payChallenge, _close; EcoRegistry._payJudgment");
const sweep = check("pool-sweep", "Money", "What a pool still holds after the End Date goes, whole, to the landowner (or to the EFT's owner when the covenant was cancelled), and only after it", "EcoChallenge.sweepReviewPool");
const evTr = check("events-match-transfers", "Money", "In every transaction, what the payment events say each party received = the USDT the protocol (Registry, Market, Bank, EcoChallenge) actually transferred to it", "Every payment event");
// TR3
const trSplit = check("tr3-split", "TR3", "Of everything a covenant has released: the patron's 90% and the landowner's 10% (a referrer taking 30% of it) are what has been claimed plus what is claimable; and the claim events add up to what Tree says was paid", "Tree._due; GUARDIAN_PERCENT, REFERRAL_PERCENT_OF_GUARDIAN");
const trRef = check("tr3-referrer", "TR3", "A referrer who is a verifier, a Trust Admin or a GTA when the claim is made takes nothing; its share stays with the landowner", "Tree._referrerEligible ('no TR3 to anyone who judges a score')");
const trCap = check("tr3-cap", "TR3", "No allocation is above 1,000,000 TR3, and no covenant's land TR3 (released less boosts) above its allocation", "Tree.MAX_BASE_TR3; Tree.place");
const trSup = check("tr3-supply", "TR3", "TR3's supply = everything the claim events minted = minted to patrons + guardians + referrers", "Tree");
const plc = check("edition-placement", "Editions", "At its mint each land takes its place in the open edition, wholly: one that does not fit in the room left closes the edition and goes to the next (only the 21st's last land takes the room left); its TR3 at a score of 100 = land-years x 10,000,000 / the edition's size, at most 1,000,000", "D1; Tree.place; FM p10");
const cls = check("edition-close", "Editions", "An edition closes when it is full, when a land does not fit in it, or eight protocol years after it opened; what no land took is burned, and the next opens (at the clock's mark, or now)", "D1; TR3 model v6; Tree._close, _roll");
const edState = check("edition-state", "Editions", "The editions replayed from the events end where Tree is now: the open edition, the land-years placed in it and when it opened", "Tree.editionOpen, editionUsed, editionOpenedAt");
const plRel = check("place-released", "Editions", "A minted land that never became a covenant leaves its edition when its request ends: its room reopens while the edition is open, else its TR3 is burned; a covenant's land is never released", "FM p10; Tree.release; EcoRegistry._finish");
const asg = check("edition-assignment", "Editions", "Each covenant activates in the edition, and with the land-years, its land was placed with", "Tree.assignEdition; Core.activate");
const rew = check("tr3-reward", "TR3", "Each covenant's stream starts with its place's TR3 at a score of 100 as its allocation, at the covenant's score", "Tree.startReward; TR3 model v6");
const relScore = check("tr3-release-score", "TR3", "Each release is at the score in force since the last (at the new score when the release lifts a 3B hold), and the score's shortfall goes to the Reserve: released = floor((released + credited) x score / 100)", "Tree._settle, pass; addendum (ECOSCORE source); FM p16 (3B back-paid at the corrected score)");
const strCons = check("tr3-stream-conservation", "TR3", "Every allocation is accounted exactly: what was released + what was credited to the Reserve (score shortfall, late days, holds, an early end, an acquired part) = the allocation once the stream ends, and never more before", "Tree._settle, _end, endPart; addendum");
const late = check("late-verification", "TR3", `A re-verification is late only past its due date + the grace (${days(cfg.maxDelay)}): it records when it fell overdue, and the late days' TR3 goes to the Reserve`, "D3; Core.verify; Tree._settle (BLOCKED source)");
const brk = check("tr3-supply-breakdown", "TR3", "Every TR3 of the 210,000,000 is minted, owed, in the Reserve, committed to a boost, streaming, unplaced or burned: each part as the events give it, and the unallocated remainder within rounding dust of the capacity no land has taken", "Tree.supplyBreakdown, unplacedCapacity; addendum point 6");
const ovc = check("overcharge", "TR3", "A Relic's cap is the land TR3 its source released (boosts excluded), minted only for a covenant that reached its End Date; transmutation sums two same-edition caps an edition lower; a boost's multiplier is F(target) / F(Relic) and its commit the least of the remaining allocation x (M - 1), the cap and the Reserve; each release pays it x (M - 1) from the commit, and what is left returns at the end", "addendum; EcoOvercharge; Tree.commitBoost, _boost, _end");
const land = check("land-at-request", "Editions", "Every request's land is 100 m2 to 33.33 x F hectares, F of the edition open at the request", "TR3 model v6; Tree.minLandUnits, maxLandUnits");
const term = check("term-at-request", "Editions", "Every request's term is within its country's range and no longer than 100 x F / hectares (3-100)", "TR3 model v6; Tree.maxYearsFor; EcoCountries.requestTerms");
// Timing and the term
const wd = check("watchdog", "Challenges", `A watchdog challenge (W1A, W1B) is raised against the request's current verification, within the watchdog window after it (${days(cfg.watchdog)})`, "FM p15; EcoRegistry.challengeTarget");
const winOpt = check("window-options", "Challenges", "3A and 3B are raised only inside an open review window and not by its attester; 3E only by the landowner of a covenant blocked for a breach; every term option only in the term; one undecided challenge per subject", "FM p15-17; build notes (rules of ours); EcoChallenge.raise");
const raiser = check("challenge-raiser", "Challenges", "Every challenger but 3E's is a verifier of the country from another organisation than the land's verifier (under the same Holder or not), and never that verifier or the landowner; each challenge names the defendant its option names (the verifier; the Holder for 3A; the landowner for 3D)", "FM p15; EcoChallenge._independentVerifier");
const panelC = check("panel-independence", "Challenges", "Three judges: the country's eligible Trust Admins first, GTAs for the seats too few remain for; never the landowner, the covenant's Holder or either party's organisation's Holder; only seated judges vote", "FM p15; EcoChallenge._draw, _eligible; PanelLib");
const dl = check("challenge-deadline", "Challenges", `Every challenge ends within one deadline from its raise (response + panel + redraw: ${days(deadline)}): decided before it, lapsed only at or after it`, "FM p15; EcoChallenge.deadlineOf");
const chEnd = check("challenges-end", "Challenges", "No challenge stays undecided long past its deadline", "FM p15");
const cons = check("challenge-consequences", "Challenges", "Each verdict has exactly its option's consequences, in the same transaction. Dismissed: the challenger is flagged (never the landowner on 3E) and nothing changes. Upheld: W1A reopens the request and bars the verifier; W1B fails it; 3A blocks the covenant (Deed hold) and flags the last attester, forfeiting an unsettled window's fee; 3B vacates the seat (the challenger's first claim) and holds the TR3 for rescoring; 3C sets a re-verification due; 3D blocks for a breach; 3E lifts a breach block. W1A, W1B, 3B and 3E flag the verifier", "FM p15-17; EcoChallenge._decide; Core.applyVerdict; EcoRegistry.onChallengeResolved");
const sched = check("verification-schedule", "Term", "Each re-verification is by the seated verifier and covers every interval begun since the term started (up to the last); one that covers none is a cure of a breach block, the re-verification 3C called for, or a newly seated verifier's first; none while a challenge on the covenant is undecided, nor before the last review window has closed", "Core.verify; EcoChallenge.openWindow; EcoParties.onVerification");
const blk = check("block-holds", "Term", "A seated verifier blocks at most twice per review window (partition and 3D blocks aside); a block in the term holds the instalments (breach or Deed), its lift releases them; now, every covenant's holds match its block and its seat", "FM P4, P7; Core.blockCovenant, _block, _unblock; EcoParties._vacate");
const termEnd = check("term-closed", "Term", "A covenant whose term and grace have long passed has had its End Date accounted: nothing left in its account, every instalment released", "FM p9; Core.closeTerm; EcoBank.closeAccount");
const tclk = check("term-clocks", "Term", "3A: a covenant closes early only after its restore window; 3C: the re-verification falls due after the damage window; a winner's identity check is called off for time only after the KYC window; a buyer of the land's accession lapses only after the accession window", "FM p4-5, p8, P6; Core.applyVerdict, closeEarly; EcoMarket.cancelStaleSale; EcoParties.lapseAccession");
const fr = check("emergency-freeze", "Governance", `An emergency freeze lasts ${days(cfg.emergency)}: ratified by the Council by then, lifted by the multisig, or ended after it; never again on the same Trust Admin within ${days(cfg.cooldown)} of its end`, "FM p4, p19; Governance.emergencyFreeze");
const seat = check("seat-refilled", "Term", "A vacated seat is filled again", "FM P4");
const rst = check("reseat-rule", "Term", "A seat passes only when it is vacant, or its verifier is out of standing or late beyond the grace: to the 3B challenger inside its first claim, or to a nominee of the covenant's Holder (after the first claim, within the reseat window) or of the Council; the new verifier is of the country, takes work, is not the one replaced, the one that lost the seat or the landowner, and is either of the replaced verifier's organisation or was never in it", "FM P4; EcoParties.nominateVerifier, acceptSeat, claimSeat, _requireSuccessor; D7");
const firstClaim = check("first-claim", "Requests", "A request reopened by W1A is claimed only by the challenger during its first claim, and never by the verifier it was removed from; every claim is by a verifier of the request's country that takes work, whose Holder the event names and is not frozen", "FM p4, p15; EcoRegistry.claim, onChallengeResolved");
// the paper flow
const paper = check("deeds-clocks", "Paper", "Before the sale each document is recorded, and attested, inside its clock (anchoring, attestation: from when the step became current, with the extensions granted, silence counting as granted after the decision window); a request lapses only after its clock; the landowner anchors only from its day", "FM p12-13; D8; EcoDeeds._deadline, recordDocument, attest, lapse");
const gtaA = check("gta-attest-from", "Paper", `Every attester is independent: a verifier of the country from another organisation than the land's verifier, a Trust Admin of the country other than the land's, or a GTA -- a document from ${days(cfg.gtaFrom)} after it was recorded, a review window from seven tenths of it`, "FM p12, p17; EcoDeeds._requireAttester; EcoChallenge._eligibleAttester");
// the configuration, enforced
const fees = check("upfront-fees", "Configuration", "Each request's upfront is the fee model's for its land and its country's fees at the time: V x (1 + sqrt ha), V, D x (1.5 + sqrt ha), and the allowance fixed + per ha x ha", "FM p9; D12; EcoCountries.quote");
const floorC = check("price-floor", "Configuration", "No auction starts below the covenant's yearly price floor (J x years x 100); one at the twice-a-year cadence clears the twice-a-year floor too", "FM p8; D14; EcoMarket.listForAuction; EcoFees.priceFloor");
const termC = check("term-length", "Configuration", `Each term runs exactly its Stated Period: years x the protocol year (${days(cfg.year)})`, "Core.activate");
const cad = check("instalment-schedule", "Configuration", "Each sale is paid twice a year only when its price reaches both USD 500 x (2T + 1) and the twice-a-year floor, else yearly: interval = year / releases a year, years x that many instalments after the first, the first taking the division's remainder", "FM p9; D14; EcoBank._openAccount");
const rev = check("review-window", "Configuration", `Every review window runs exactly the configured review (${days(cfg.review)})`, "EcoChallenge.openWindow");
const halt = check("halt-threshold", "Configuration", `The unattested run counts each window that settles unattested and resets at an attestation; a window opens halted exactly when it reaches the threshold (${cfg.haltAfter})`, "FM p17; EcoChallenge.openWindow, _settle, attestVerification");
const auc = check("auction-length", "Configuration", `No auction is shorter than the configured minimum (${days(cfg.minAuction)}), and each closes inside its listing window`, "EcoMarket.listForAuction");
const acc = check("acceptance", "Configuration", `A verification is submitted by the claiming verifier within the acceptance window of its claim (${days(cfg.acceptance)})`, "EcoRegistry.submitVerification");
const wdw = check("watchdog-wait", "Configuration", `A request enters its flow only after its watchdog window has passed (${days(cfg.watchdog)})`, "EcoRegistry.enterFlow");
const lst = check("listing-window", "Configuration", "Each request takes its country's listing and post-sale windows at the request; it closes unsold only after the listing window", "FM p8; EcoRegistry.requestVerification, closeUnsold");
const pst = check("post-sale-window", "Configuration", "A path B sale completes inside its post-sale window, and lapses only after it", "FM p5; EcoRegistry.lapseSale; EcoDeeds.attest");
const flw = check("flow-order", "Configuration", "Every request walks its country's flow, step by step, in order", "EcoCountries flows; FlowCode");

// ---- the chronological replay: the protocol's state at each event, and every check that needs it ----
type Fees = { baseFee: bigint; deskRate: bigint; allowanceFixed: bigint; allowancePerHa: bigint };
type Settings = { flowId: number; min: number; max: number; listing: number; postSale: number };
const countries = new Map<number, { settings: Settings; fees: Fees }>();
const flows = new Map<number, number[]>();
let defaultV = defaultV0;
const vOf = (f: Fees) => (f.baseFee !== 0n ? f.baseFee : defaultV);
const dOf = (f: Fees) => (f.deskRate !== 0n ? f.deskRate : deskOf(vOf(f)));
let split = { wallet: Z, v: 0n, tax: 0n, f: 0n };
const splitChanges: number[] = [];
let consPerHa = 10n * USD, consMin = 50n * USD;

type Verifier = { org: bigint; holder: string; country: number; dismissed: boolean; retired: boolean; suspended: boolean };
const verifiers = new Map<string, Verifier>();
type Holder = { country: number; active: boolean; frozen: boolean; wasFrozen: boolean; successor?: string };
const holders = new Map<string, Holder>();
const gtas = new Set<string>();
const persons = new Map<string, string>(); // wallet -> person, read now (a wallet that holds a seat is one person's for good)
const orgsOfPerson = new Map<string, Set<string>>(); // person -> every organisation it has been in, so far
{
  const ws = E("admin.VerifierAdded").map((e) => L(e.a.verifier));
  const ps = await Promise.all(ws.map((w) => rd("admin", "personOf", [w])));
  ws.forEach((w, i) => persons.set(w, L(ps[i])));
}
const resolve = (h: string) => { let x = L(h); for (let i = 0; i < 16; i++) { const s = holders.get(x)?.successor; if (!s) break; x = s; } return x; };
const holderOf = (v: string) => { const h = verifiers.get(L(v))?.holder; return h ? resolve(h) : Z; };
const inStanding = (v: string) => { const x = verifiers.get(L(v)); return !!x && !x.dismissed && !x.suspended; };
const takesWork = (v: string) => inStanding(v) && !verifiers.get(L(v))!.retired;
const independentOf = (actor: string, v: string) => {
  const org = verifiers.get(L(v))?.org ?? 0n;
  const p = persons.get(L(actor)) ?? L(actor);
  return (verifiers.get(L(actor))?.org ?? 0n) !== org && !(orgsOfPerson.get(p)?.has(String(org)) ?? false);
};
const isActiveHolder = (h: string) => !!holders.get(L(h))?.active;
const isFrozen = (h: string) => !!holders.get(L(h))?.frozen;

type Ext = { granted: number; askedAt: number };
type Req = {
  rid: number; guardian: string; country: number; units: bigint; term: number; flowId: number; steps: number[];
  vf: bigint; af: bigint; jf: bigint; al: bigint; left: { share: bigint; att: bigint; jud: bigint; al: bigint };
  shareTaken: boolean; judgmentSettled: boolean; status: number; verifier: string; claimedAt: number; verifiedAt: number;
  cursor: number; stepAt: number; ext: Map<number, Ext>; before?: { stepAt: number; cursor: number; ext: Map<number, Ext> };
  saleAt: number; listing: number; postSale: number; firstClaimant: string; firstClaimUntil: number; barred: string;
  recordedAt: Map<number, number>; tokenId?: bigint; ended: boolean;
};
const reqs = new Map<number, Req>();
type Seat = { vacant: boolean; removed: string; firstClaimant: string; firstClaimUntil: number; vacantSince: number };
type Cov = {
  tid: bigint; rid: number; guardian: string; verifier: string; country: number; units: bigint; term: number; score: number;
  holder0: string; status: number; blockReason: number; termStart: number; termEnd: number; interval: number; total: number;
  through: number; verifications: number; blockWindow: number; blocksInWindow: number; reverifyPending: boolean;
  newSeatPending: boolean; seat: Seat; nominee: string; nominatedBy: string; restoreBy: number; owner: string;
  saleApprovedAt: number; settledAt: number; accessionPending: boolean; openChallenge: bigint;
};
const covs = new Map<bigint, Cov>();
type Acct = { price: bigint; pool: bigint; balance: bigint; per: bigint; total: number; released: number; holds: number;
  consPer: bigint; consYears: number; shareToPatron: boolean; first: bigint; consPaid: bigint; verifierPaid: bigint; splitAt: number; closedHeld: bigint; split0: typeof split };
const accts = new Map<bigint, Acct>();
type Stream = { alloc: bigint; edition: number; score: number; rescore: boolean; ended: boolean; stream: bigint; credits: bigint;
  mE6: bigint; left: bigint };
const streams = new Map<bigint, Stream>();
type Win = { openedAt: number; closesAt: number; attestor: string; index: number; through: number; forfeited: boolean; settled: boolean };
type Pool = { pool: bigint; fee: bigint; funded: number; opened: number; win?: Win; runs: number; lastAttester: string; fundedAmount: bigint; paid: bigint; attPay?: bigint; attPayBefore?: bigint };
const pools = new Map<bigint, Pool>();
/** A covenant's pool and windows; a sale too small to fund a pool still has windows. */
const poolOf = (tid: bigint) => pools.get(tid) ?? pools.set(tid, { pool: 0n, fee: 0n, funded: 1, opened: 0, runs: 0, lastAttester: Z, fundedAmount: 0n, paid: 0n }).get(tid)!;
type Ch = { cid: bigint; option: number; subject: bigint; challenger: string; defendant: string; openedAt: number;
  verifier: string; guardian: string; holder: string; chHolder: string; country: number; panel: string[]; voters: Set<string>;
  firstPool?: bigint; before?: { status: number; blockReason: number; win?: Win; lastAttester: string } ; ended: boolean };
const chs = new Map<bigint, Ch>();
const relics = new Map<bigint, { edition: number; cap: bigint }>();
type Place = { rid: number; edition: number; ly: bigint; full: bigint; released: boolean };
const places = new Map<number, Place>();
const owners = new Map<bigint, string>();
// the edition model, replayed: the open edition, its land-years and when it opened (Tree's initialisation)
const clock = 8 * cfg.year;
let ed = 1, used = 0n, openedAt = E("tree.Initialized")[0]?.t ?? events.find((e) => e.c === "tree")?.t ?? 0;
let capBurn = 0n, closesCount = 0, truncated = 0, noFit = 0;
let reserveEv = 0n, committedEv = 0n, releasedEv = 0n, burnedEv = 0n, claimedEv = 0n;
const claims = new Map<bigint, { p: bigint; g: bigint; r: bigint }>();
// the payments each transaction's events report, by recipient
const evTx = new Map<string, Map<string, bigint>>();
const pay = (tx: string, to: string, v: bigint) => {
  if (v === 0n) return;
  const m = evTx.get(tx) ?? evTx.set(tx, new Map()).get(tx)!;
  m.set(L(to), (m.get(L(to)) ?? 0n) + v);
};
const emergencies: { holder: string; by: string; t: number; until: number; end?: { t: number; ratified: boolean; by: string } }[] = [];
const lastEmergencyEnd = new Map<string, number>();
const listings: { tid: bigint; endsAt: number }[] = [];
const verdicts: { tid: bigint; option: number; t: number }[] = [];
const sweepOf = new Set<bigint>();

const cov = (tid: unknown) => covs.get(B(tid));
const consOwed = (a: Acct, c: Cov, t: number) => {
  let y = Math.floor((t - c.termStart) / cfg.year) + 1;
  if (y > c.term) y = c.term;
  return y <= a.consYears ? 0n : BigInt(y - a.consYears) * a.consPer;
};
const deadlineOf = (r: Req, st: { stepAt: number; cursor: number; ext: Map<number, Ext> }, t: number) => {
  const step = r.steps[st.cursor] ?? 0;
  const len = step === Step.POWER ? cfg.power : step === Step.ATTEST ? cfg.attestation : cfg.anchoring;
  const e = st.ext.get(st.cursor) ?? { granted: 0, askedAt: 0 };
  let g = e.granted;
  if (g === 0 && e.askedAt !== 0 && t > e.askedAt + cfg.decision) g = 1;
  return st.stepAt + len * (1 + g);
};
const snapshot = (r: Req) => ({ stepAt: r.stepAt, cursor: r.cursor, ext: new Map([...r.ext].map(([k, v]) => [k, { ...v }])) });

// After each transaction, every covenant it touched: an active covenant in its term carries no breach or Deed hold,
// a block's own hold is set while it stands (a partition's is the breach hold), and the vacancy and accession holds
// are set exactly while the seat waits for its new verifier's first re-verification, or the buyer's accession.
const holdsOk = (c: Cov, holds: number) => {
  const st = c.status, reason = c.blockReason;
  const bad: string[] = [];
  if (st === CovenantStatus.ACTIVE && holds & (Holds.BREACH | Holds.DEED)) bad.push("active with a breach or Deed hold that no lift can release");
  if (st === CovenantStatus.BLOCKED && (reason === BlockReason.BREACH || reason === BlockReason.PARTITION) && !(holds & Holds.BREACH)) bad.push(`blocked (reason ${reason}) without the breach hold`);
  if (st === CovenantStatus.BLOCKED && reason === BlockReason.DEED && !(holds & Holds.DEED)) bad.push("blocked under 3A without the Deed hold");
  if (!!(holds & Holds.VACANCY) !== (c.seat.vacant || c.newSeatPending)) bad.push(`vacancy hold ${!!(holds & Holds.VACANCY)}, seat vacant ${c.seat.vacant}, new verifier's first re-verification due ${c.newSeatPending}`);
  if (!!(holds & Holds.ACCESSION) !== c.accessionPending) bad.push(`accession hold ${!!(holds & Holds.ACCESSION)}, accession pending ${c.accessionPending}`);
  return bad;
};
let curTx = "", curT = 0;
const touched = new Set<bigint>();
const flushTx = () => {
  for (const tid of touched) {
    const c = covs.get(tid), ac = accts.get(tid);
    if (!c || !ac || c.termStart === 0 || (c.status !== CovenantStatus.ACTIVE && c.status !== CovenantStatus.BLOCKED)) continue;
    const bad = holdsOk(c, ac.holds);
    blk.test(bad.length === 0, R(tid), () => `after ${curTx.slice(0, 12)} (${date(curT)}): status ${c.status}, block reason ${c.blockReason}, holds ${ac.holds}: ${bad.join("; ")} (the transaction emitted ${(byTx.get(curTx) ?? []).map((x) => x.name).join(", ")})`);
  }
  touched.clear();
};
for (const e of events) {
  const a = e.a, t = e.t;
  if (e.tx !== curTx) { flushTx(); curTx = e.tx; curT = t; }
  if (a.tokenId !== undefined && (e.c === "core" || e.c === "bank" || e.c === "parties" || e.c === "challenge")) touched.add(B(a.tokenId));
  switch (`${e.c}.${e.name}`) {
    // ---- the rulebook ----
    case "countries.FlowDefined": flows.set(N(a.flowId), (a.steps as unknown[]).map(Number)); break;
    case "countries.DefaultFeeSet": defaultV = B(a.baseFee); break;
    case "countries.CountryEnabled": case "countries.SettingsApplied": case "countries.CountryFeesSet": {
      const x = countries.get(N(a.country));
      const s = a.settings ? { flowId: N(a.settings.flowId), min: N(a.settings.minTermYears), max: N(a.settings.maxTermYears), listing: N(a.settings.listingWindow), postSale: N(a.settings.postSaleWindow) } : x!.settings;
      const f = a.fees ? { baseFee: B(a.fees.baseFee), deskRate: B(a.fees.deskRate), allowanceFixed: B(a.fees.allowanceFixed), allowancePerHa: B(a.fees.allowancePerHa) } : x!.fees;
      countries.set(N(a.country), { settings: s, fees: f });
      break;
    }
    case "bank.FeeSplitSet": split = { wallet: L(a.feeWallet), v: B(a.verifierPermille), tax: B(a.taxPermille), f: B(a.foundationPermille) }; splitChanges.push(e.ord); break;
    case "bank.ConsiderationSet": consPerHa = B(a.perHectare); consMin = B(a.minimum); break;
    // ---- the parties ----
    case "admin.HolderAdded": holders.set(L(a.holder), { country: N(a.country), active: true, frozen: false, wasFrozen: false }); break;
    case "admin.HolderRemoved": { const h = holders.get(L(a.holder)); if (h) { h.wasFrozen = h.frozen; h.active = false; h.frozen = false; } break; }
    case "admin.HolderReplaced": {
      const o = holders.get(L(a.old))!;
      o.successor = L(a.successor);
      if (!holders.has(L(a.successor))) holders.set(L(a.successor), { country: o.country, active: true, frozen: o.wasFrozen, wasFrozen: false }); // a rotated wallet
      break;
    }
    case "admin.HolderFrozen": { const h = holders.get(L(a.holder)); if (h) h.frozen = !!a.frozen; break; }
    case "admin.VerifierAdded": {
      verifiers.set(L(a.verifier), { org: B(a.orgId), holder: L(a.holder), country: N(a.country), dismissed: false, retired: false, suspended: false });
      const p = persons.get(L(a.verifier)) ?? L(a.verifier);
      (orgsOfPerson.get(p) ?? orgsOfPerson.set(p, new Set()).get(p)!).add(String(B(a.orgId)));
      break;
    }
    case "admin.VerifierDismissed": { const v = verifiers.get(L(a.verifier)); if (v) { v.dismissed = true; v.suspended = false; } break; }
    case "admin.VerifierSuspended": { const v = verifiers.get(L(a.verifier)); if (v) v.suspended = true; break; }
    case "admin.VerifierUnsuspended": { const v = verifiers.get(L(a.verifier)); if (v) v.suspended = false; break; }
    case "admin.VerifierRetired": { const v = verifiers.get(L(a.verifier)); if (v) v.retired = true; break; }
    case "governance.GTASeated": gtas.add(L(a.gta)); break;
    case "governance.GTAUnseated": gtas.delete(L(a.gta)); break;
    case "governance.EmergencyFreeze": {
      const h = L(a.holder), endAt = lastEmergencyEnd.get(h);
      fr.test(N(a.until) - t === cfg.emergency && (endAt === undefined || t >= endAt + cfg.cooldown), short(h),
        () => `frozen ${date(t)} until ${date(N(a.until))}${endAt !== undefined ? `, ${days(t - endAt)} after the last freeze ended` : ""}`);
      emergencies.push({ holder: h, by: L(a.by), t, until: N(a.until) });
      break;
    }
    case "governance.EmergencyFreezeEnded": {
      const x = [...emergencies].reverse().find((f) => f.holder === L(a.holder) && !f.end);
      if (x) {
        x.end = { t, ratified: !!a.ratified, by: L(a.by) };
        // ratified by day 30; ended early only by the multisig; otherwise only once the 30 days are up
        fr.test(a.ratified ? t <= x.until : L(a.by) === x.by || t >= x.until, short(x.holder), () => `${a.ratified ? "ratified" : "ended"} ${date(t)}, the freeze ran to ${date(x.until)}`);
        if (!a.ratified) lastEmergencyEnd.set(x.holder, t);
      }
      break;
    }

    // ---- the request ----
    case "registry.VerificationRequested": {
      const rid = N(a.requestId), country = N(a.country), st = countries.get(country)!;
      const units = B(a.landUnits), years = N(a.termYears);
      const r: Req = {
        rid, guardian: L(a.guardian), country, units, term: years, flowId: st.settings.flowId, steps: flows.get(st.settings.flowId) ?? [],
        vf: B(a.verificationFee), af: B(a.attestationFee), jf: B(a.judgmentFee), al: B(a.allowance),
        left: { share: B(a.verificationFee), att: B(a.attestationFee), jud: B(a.judgmentFee), al: B(a.allowance) },
        shareTaken: false, judgmentSettled: false, status: RequestStatus.OPEN, verifier: Z, claimedAt: 0, verifiedAt: 0,
        cursor: 0, stepAt: 0, ext: new Map(), saleAt: 0, listing: st.settings.listing, postSale: st.settings.postSale,
        firstClaimant: Z, firstClaimUntil: 0, barred: Z, recordedAt: new Map(), ended: false,
      };
      reqs.set(rid, r);
      const f = st.fees, v = vOf(f), d = dOf(f);
      const want = [(v * scaleFor(units)) / WAD, v, reviewFeeOf(units, d), f.allowanceFixed + (f.allowancePerHa * units) / 100n];
      fees.test(r.vf === want[0] && r.af === want[1] && r.jf === want[2] && r.al === want[3], `#${rid}`,
        () => `paid ${[r.vf, r.af, r.jf, r.al].map(usd).join(" / ")}; the model gives ${want.map(usd).join(" / ")}`);
      // the land and term against the edition open at the request (counting the clock), and the country's range
      let m = ed, o = openedAt;
      while (m <= LAST_EDITION && t >= o + clock) { m++; o += clock; }
      const F = fib(Math.min(m, LAST_EDITION));
      land.test(units >= 1n && units <= (10_000n * F) / 3n, `#${rid}`, () => `${N(units) / 100} ha with F = ${F} (100 m2 to 33.33F ha)`);
      const maxY = Math.max(3, Math.min(100, N((10_000n * F) / units)));
      term.test(years >= st.settings.min && years <= Math.min(st.settings.max, maxY), `#${rid}`, () => `${years} years for ${N(units) / 100} ha in ${country}: range ${st.settings.min}-${Math.min(st.settings.max, maxY)}`);
      break;
    }
    case "registry.RequestClaimed": {
      const r = reqs.get(N(a.requestId))!, v = L(a.verifier);
      firstClaim.test((t > r.firstClaimUntil || v === r.firstClaimant) && v !== r.barred && verifiers.get(v)?.country === r.country && L(a.holder) === holderOf(v)
        && takesWork(v) && !isFrozen(holderOf(v)),
        `#${r.rid}`, () => `claimed by ${short(v)} ${date(t)}${r.firstClaimUntil ? `; first claim ${short(r.firstClaimant)} until ${date(r.firstClaimUntil)}` : ""}${v === r.barred ? " (barred)" : ""}`);
      r.verifier = v; r.claimedAt = t; r.status = RequestStatus.CLAIMED;
      break;
    }
    case "registry.VerifierReassigned": reqs.get(N(a.requestId))!.verifier = L(a.newVerifier); break;
    case "registry.VerificationSubmitted": {
      const r = reqs.get(N(a.requestId))!;
      acc.test(L(a.verifier) === r.verifier && t <= r.claimedAt + cfg.acceptance, `#${r.rid}`, () => `submitted ${days(t - r.claimedAt)} after the claim`);
      r.verifiedAt = t; r.status = RequestStatus.VERIFIED; r.cursor = 0; r.stepAt = t + cfg.watchdog; // the flow opens when the watchdog closes (D8)
      break;
    }
    case "registry.RequestReopened": {
      const r = reqs.get(N(a.requestId))!;
      r.status = RequestStatus.OPEN; r.barred = L(a.barredVerifier); r.verifier = Z; r.verifiedAt = 0;
      break;
    }
    case "registry.VerifierPaid": {
      const r = reqs.get(N(a.requestId))!, amt = B(a.amount);
      pay(e.tx, a.verifier, amt);
      upParts.test(L(a.verifier) === r.verifier, `#${r.rid}`, () => `paid ${short(a.verifier)}, the request's verifier is ${short(r.verifier)}`);
      if (r.status === RequestStatus.VERIFIED && !r.judgmentSettled) {
        // the watchdog passed with no judges to pay (entering the flow, abandoning or lapsing): the judgment fee
        upParts.test(amt === r.left.jud, `#${r.rid}`, () => `the judgment fee to the verifier was ${usd(amt)}; ${usd(r.left.jud)} was held`);
        r.judgmentSettled = true; r.left.jud = 0n;
      } else {
        const why = inTx(e, "deeds.DocumentAttested", (x) => N(x.a.requestId) === r.rid).length > 0
          || inTx(e, "registry.RequestEnded", (x) => N(x.a.requestId) === r.rid && [2, 8].includes(N(x.a.reason))).length > 0;
        upParts.test(!r.shareTaken && amt === r.vf && why, `#${r.rid}`, () => `the verification fee paid as ${usd(amt)} of ${usd(r.vf)}${r.shareTaken ? " a second time" : ""}${why ? "" : ", with no attestation, refusal or abandonment"}`);
        r.shareTaken = true; r.left.share = 0n;
      }
      break;
    }
    case "registry.AttestationPaid": {
      const r = reqs.get(N(a.requestId))!, amt = B(a.amount);
      pay(e.tx, a.attester, amt);
      const lastAttest = r.steps.lastIndexOf(Step.ATTEST);
      const by = inTx(e, "deeds.DocumentAttested", (x) => N(x.a.requestId) === r.rid && L(x.a.attester) === L(a.attester) && N(x.a.index) + 1 === lastAttest);
      upParts.test(amt === r.af && r.left.att === r.af && by.length === 1, `#${r.rid}`, () => `the attestation fee paid as ${usd(amt)} of ${usd(r.af)}${by.length ? "" : ", not for the flow's last document"}`);
      r.left.att = 0n;
      break;
    }
    case "registry.JudgmentPaid": {
      const r = reqs.get(N(a.requestId))!, amt = B(a.amount), voters = (a.voters as string[]).map(L);
      const each = amt / BigInt(voters.length);
      voters.forEach((v, k) => pay(e.tx, v, k === 0 ? amt - each * BigInt(voters.length - 1) : each));
      upParts.test(amt === r.left.jud, `#${r.rid}`, () => `the judges were paid ${usd(amt)}; ${usd(r.left.jud)} was held`);
      r.left.jud = 0n;
      break;
    }
    case "registry.AllowanceDrawn": {
      const r = reqs.get(N(a.requestId))!, amt = B(a.amount);
      pay(e.tx, a.holder, amt);
      // in the flow -- open once the watchdog closed, entered or not (D8)
      const inFlow = r.status === RequestStatus.IN_FLOW || (r.status === RequestStatus.VERIFIED && t > r.verifiedAt + cfg.watchdog);
      upParts.test(amt <= r.left.al && L(a.holder) === holderOf(r.verifier) && inFlow, `#${r.rid}`,
        () => `${short(a.holder)} drew ${usd(amt)} of ${usd(r.left.al)} left; the request's Holder is ${short(holderOf(r.verifier))}`);
      r.left.al -= amt;
      break;
    }
    case "registry.RequestEnded": {
      const r = reqs.get(N(a.requestId))!, refund = B(a.refund);
      pay(e.tx, r.guardian, refund);
      const left = r.left.share + r.left.att + r.left.jud + r.left.al;
      upCons.test(refund === left, `#${r.rid}`, () => `refunded ${usd(refund)}; ${usd(left)} was left`);
      r.left = { share: 0n, att: 0n, jud: 0n, al: 0n };
      r.status = RequestStatus.ENDED; r.ended = true;
      break;
    }
    case "registry.FlowEntered": {
      const r = reqs.get(N(a.requestId))!;
      wdw.test(t > r.verifiedAt + cfg.watchdog, `#${r.rid}`, () => `the flow began ${days(t - r.verifiedAt)} after the verification`);
      r.status = RequestStatus.IN_FLOW; r.steps = flows.get(N(a.flowId)) ?? r.steps;
      break;
    }
    case "registry.FlowAdvanced": {
      const r = reqs.get(N(a.requestId))!;
      // one past the last step is the flow's completion, reported as step 0 (none)
      const expected = N(a.cursor) === r.steps.length ? 0 : r.steps[N(a.cursor)];
      flw.test(expected === N(a.step), `#${r.rid}`, () => `step ${a.step} at cursor ${a.cursor}; the flow is ${r.steps.join(", ")}`);
      r.before = snapshot(r);
      r.cursor = N(a.cursor); r.stepAt = t;
      break;
    }
    case "registry.SaleRecorded": reqs.get(N(a.requestId))!.saleAt = t; break;
    case "registry.SaleLapsed": {
      const r = reqs.get(N(a.requestId))!;
      pst.test(r.saleAt !== 0 && t > r.saleAt + r.postSale, `#${r.rid}`, () => `lapsed ${days(t - r.saleAt)} after the sale; the window is ${days(r.postSale)}`);
      if (a.relistable) r.saleAt = 0;
      break;
    }
    case "registry.FlowCompleted": {
      const r = reqs.get(N(a.requestId))!;
      if (r.saleAt && t > r.saleAt) pst.test(t <= r.saleAt + r.postSale, `#${r.rid}`, () => `completed ${days(t - r.saleAt)} after the sale; the window is ${days(r.postSale)}`);
      break;
    }
    case "registry.CovenantMinted": reqs.get(N(a.requestId))!.tokenId = B(a.tokenId); break;

    // ---- the paper flow ----
    case "deeds.ExtensionAsked": { const r = reqs.get(N(a.requestId))!; const x = r.ext.get(N(a.index)) ?? { granted: 0, askedAt: 0 }; x.askedAt = t; r.ext.set(N(a.index), x); break; }
    case "deeds.ExtensionDecided": { const r = reqs.get(N(a.requestId))!; const x = r.ext.get(N(a.index)) ?? { granted: 0, askedAt: 0 }; if (a.granted) x.granted += 1; x.askedAt = 0; r.ext.set(N(a.index), x); break; }
    case "deeds.DocumentRecorded": {
      const r = reqs.get(N(a.requestId))!, index = N(a.index);
      r.recordedAt.set(index, t);
      if (r.saleAt === 0) {
        // the clock of the step this document completed: as it stood before the flow advanced (or, for a correction, now)
        const st = a.replaced ? snapshot(r) : r.before ?? snapshot(r);
        const dl0 = deadlineOf(r, st, t);
        const guardianOk = L(a.by) !== r.guardian || (!a.replaced && t >= st.stepAt + cfg.guardianFrom);
        paper.test(t <= dl0 && guardianOk, `#${r.rid}`, () => `${a.replaced ? "corrected" : "recorded"} document ${index} by ${L(a.by) === r.guardian ? "the landowner" : short(a.by)} ${date(t)}; its clock ran from ${date(st.stepAt)} to ${date(dl0)}`);
      } else {
        pst.test(t <= r.saleAt + r.postSale, `#${r.rid}`, () => `recorded ${days(t - r.saleAt)} after the sale`);
      }
      if (a.replaced) { r.stepAt = t; r.ext.delete(r.cursor); }
      break;
    }
    case "deeds.DocumentAttested": {
      const r = reqs.get(N(a.requestId))!, index = N(a.index), who = L(a.attester);
      if (r.saleAt === 0) {
        const st = r.before ?? snapshot(r), dl0 = deadlineOf(r, st, t);
        paper.test(t <= dl0, `#${r.rid}`, () => `document ${index} attested ${date(t)}; its clock ran from ${date(st.stepAt)} to ${date(dl0)}`);
      } else pst.test(t <= r.saleAt + r.postSale, `#${r.rid}`, () => `attested ${days(t - r.saleAt)} after the sale`);
      const recorded = r.recordedAt.get(index) ?? 0;
      let why = "";
      if (who === r.verifier || who === r.guardian) why = "the land's own verifier or landowner";
      else if (inStanding(who) || verifiers.has(who)) { if (!(takesWork(who) && verifiers.get(who)!.country === r.country && independentOf(who, r.verifier))) why = "a verifier not independent of the land's"; }
      else if (isActiveHolder(who)) { if (isFrozen(who) || holders.get(who)!.country !== r.country || who === holderOf(r.verifier)) why = "the land's own Trust Admin, frozen, or of another country"; }
      else if (!gtas.has(who)) why = "neither a verifier, a Trust Admin nor a GTA";
      else if (t < recorded + cfg.gtaFrom) why = `a GTA ${days(t - recorded)} after the document`;
      gtaA.test(why === "", `#${r.rid}`, () => `document ${index} attested by ${short(who)}: ${why}`);
      break;
    }
    case "deeds.RefusalRecorded": {
      const r = reqs.get(N(a.requestId))!, dl0 = deadlineOf(r, snapshot(r), t);
      paper.test(t <= dl0, `#${r.rid}`, () => `refusal recorded ${date(t)}, after its clock (${date(dl0)})`);
      break;
    }
    case "deeds.RequestLapsed": {
      const r = reqs.get(N(a.requestId))!, dl0 = deadlineOf(r, snapshot(r), t);
      const attest = r.steps[r.cursor] === Step.ATTEST;
      paper.test(t > dl0 && N(a.reason) === (attest ? 10 : 9), `#${r.rid}`, () => `lapsed ${date(t)} (reason ${a.reason}); its clock ran to ${date(dl0)}`);
      break;
    }

    // ---- the covenant ----
    case "token.Transfer": owners.set(B(a.tokenId), L(a.to)); break;
    case "core.CovenantCreated": {
      const tid = B(a.tokenId), rid = N(a.requestId), v = L(a.verifier);
      covs.set(tid, {
        tid, rid, guardian: L(a.guardian), verifier: v, country: N(a.country), units: B(a.landUnits), term: N(a.termYears), score: N(a.ecoScore),
        holder0: holderOf(v), status: CovenantStatus.MINTED, blockReason: 0, termStart: 0, termEnd: 0, interval: 0, total: 0, through: 0,
        verifications: 0, blockWindow: 0, blocksInWindow: 0, reverifyPending: false, newSeatPending: false,
        seat: { vacant: false, removed: Z, firstClaimant: Z, firstClaimUntil: 0, vacantSince: 0 }, nominee: Z, nominatedBy: Z, restoreBy: 0,
        owner: L(a.guardian), saleApprovedAt: 0, settledAt: 0, accessionPending: false, openChallenge: 0n,
      });
      break;
    }
    case "core.CovenantActivated": {
      const c = cov(a.tokenId)!;
      c.status = CovenantStatus.ACTIVE; c.termStart = N(a.termStart); c.termEnd = N(a.termEnd);
      termC.test(c.termEnd - c.termStart === c.term * cfg.year, R(c.tid), () => `${days(c.termEnd - c.termStart)} for ${c.term} years`);
      break;
    }
    case "core.PayeeChanged": cov(a.tokenId)!.guardian = L(a.newGuardian); break;
    case "core.CovenantBlocked": {
      const c = cov(a.tokenId)!, reason = N(a.reason);
      if (reason === BlockReason.BREACH && L(a.by) === c.verifier) {
        if (c.blockWindow !== c.verifications) { c.blockWindow = c.verifications; c.blocksInWindow = 0; }
        c.blocksInWindow++;
        blk.test(c.blocksInWindow <= 2, R(c.tid), () => `block ${c.blocksInWindow} in one review window`);
      }
      // D16: every cause at once; the reason shown is the one to resolve first (the Deed, a partition, a breach)
      c.causes = (c.causes ?? 0) | causeBit(reason);
      c.status = CovenantStatus.BLOCKED; c.blockReason = topCause(c.causes);
      break;
    }
    case "core.DeedRestored": liftCause(cov(a.tokenId)!, 2); break;
    case "parties.PartitionEnded": liftCause(cov(a.tokenId)!, 4); break;
    case "core.CovenantUnblocked": {
      const c = cov(a.tokenId)!;
      c.causes = 0;
      c.status = c.termStart !== 0 ? CovenantStatus.ACTIVE : CovenantStatus.MINTED; c.blockReason = 0;
      const s = streams.get(c.tid); if (s && c.termStart !== 0 && !s.ended) s.rescore = false; // the lift passes the stream
      break;
    }
    case "core.CovenantCancelled": cov(a.tokenId)!.status = CovenantStatus.CANCELLED; break;
    case "core.CovenantClosed": cov(a.tokenId)!.status = CovenantStatus.CLOSED; break;
    case "core.CovenantEnded": cov(a.tokenId)!.status = CovenantStatus.ENDED; break;
    case "core.CovenantClosedEarly": {
      const c = cov(a.tokenId)!;
      tclk.test(c.restoreBy !== 0 && t > c.restoreBy, R(c.tid), () => `closed early ${date(t)}; the Deed could be restored until ${date(c.restoreBy)}`);
      c.status = CovenantStatus.CANCELLED;
      break;
    }
    case "core.VerdictApplied": {
      const c = cov(a.tokenId)!, o = N(a.option);
      verdicts.push({ tid: c.tid, option: o, t });
      if (o === Option.T3A) c.restoreBy = t + cfg.restore;
      break;
    }
    case "core.ReverificationDue": {
      const c = cov(a.tokenId)!;
      tclk.test(N(a.by) === t + cfg.damage, R(c.tid), () => `a re-verification due ${date(N(a.by))}, ${days(N(a.by) - t)} after the verdict`);
      c.reverifyPending = true;
      break;
    }
    case "core.CovenantVerified": {
      const c = cov(a.tokenId)!, k = N(a.verifiedThrough), prev = c.through, od = N(a.overdueSince);
      const begun = Math.min(Math.floor((t - c.termStart) / c.interval), c.total);
      const cure = inTx(e, "core.CovenantUnblocked", (x) => B(x.a.tokenId) === c.tid).length > 0;
      const why = k > prev ? (k === begun ? "" : `covered ${k}, ${begun} begun`)
        : k !== prev ? `went back from ${prev} to ${k}` : cure || c.reverifyPending || c.newSeatPending ? "" : "covered no interval and was no cure, 3C or new seat";
      sched.test(why === "" && L(a.verifier) === c.verifier && c.openChallenge === 0n, R(c.tid),
        () => `verified ${date(t)}: ${why || (L(a.verifier) !== c.verifier ? `by ${short(a.verifier)}, not the seated verifier` : `while challenge ${c.openChallenge} was undecided`)}`);
      // overdue (D3): past due + grace, from due + grace
      const due = c.termStart + (prev + 1) * c.interval;
      const wantOd = k > prev && t > due + cfg.maxDelay ? due + cfg.maxDelay : 0;
      const st = streams.get(c.tid);
      const credited = inTx(e, "tree.ReserveCredited", (x) => B(x.a.tokenId) === c.tid && N(x.a.source) === 1).length > 0;
      late.test(od === wantOd && (od === 0 || od >= Math.min(t, c.termEnd) || !st || st.ended || credited), R(c.tid),
        () => `overdueSince ${od ? date(od) : "none"}, expected ${wantOd ? date(wantOd) : "none"} (due ${date(due)}, verified ${date(t)})${od && !credited ? "; no late days credited" : ""}`);
      c.through = k; c.verifications++; c.reverifyPending = false; c.newSeatPending = false; c.nominee = Z; // the bound verifier acted: no replacement is due
      c.score = N(a.ecoScore);
      if (st) { st.score = N(a.ecoScore); if (!st.ended) st.rescore = false; }
      break;
    }

    // ---- the seat ----
    case "parties.SeatVacated": {
      const c = cov(a.tokenId)!;
      c.seat = { vacant: true, removed: L(a.verifier), firstClaimant: L(a.firstClaimant), firstClaimUntil: N(a.firstClaimUntil), vacantSince: t };
      c.nominee = Z;
      break;
    }
    case "parties.VerifierNominated": {
      const c = cov(a.tokenId)!, by = L(a.by), gov = L(addr.governance);
      const holderNow = resolve(c.holder0);
      let why = "";
      if (by !== gov && by !== holderNow) why = `nominated by ${short(by)}, not the covenant's Holder ${short(holderNow)} or the Council`;
      else if (by !== gov && c.seat.vacant) {
        if (c.seat.firstClaimUntil && t <= c.seat.firstClaimUntil) why = "inside the challenger's first claim";
        const from = c.seat.firstClaimUntil || c.seat.vacantSince;
        if (t > from + cfg.reseat) why = `${days(t - from)} into a ${days(cfg.reseat)} reseat window`;
      }
      rst.test(why === "", R(c.tid), () => why);
      c.nominee = L(a.nominee); c.nominatedBy = by;
      break;
    }
    case "core.VerifierReplaced": {
      const c = cov(a.tokenId)!, old = L(a.oldVerifier), nu = L(a.newVerifier), s = c.seat;
      const vacant = s.vacant;
      const due = c.termStart + (c.through + 1) * c.interval;
      const overdue = c.through < c.total && t > due + cfg.maxDelay;
      let why = "";
      if (!vacant && inStanding(old) && !overdue) why = `the seat was not vacant, ${short(old)} in standing and not late (due ${date(due)})`;
      const claimed = vacant && nu === s.firstClaimant && t <= s.firstClaimUntil;
      if (!claimed && c.nominee !== nu) why ||= `${short(nu)} was neither nominated nor the first claimant`;
      const former = vacant ? s.removed : old, vf = verifiers.get(nu);
      if (nu === old || nu === s.removed || nu === c.guardian) why ||= "the replaced verifier, the one that lost the seat, or the landowner";
      else if (!vf || vf.country !== c.country || !takesWork(nu)) why ||= `${short(nu)} is not a verifier of the country taking work`;
      else if (vf.org !== (verifiers.get(former)?.org ?? -1n) && !independentOf(nu, former)) why ||= `${short(nu)} was in ${short(former)}'s organisation and left it`;
      rst.test(why === "", R(c.tid), () => `${short(nu)} took the seat ${date(t)}: ${why}`);
      if (vacant) c.newSeatPending = true;
      c.seat = { ...s, vacant: false, firstClaimant: Z, firstClaimUntil: 0 };
      c.verifier = nu; c.nominee = Z;
      break;
    }
    case "parties.LandSaleApproved": { const c = cov(a.tokenId)!; c.saleApprovedAt = t; c.accessionPending = !!a.accessionDue; break; }
    case "parties.Acceded": cov(a.tokenId)!.accessionPending = false; break;
    case "parties.PayeeSwitchedByCouncil": {
      // the switch deletes the land sale: a pending accession can then neither be acceded to nor lapse
      const c = cov(a.tokenId)!;
      blk.test(!c.accessionPending, R(c.tid), () => `the Council switched the payee ${date(t)} while a buyer's accession was pending: the accession hold can no longer lift`);
      break;
    }
    case "parties.AccessionLapsed": {
      const c = cov(a.tokenId)!;
      tclk.test(t > c.saleApprovedAt + cfg.accession, R(c.tid), () => `accession lapsed ${days(t - c.saleApprovedAt)} after the switch; the window is ${days(cfg.accession)}`);
      c.accessionPending = false;
      const ac = accts.get(c.tid); if (ac) ac.shareToPatron = true;
      break;
    }

    // ---- the sale ----
    case "market.AuctionListed": {
      const c = cov(a.tokenId)!, st = countries.get(c.country)!;
      const p = B(a.startPrice), yearly = floorOf(c.units, BigInt(c.term), dOf(st.fees), false), twice = floorOf(c.units, BigInt(c.term), dOf(st.fees), true);
      const band = 500n * (2n * BigInt(c.term) + 1n) * USD;
      // twice a year needs the band and the twice-a-year floor; yearly the yearly floor -- which the twice-a-year floor exceeds
      floorC.test(p >= yearly, R(c.tid), () => `listed from ${usd(p)}; the yearly floor is ${usd(yearly)}${p >= band ? `, the twice-a-year ${usd(twice)}` : ""}`);
      auc.test(N(a.endsAt) - N(a.startsAt) >= cfg.minAuction && N(a.startsAt) >= t, R(c.tid), () => `an auction of ${days(N(a.endsAt) - N(a.startsAt))}`);
      listings.push({ tid: c.tid, endsAt: N(a.endsAt) });
      break;
    }
    case "market.AuctionSettled": if (a.kycPending) cov(a.tokenId)!.settledAt = t; break;
    case "market.StaleSaleCancelled": {
      const c = cov(a.tokenId)!;
      pay(e.tx, a.buyer, B(a.price));
      if (!a.failedCheck) tclk.test(t > c.settledAt + cfg.kyc, R(c.tid), () => `called off ${days(t - c.settledAt)} after the auction; the KYC window is ${days(cfg.kyc)}`);
      break;
    }
    case "market.SaleRefunded": pay(e.tx, a.buyer, B(a.price)); break;

    // ---- the term's money ----
    case "bank.HoldSet": { const ac = accts.get(B(a.tokenId)); if (ac) ac.holds = N(a.holds); break; }
    case "bank.InstalmentsReleased": {
      const tid = B(a.tokenId), c = cov(tid)!, count = N(a.count), amount = B(a.amount), p = a.payout;
      let ac = accts.get(tid);
      if (!ac) {
        // the first instalment is paid before the Bank's Activated event: open the account from it
        const act = inTx(e, "bank.Activated", (x) => B(x.a.tokenId) === tid)[0];
        const price = B(act.a.price), pool = B(act.a.reviewPool), total = N(act.a.totalReleases), net = price - pool;
        const per = net / BigInt(total + 1), first = per + (net % BigInt(total + 1));
        let cp = (consPerHa * c.units) / 100n; if (cp < consMin) cp = consMin;
        ac = { price, pool, balance: net - first, per, total, released: 0, holds: 0, consPer: cp, consYears: 0, shareToPatron: false, first, consPaid: 0n, verifierPaid: 0n, splitAt: splitChanges.length, closedHeld: 0n, split0: { ...split } };
        accts.set(tid, ac);
        c.interval = N(act.a.interval); c.total = total;
        // the cadence (D14) and the schedule, with the country's fees and the year now
        const st = countries.get(c.country)!;
        const twice = price >= 500n * (2n * BigInt(c.term) + 1n) * USD && price >= floorOf(c.units, BigInt(c.term), dOf(st.fees), true);
        const perYear = twice ? 2 : 1;
        cad.test(N(act.a.interval) === Math.floor(cfg.year / perYear) && total === c.term * perYear && B(act.a.firstInstalment) === first && amount === first && count === 0, R(tid),
          () => `price ${usd(price)}: interval ${days(N(act.a.interval))}, ${total} instalments for ${c.term} years (expected ${perYear} a year), first ${usd(B(act.a.firstInstalment))} (expected ${usd(first)})`);
        pool1.test(pool === (price * poolPermilleOf(split.tax, split.f)) / 1000n, R(tid), () => `pool ${usd(pool)} of ${usd(price)}`);
      } else {
        const closing = inTx(e, "bank.AccountClosed", (x) => B(x.a.tokenId) === tid).length > 0;
        const want = ac.released + count === ac.total || ac.per * BigInt(count) > ac.balance ? ac.balance : ac.per * BigInt(count);
        const through = inTx(e, "core.CovenantVerified", (x) => B(x.a.tokenId) === tid)[0]?.a.verifiedThrough ?? c.through;
        const upTo = Math.min(N(through), ac.total);
        relC.test(amount === want && (closing ? ac.released + count === ac.total : ac.holds === 0 && ac.released + count === upTo && count > 0), R(tid),
          () => `${count} instalment(s) of ${usd(amount)} (expected ${usd(want)}) after ${ac!.released}, verified through ${through}, holds ${ac!.holds}${closing ? " at the End Date" : ""}`);
        if (closing) ac.holds = 0;
        ac.balance -= amount; ac.released += count;
      }
      // the consideration first, then the split
      let owed = consOwed(ac, c, t);
      if (owed > amount) owed = amount - (amount % ac.consPer);
      consC.test(B(p.consideration) === owed, R(tid), () => `consideration ${usd(B(p.consideration))}, ${usd(owed)} owed (${ac!.consYears} years paid)`);
      ac.consYears += N(owed / ac.consPer); ac.consPaid += owed;
      const s = trancheSplit(amount - owed, split.v, split.tax, split.f);
      const heldEv = inTx(e, "bank.HolderFeeHeld", (x) => B(x.a.tokenId) === tid && x.ord < e.ord);
      const held = heldEv.reduce((x, y) => x + B(y.a.amount), 0n);
      split4.test(B(p.verifierFee) === s.v && B(p.foundationFee) === s.f && B(p.holderFee) + held === s.h && B(p.guardianAmount) === s.g + owed
        && B(p.verifierFee) + B(p.foundationFee) + B(p.holderFee) + held + B(p.guardianAmount) === amount && L(p.verifier) === c.verifier && L(p.guardian) === c.guardian, R(tid),
        () => `instalment ${usd(amount)} (consideration ${usd(owed)}): verifier ${usd(B(p.verifierFee))} (${usd(s.v)}), Foundation ${usd(B(p.foundationFee))} (${usd(s.f)}), Holder ${usd(B(p.holderFee) + held)} (${usd(s.h)}), landowner ${usd(B(p.guardianAmount))} (${usd(s.g + owed)})`);
      ac.verifierPaid += B(p.verifierFee);
      if (ac.splitAt !== splitChanges.length) ac.splitAt = -1;
      // the Holder fixed at the mint, along its succession line (D7); withheld while it is removed or frozen
      const h = resolve(c.holder0), withhold = !isActiveHolder(h) || isFrozen(h);
      hfee.test(L(p.holder) === h && (s.h === 0n || (withhold ? held === s.h && B(p.holderFee) === 0n : held === 0n)), R(tid),
        () => `the Holder's share to ${short(p.holder)} (${usd(B(p.holderFee))}, ${usd(held)} withheld); the covenant's Holder is ${short(h)}${withhold ? ", removed or frozen" : ""}`);
      pay(e.tx, p.verifier, B(p.verifierFee)); pay(e.tx, split.wallet, B(p.foundationFee)); pay(e.tx, p.holder, B(p.holderFee));
      if (ac.shareToPatron) { pay(e.tx, owners.get(tid) ?? Z, B(p.guardianAmount) - owed); pay(e.tx, p.guardian, owed); }
      else pay(e.tx, p.guardian, B(p.guardianAmount));
      break;
    }
    case "bank.HolderFeeReleased": {
      pay(e.tx, a.successor, B(a.amount));
      hfee.test(L(a.successor) === resolve(a.holder) && isActiveHolder(a.successor) && !isFrozen(a.successor), short(a.holder), () => `released to ${short(a.successor)}`);
      break;
    }
    case "bank.PaidToPatron": {
      const tid = B(a.tokenId), ac = accts.get(tid)!, amt = B(a.amount), pm = B(a.permille);
      pay(e.tx, a.owner, amt);
      saleCons.test(amt === (ac.balance * pm) / 1000n && L(a.owner) === (owners.get(tid) ?? ""), R(tid), () => `paid the patron ${usd(amt)} of ${usd(ac.balance)} at ${pm} permille`);
      ac.balance -= amt; ac.per = (ac.per * (1000n - pm)) / 1000n; ac.consPer = (ac.consPer * (1000n - pm)) / 1000n;
      const c = cov(tid); if (c) c.units = (c.units * (1000n - pm)) / 1000n;
      break;
    }
    case "bank.AccountClosed": {
      const tid = B(a.tokenId), ac = accts.get(tid)!, c = cov(tid)!;
      const rel = inTx(e, "bank.InstalmentsReleased", (x) => B(x.a.tokenId) === tid && x.ord < e.ord);
      if (rel.length) {
        saleCons.test(B(a.toGuardian) === B(rel[0].a.amount) && B(a.toPatron) === 0n, R(tid), () => `closed with ${usd(B(a.toGuardian))} to the landowner after a release of ${usd(B(rel[0].a.amount))}`);
      } else {
        // held for a breach or a Deed: the consideration owed to the landowner, the rest to the patron (FM P7)
        let owed = consOwed(ac, c, t); if (owed > ac.balance) owed = ac.balance;
        consC.test(B(a.toGuardian) === owed && B(a.toPatron) === ac.balance - owed && (ac.holds & (Holds.BREACH | Holds.DEED)) !== 0, R(tid),
          () => `closed with ${usd(B(a.toGuardian))} to the landowner and ${usd(B(a.toPatron))} to the patron of ${usd(ac!.balance)}; ${usd(owed)} consideration owed; holds ${ac!.holds}`);
        if (owed !== 0n) { ac.consYears = c.term; ac.consPaid += owed; }
        pay(e.tx, c.guardian, B(a.toGuardian)); pay(e.tx, owners.get(tid) ?? Z, B(a.toPatron));
        ac.balance = 0n; ac.released = ac.total; ac.closedHeld += B(a.toGuardian) + B(a.toPatron);
      }
      break;
    }

    // ---- the review windows and challenges ----
    case "challenge.ReviewPoolFunded": {
      const tid = B(a.tokenId);
      const pl = poolOf(tid);
      Object.assign(pl, { pool: pl.pool + B(a.amount), fee: B(a.windowFee), funded: Math.max(1, cov(tid)!.total), fundedAmount: pl.fundedAmount + B(a.amount) });
      break;
    }
    case "challenge.WindowOpened": {
      const tid = B(a.tokenId), c = cov(tid)!, pl = poolOf(tid);
      const through = N(inTx(e, "core.CovenantVerified", (x) => B(x.a.tokenId) === tid)[0]?.a.verifiedThrough ?? c.through);
      const prev = pl.win;
      sched.test(!prev || t > prev.closesAt, R(tid), () => `a window opened ${date(t)} while the last ran to ${date(prev!.closesAt)}`);
      rev.test(N(a.closesAt) - N(a.openedAt) === cfg.review, R(tid), () => `a window of ${days(N(a.closesAt) - N(a.openedAt))}`);
      halt.test(N(a.unattestedRuns) === pl.runs && !!a.halted === (pl.runs >= cfg.haltAfter), R(tid), () => `halted=${a.halted} at ${a.unattestedRuns} unattested runs (replayed ${pl.runs})`);
      const index = through > (prev?.through ?? 0) ? ++pl.opened : 0;
      pl.win = { openedAt: N(a.openedAt), closesAt: N(a.closesAt), attestor: Z, index, through, forfeited: false, settled: false };
      break;
    }
    case "challenge.VerificationAttested": {
      const tid = B(a.tokenId), c = cov(tid)!, pl = poolOf(tid), who = L(a.attestor), w = pl.win!;
      let why = "";
      if (who === c.verifier || who === c.guardian) why = "the land's own verifier or landowner";
      else if (inStanding(who)) { if (!(takesWork(who) && verifiers.get(who)!.country === c.country && independentOf(who, c.verifier))) why = "a verifier not independent of the land's"; }
      else if (isActiveHolder(who)) { if (isFrozen(who) || holders.get(who)!.country !== c.country || who === resolve(c.holder0) || who === holderOf(c.verifier)) why = "the covenant's Trust Admin, frozen, or of another country"; }
      else if (!gtas.has(who)) why = "neither a verifier, a Trust Admin nor a GTA";
      else if (t < w.openedAt + Math.floor((cfg.review * 7) / 10)) why = `a GTA on day ${((t - w.openedAt) / DAY).toFixed(1)}`;
      gtaA.test(why === "" && t <= w.closesAt, R(tid), () => `window attested by ${short(who)}: ${why || "after it closed"}`);
      w.attestor = who; pl.lastAttester = who; pl.runs = 0;
      break;
    }
    case "challenge.AttestationForfeited": { const pl = poolOf(B(a.tokenId)); if (pl.win) pl.win.forfeited = true; break; }
    case "challenge.WindowClosed": {
      const tid = B(a.tokenId), pl = poolOf(tid), w = pl.win!;
      const attested = !!a.attested;
      if (!attested) pl.runs += 1;
      halt.test(attested === (w.attestor !== Z) && N(a.unattestedRuns) === pl.runs, R(tid), () => `window closed attested=${attested} with ${a.unattestedRuns} runs (replayed ${pl.runs})`);
      const owed = attested && !w.forfeited && w.index !== 0 && w.index <= pl.funded;
      const fee0 = pl.attPay !== undefined ? pl.attPayBefore! : pl.pool;
      const want = owed ? (pl.fee < fee0 ? pl.fee : fee0) : 0n;
      winFee.test((pl.attPay ?? 0n) === want, R(tid), () => `window ${w.index} (attested ${attested}, forfeited ${w.forfeited}) paid its attester ${usd(pl.attPay ?? 0n)}; ${usd(want)} expected`);
      pl.attPay = undefined; pl.attPayBefore = undefined;
      w.settled = true;
      break;
    }
    case "challenge.ReviewFeePaid": {
      const tid = B(a.tokenId), pl = poolOf(tid), amt = B(a.amount), payee = N(a.payee), cid = B(a.challengeId);
      pay(e.tx, a.to, amt);
      if (payee === 0) { pl.attPayBefore = pl.pool; pl.attPay = amt; winFee.test(L(a.to) === pl.win?.attestor, R(tid), () => `the window's fee went to ${short(a.to)}, not its attester`); }
      if (payee === 3) {
        const c = cov(tid)!, owner = owners.get(tid) ?? Z;
        sweep.test(amt === pl.pool && ((c.status === CovenantStatus.ENDED && L(a.to) === c.guardian) || (c.status === CovenantStatus.CANCELLED && L(a.to) === owner)), R(tid),
          () => `swept ${usd(amt)} of ${usd(pl.pool)} to ${short(a.to)} with the covenant at status ${c.status}`);
        sweepOf.add(tid);
      }
      if (cid !== 0n) { const ch = chs.get(cid)!; if (ch.firstPool === undefined) ch.firstPool = pl.pool; }
      pl.pool -= amt; pl.paid += amt;
      break;
    }
    case "challenge.ChallengeRaised": {
      const cid = B(a.challengeId), o = N(a.option), subject = B(a.subject), who = L(a.challenger);
      let ch: Ch;
      if (o <= Option.W1B) {
        const r = reqs.get(N(subject))!;
        wd.test(r.status === RequestStatus.VERIFIED && t <= r.verifiedAt + cfg.watchdog && ![...chs.values()].some((x) => !x.ended && x.option <= 2 && x.subject === subject), `challenge ${cid}`,
          () => `raised ${days(t - r.verifiedAt)} after the verification, request status ${r.status}`);
        ch = { cid, option: o, subject, challenger: who, defendant: L(a.defendant), openedAt: t, verifier: r.verifier, guardian: r.guardian, holder: holderOf(r.verifier), chHolder: holderOf(who), country: r.country, panel: [], voters: new Set(), ended: false };
        raiser.test(ch.defendant === r.verifier, `challenge ${cid}`, () => `the defendant is ${short(ch.defendant)}, the verifier ${short(r.verifier)}`);
      } else {
        const c = cov(subject)!, w = pools.get(subject)?.win;
        let why = "";
        if (!(c.status === CovenantStatus.ACTIVE || c.status === CovenantStatus.BLOCKED) || t >= c.termEnd) why = `outside the term (status ${c.status})`;
        else if (c.openChallenge !== 0n) why = `challenge ${c.openChallenge} still undecided`;
        else if ((o === Option.T3A || o === Option.T3B) && (!w || t > w.closesAt || who === w.attestor)) why = !w || t > w.closesAt ? "no review window open" : "by the window's attester";
        else if (o === Option.T3E && !(c.status === CovenantStatus.BLOCKED && c.blockReason === BlockReason.BREACH && who === c.guardian)) why = "not the landowner of a covenant blocked for a breach";
        winOpt.test(why === "", `challenge ${cid}`, () => `${o} raised ${date(t)}: ${why}`);
        const holder = resolve(c.holder0);
        ch = { cid, option: o, subject, challenger: who, defendant: L(a.defendant), openedAt: t, verifier: c.verifier, guardian: c.guardian, holder, chHolder: holderOf(who), country: c.country, panel: [], voters: new Set(), ended: false };
        const want = o === Option.T3A ? holder : o === Option.T3D ? c.guardian : c.verifier;
        raiser.test(ch.defendant === want, `challenge ${cid}`, () => `option ${o} names ${short(ch.defendant)} as defendant; ${short(want)} expected`);
        c.openChallenge = cid;
      }
      if (o !== Option.T3E) {
        raiser.test(who !== ch.verifier && who !== ch.guardian && takesWork(who) && verifiers.get(who)?.country === ch.country && independentOf(who, ch.verifier), `challenge ${cid}`,
          () => `raised by ${short(who)} (org ${verifiers.get(who)?.org ?? "none"}) against the verifier ${short(ch.verifier)} (org ${verifiers.get(ch.verifier)?.org})`);
      }
      chs.set(cid, ch);
      break;
    }
    case "challenge.PanelSeated": {
      const ch = chs.get(B(a.challengeId))!, panel = (a.panel as string[]).map(L);
      ch.panel = panel; ch.voters = new Set();
      const excluded = new Set([ch.guardian, ch.holder, ch.chHolder, resolve(ch.holder), holderOf(ch.verifier), holderOf(ch.challenger)]);
      const eligible = [...holders.entries()].filter(([h, x]) => x.active && !x.frozen && x.country === ch.country && !excluded.has(h)).map(([h]) => h);
      const domestic = panel.filter((m) => eligible.includes(m)).length;
      const bad = panel.filter((m) => m === Z || excluded.has(m) || !(gtas.has(m) || eligible.includes(m)));
      panelC.test(bad.length === 0 && new Set(panel).size === 3 && domestic === Math.min(3, eligible.length), `challenge ${ch.cid}`,
        () => `panel ${panel.map(short).join(", ")}: ${bad.length ? `${bad.map(short).join(", ")} may not judge` : `${domestic} domestic seats of ${eligible.length} eligible Trust Admins`}`);
      break;
    }
    case "challenge.VoteCast": {
      const ch = chs.get(B(a.challengeId))!, m = L(a.member);
      panelC.test(ch.panel.includes(m), `challenge ${ch.cid}`, () => `${short(m)} voted, not on the panel`);
      ch.voters.add(m);
      if (ch.option > 2) { const c = cov(ch.subject)!; const pl = pools.get(ch.subject); ch.before = { status: c.status, blockReason: c.blockReason, win: pl?.win ? { ...pl.win } : undefined, lastAttester: pl?.lastAttester ?? Z }; }
      break;
    }
    case "challenge.ChallengeDetermined": {
      const ch = chs.get(B(a.challengeId))!, upheld = !!a.upheld, o = ch.option;
      dl.test(t < ch.openedAt + deadline, `challenge ${ch.cid}`, () => `decided ${days(t - ch.openedAt)} after the raise`);
      const same = byTx.get(e.tx)!;
      const has = (k: string, pred: (x: Ev) => boolean = () => true) => same.some((x) => `${x.c}.${x.name}` === k && pred(x));
      const flagged = same.filter((x) => x.c === "admin" && x.name === "PartyFlagged").map((x) => L(x.a.party));
      const got: string[] = [];
      const need = (cond: boolean, what: string) => { if (!cond) got.push(`missing: ${what}`); };
      // the flags
      let wantFlags: string[] = [];
      if (!upheld) { if (o !== Option.T3E) wantFlags = [ch.challenger]; }
      else if (o === Option.W1A || o === Option.W1B || o === Option.T3B || o === Option.T3E) wantFlags = [ch.verifier];
      else if (o === Option.T3A) {
        const w = ch.before?.win, lastA = w && w.attestor !== Z && !w.settled ? w.attestor : ch.before?.lastAttester ?? Z;
        if (lastA !== Z) wantFlags = [lastA];
        need(has("challenge.AttestationForfeited") === !!(w && w.attestor !== Z && !w.settled), "the window's fee forfeited exactly when it was attested and unsettled");
      }
      need(sameSet(flagged, wantFlags), `flags ${wantFlags.map(short).join(", ") || "none"} (flagged ${flagged.map(short).join(", ") || "none"})`);
      if (o <= Option.W1B) {
        const rid = N(ch.subject);
        const outcome = !upheld ? 1 : o === Option.W1A ? 2 : 3;
        need(has("registry.PreMintChallengeResolved", (x) => N(x.a.outcome) === outcome), `outcome ${outcome}`);
        need(has("registry.RequestReopened", (x) => N(x.a.requestId) === rid && L(x.a.barredVerifier) === ch.verifier) === (upheld && o === Option.W1A), "the request reopened (W1A upheld only), its verifier barred");
        need(has("registry.RequestEnded", (x) => N(x.a.requestId) === rid && N(x.a.reason) === 3) === (upheld && o === Option.W1B), "the request failed (W1B upheld only)");
        // the judgment fee to the judges who voted
        const jp = same.filter((x) => x.name === "JudgmentPaid");
        chFee.test(jp.every((x) => sameSet((x.a.voters as string[]).map(L), [...ch.voters])), `challenge ${ch.cid}`, () => `the judgment fee went to ${jp.map((x) => (x.a.voters as string[]).map(short).join("+")).join("; ")}, the voters were ${[...ch.voters].map(short).join(", ")}`);
      } else {
        const tid = ch.subject, c = cov(tid)!, before = ch.before ?? { status: c.status, blockReason: c.blockReason, lastAttester: Z };
        const verdict = has("core.VerdictApplied", (x) => B(x.a.tokenId) === tid && N(x.a.option) === o && L(x.a.challenger) === ch.challenger);
        need(verdict === upheld, upheld ? "the verdict applied" : "no verdict applied");
        const released = has("bank.InstalmentsReleased", (x) => B(x.a.tokenId) === tid);
        const blocked = (r: number) => has("core.CovenantBlocked", (x) => B(x.a.tokenId) === tid && N(x.a.reason) === r);
        if (upheld && o === Option.T3A) need(blocked(BlockReason.DEED) && has("bank.HoldSet", (x) => B(x.a.tokenId) === tid && N(x.a.hold) === Holds.DEED && x.a.on) && !released, "blocked under 3A, the Deed hold set, nothing released");
        if (upheld && o === Option.T3B) need(has("parties.SeatVacated", (x) => B(x.a.tokenId) === tid && L(x.a.verifier) === ch.verifier && L(x.a.firstClaimant) === ch.challenger && N(x.a.firstClaimUntil) === t + cfg.firstClaim)
          // (a stream the Council already ended for fraud is not held: Tree.hold does nothing on it)
          && (has("tree.RewardHeld", (x) => B(x.a.tokenId) === tid && x.a.rescoreOnLift) || !!streams.get(tid)?.ended) && !released, "the seat vacated with the challenger's first claim, TR3 held for rescoring, nothing released");
        if (upheld && o === Option.T3C) need(has("core.ReverificationDue", (x) => B(x.a.tokenId) === tid), "a re-verification due");
        // D16: the breach is a cause of the block whether or not the covenant was already blocked; a Deed or a partition
        // block keeps its reason (resolved first), with the breach behind it
        if (upheld && o === Option.T3D) need(blocked(BlockReason.BREACH) && !released, "the breach recorded as a cause of the block, nothing released");
        if (upheld && o === Option.T3E) need(has("core.CovenantUnblocked", (x) => B(x.a.tokenId) === tid) === (before.status === CovenantStatus.BLOCKED && before.blockReason === BlockReason.BREACH), "the breach block lifted");
        if (!upheld) need(!has("core.CovenantBlocked") && !has("parties.SeatVacated") && !has("core.ReverificationDue") && !has("core.CovenantUnblocked"), "nothing changed");
        // the fee: 40% to the voters, 60% to an upheld challenger, of one act's fee (or what the pool has left)
        const pl = pools.get(tid);
        const pool0 = ch.firstPool ?? pl?.pool ?? 0n, fee = pl ? (pl.fee < pool0 ? pl.fee : pool0) : 0n, judges = (fee * 400n) / 1000n;
        const nv = BigInt(ch.voters.size), each = nv ? judges / nv : 0n;
        const paid = same.filter((x) => x.name === "ReviewFeePaid" && B(x.a.challengeId) === ch.cid);
        const toPanel = paid.filter((x) => N(x.a.payee) === 1), toCh = paid.filter((x) => N(x.a.payee) === 2);
        chFee.test(toPanel.length === (each ? ch.voters.size : 0) && toPanel.every((x) => B(x.a.amount) === each && ch.voters.has(L(x.a.to)))
          && toCh.reduce((s, x) => s + B(x.a.amount), 0n) === (upheld ? fee - judges : 0n) && toCh.every((x) => L(x.a.to) === ch.challenger), `challenge ${ch.cid}`,
          () => `${upheld ? "upheld" : "dismissed"}, act fee ${usd(fee)}: judges ${toPanel.map((x) => usd(B(x.a.amount))).join("+") || "0"} (expected ${ch.voters.size} x ${usd(each)}), challenger ${usd(toCh.reduce((s, x) => s + B(x.a.amount), 0n))} (expected ${usd(upheld ? fee - judges : 0n)})`);
        c.openChallenge = 0n;
      }
      cons.test(got.length === 0, `challenge ${ch.cid}`, () => `option ${o} ${upheld ? "upheld" : "dismissed"}: ${got.join("; ")} (transaction emitted ${same.map((x) => x.name).join(", ")})`);
      ch.ended = true;
      break;
    }
    case "challenge.ChallengeLapsed": case "challenge.ChallengeWithdrawn": {
      const ch = chs.get(B(a.challengeId))!, lapsed = e.name === "ChallengeLapsed";
      if (lapsed) dl.test(t >= ch.openedAt + deadline, `challenge ${ch.cid}`, () => `lapsed ${days(t - ch.openedAt)} after the raise`);
      const same = byTx.get(e.tx)!;
      cons.test(!same.some((x) => x.name === "PartyFlagged" || x.name === "VerdictApplied"), `challenge ${ch.cid}`, () => `${lapsed ? "lapsed" : "withdrawn"}, yet a flag or a verdict`);
      const voters = lapsed ? ch.voters : new Set<string>();
      if (lapsed) chFee.test(N(a.voters) === voters.size, `challenge ${ch.cid}`, () => `lapsed with ${a.voters} voters; ${voters.size} voted`);
      if (ch.option > 2) {
        const pl = pools.get(ch.subject), pool0 = ch.firstPool ?? pl?.pool ?? 0n, fee = pl ? (pl.fee < pool0 ? pl.fee : pool0) : 0n;
        const nv = BigInt(voters.size), each = nv ? (fee * 400n) / 1000n / nv : 0n;
        const paid = same.filter((x) => x.name === "ReviewFeePaid" && B(x.a.challengeId) === ch.cid);
        chFee.test(paid.length === (each ? voters.size : 0) && paid.every((x) => N(x.a.payee) === 1 && B(x.a.amount) === each && voters.has(L(x.a.to))), `challenge ${ch.cid}`,
          () => `${lapsed ? "lapsed" : "withdrawn"} with ${voters.size} voters: paid ${paid.map((x) => usd(B(x.a.amount))).join("+") || "nothing"}, expected ${voters.size} x ${usd(each)}`);
        cov(ch.subject)!.openChallenge = 0n;
      } else {
        const jp = same.filter((x) => x.name === "JudgmentPaid");
        chFee.test(voters.size === 0 ? jp.length === 0 : jp.every((x) => sameSet((x.a.voters as string[]).map(L), [...voters])), `challenge ${ch.cid}`, () => `undecided with ${voters.size} voters, ${jp.length} judgment payments`);
      }
      ch.ended = true;
      break;
    }

    // ---- TR3 ----
    case "tree.EditionClosed": {
      const cap = capOf(ed), burn = ((cap - used) * PER_EDITION) / cap, byClock = !!a.byClock;
      let why = "";
      if (byClock) { if (t < openedAt + clock) why = `${days(openedAt + clock - t)} before its eight years were up`; }
      else {
        const next = inTx(e, "tree.LandPlaced", (x) => x.ord > e.ord)[0];
        if (next) {
          const r = reqs.get(N(next.a.requestId))!, ly = r.units * BigInt(r.term);
          if (!(ed < LAST_EDITION && ly > cap - used)) why = `closed for #${r.rid}'s ${ly} land-years with ${cap - used} room`;
          noFit++;
        } else if (used !== cap) why = `closed full with ${used} of ${cap} land-years`;
      }
      cls.test(why === "" && N(a.edition) === ed && B(a.landYears) === used && B(a.burned) === burn, `edition ${a.edition}`,
        () => why || `closed with ${a.landYears} land-years and ${usd(B(a.burned))} burned; expected edition ${ed}, ${used} land-years, ${usd(burn)} burned`);
      burnedEv += B(a.burned); closesCount++;
      openedAt = byClock ? openedAt + clock : t;
      ed++; used = 0n;
      break;
    }
    case "tree.LandPlaced": {
      const rid = N(a.requestId), r = reqs.get(rid)!;
      cls.test(t < openedAt + clock, `edition ${ed}`, () => `a land placed ${date(t)}, past the edition's eight years`);
      const cap = capOf(ed), room = cap - used, asked = r.units * BigInt(r.term);
      const ly = asked < room ? asked : room;
      if (ly < asked) truncated++;
      const rawFull = (ly * PER_EDITION) / cap, full = rawFull > MAX_BASE ? MAX_BASE : rawFull;
      // wholly in one edition (D1): only the 21st edition, or an edition the land is larger than, takes less
      const whole = ly === asked || ed === LAST_EDITION || room === cap;
      plc.test(N(a.edition) === ed && B(a.landYears) === ly && B(a.tr3AtFullScore) === full && whole, `#${rid}`,
        () => `placed ${a.landYears} of ${asked} land-years in edition ${a.edition} for ${usd(B(a.tr3AtFullScore))} TR3; expected ${ly} in edition ${ed} for ${usd(full)}`);
      capBurn += rawFull - full;
      used += ly;
      places.set(rid, { rid, edition: ed, ly, full, released: false });
      break;
    }
    case "tree.PlaceReleased": {
      const rid = N(a.requestId), p = places.get(rid);
      const reopened = !!p && p.edition === ed;
      const ended = inTx(e, "registry.RequestEnded", (x) => N(x.a.requestId) === rid && N(x.a.reason) !== 7).length > 0;
      plRel.test(!!p && !p.released && N(a.edition) === p.edition && B(a.landYears) === p.ly && !!a.roomReopened === reopened && B(a.burned) === (reopened ? 0n : p.full) && ended, `#${rid}`,
        () => `released edition ${a.edition}, ${a.landYears} land-years, reopened ${a.roomReopened}, burned ${usd(B(a.burned))}; its place: edition ${p?.edition}, ${p?.ly}, open edition ${ed}`);
      if (p) { p.released = true; if (reopened) used -= p.ly; }
      burnedEv += B(a.burned);
      break;
    }
    case "tree.EditionAssigned": {
      const tid = B(a.tokenId), p = places.get(reqOfToken.get(tid) ?? -1);
      asg.test(!!p && !p.released && N(a.edition) === p.edition && B(a.landYears) === p.ly, R(tid), () => `activated in edition ${a.edition} with ${a.landYears}; placed in ${p?.edition} with ${p?.ly}`);
      break;
    }
    case "tree.RewardStarted": {
      const tid = B(a.tokenId), p = places.get(reqOfToken.get(tid) ?? -1), c = cov(tid)!;
      rew.test(!!p && B(a.allocation) === p.full && N(a.edition) === p.edition && N(a.ecoScore) === c.score, R(tid), () => `${usd(B(a.allocation))} TR3 in edition ${a.edition} at score ${a.ecoScore}; the place holds ${usd(p?.full ?? 0n)} in ${p?.edition}, score ${c.score}`);
      trCap.test(B(a.allocation) <= MAX_BASE, R(tid), () => `allocation ${usd(B(a.allocation))}`);
      streams.set(tid, { alloc: B(a.allocation), edition: N(a.edition), score: N(a.ecoScore), rescore: false, ended: false, stream: 0n, credits: 0n, mE6: 0n, left: 0n });
      break;
    }
    case "tree.RewardHeld": { const s = streams.get(B(a.tokenId)); if (s && a.rescoreOnLift) s.rescore = true; break; }
    case "tree.StreamReleased": {
      const tid = B(a.tokenId), s = streams.get(tid)!, amt = B(a.amount), score = N(a.score);
      const ver = inTx(e, "core.CovenantVerified", (x) => B(x.a.tokenId) === tid)[0];
      const want = ver && s.rescore ? N(ver.a.ecoScore) : s.score;
      // the score's shortfall: the next ECOSCORE credit of this settle, if any
      const tx = byTx.get(e.tx)!, k = tx.indexOf(e);
      let credit = 0n;
      for (let j = k + 1; j < tx.length; j++) {
        const x = tx[j];
        if (B(x.a.tokenId ?? -1n) !== tid) continue;
        if (x.name === "StreamReleased" || x.name === "RewardEnded" || x.name === "BoostPaid") break;
        if (x.name === "ReserveCredited" && N(x.a.source) === 0) { credit = B(x.a.amount); break; }
      }
      relScore.test(score === want && amt === ((amt + credit) * BigInt(score)) / 100n, R(tid), () => `released ${usd(amt)} at score ${score} (expected ${want}), ${usd(credit)} credited for the shortfall`);
      // a boost pays released x (M - 1) from what its commit has left; its BoostPaid comes just before
      let boost = 0n;
      for (let j = k - 1; j >= 0; j--) {
        const x = tx[j];
        if (B(x.a.tokenId ?? -1n) !== tid) continue;
        if (x.name === "BoostPaid") boost = B(x.a.amount);
        break;
      }
      if (s.mE6 !== 0n) {
        let b = (amt * (s.mE6 - 1_000_000n)) / 1_000_000n; if (b > s.left) b = s.left;
        ovc.test(boost === b, R(tid), () => `boost paid ${usd(boost)} on ${usd(amt)}; ${usd(b)} expected at M ${Number(s.mE6) / 1e6}`);
        s.left -= boost;
      } else ovc.test(boost === 0n, R(tid), () => `a boost of ${usd(boost)} without a commit`);
      s.stream += amt; releasedEv += amt;
      break;
    }
    case "tree.BoostPaid": releasedEv += B(a.amount); committedEv -= B(a.amount); break;
    case "tree.ReserveCredited": {
      const tid = B(a.tokenId), s = streams.get(tid);
      if (s && N(a.source) !== 4) s.credits += B(a.amount);
      reserveEv += B(a.amount);
      break;
    }
    case "tree.BoostReturned": {
      const s = streams.get(B(a.tokenId))!;
      ovc.test(B(a.amount) === s.left, R(B(a.tokenId)), () => `returned ${usd(B(a.amount))}; ${usd(s.left)} was left`);
      s.left = 0n; committedEv -= B(a.amount);
      break;
    }
    case "tree.RewardEnded": {
      const tid = B(a.tokenId), s = streams.get(tid)!;
      strCons.test(s.stream + s.credits === s.alloc && !s.ended, R(tid), () => `ended with ${usd(s.stream)} released and ${usd(s.credits)} credited of ${usd(s.alloc)}`);
      s.ended = true;
      break;
    }
    case "tree.BoostCommitted": {
      const tid = B(a.tokenId), s = streams.get(tid)!, commit = B(a.commit), mE6 = B(a.mE6);
      const oc = inTx(e, "overcharge.OverchargeCommitted", (x) => B(x.a.targetId) === tid)[0];
      const relic = oc ? relics.get(B(oc.a.relicId)) : undefined;
      const remaining = s.alloc - s.stream - s.credits;
      let want = (remaining * (mE6 - 1_000_000n)) / 1_000_000n;
      if (relic && relic.cap < want) want = relic.cap;
      if (reserveEv < want) want = reserveEv;
      const m = relic ? (fib(s.edition) * 1_000_000n) / fib(relic.edition) : 0n;
      ovc.test(!!relic && relic.edition < s.edition && mE6 === m && commit === want && s.mE6 === 0n && !s.ended, R(tid),
        () => `committed ${usd(commit)} at M ${Number(mE6) / 1e6}; expected ${usd(want)} at ${Number(m) / 1e6} (Relic edition ${relic?.edition}, cap ${usd(relic?.cap ?? 0n)}, target edition ${s.edition})`);
      s.mE6 = mE6; s.left = commit;
      reserveEv -= commit; committedEv += commit;
      break;
    }
    case "tree.ReserveFinalized": burnedEv += B(a.amount); reserveEv -= B(a.amount); break;
    case "tree.RewardClaimed": {
      const tid = B(a.tokenId), x = claims.get(tid) ?? { p: 0n, g: 0n, r: 0n };
      x.p += B(a.patronAmount); x.g += B(a.guardianAmount); x.r += B(a.referrerAmount);
      claims.set(tid, x);
      claimedEv += B(a.patronAmount) + B(a.guardianAmount) + B(a.referrerAmount);
      const ref = L(a.referrer);
      if (ref !== Z) {
        const judges = (verifiers.has(ref) && !verifiers.get(ref)!.dismissed) || isActiveHolder(ref) || gtas.has(ref);
        if (judges) trRef.test(B(a.referrerAmount) === 0n, R(tid), () => `the referrer ${short(ref)} judges scores, yet took ${usd(B(a.referrerAmount))}`);
        else trRef.ok();
      }
      break;
    }
    case "overcharge.RelicMinted": {
      const src = B(a.fromTokenId), s = streams.get(src), c = cov(src);
      ovc.test(!!s && s.ended && c?.status === CovenantStatus.ENDED && N(a.edition) === s.edition && B(a.cap) === s.stream, `Relic ${a.relicId}`,
        () => `minted from ${R(src)} (status ${c?.status}) with cap ${usd(B(a.cap))} in edition ${a.edition}; its land released ${usd(s?.stream ?? 0n)} in ${s?.edition}`);
      relics.set(B(a.relicId), { edition: N(a.edition), cap: B(a.cap) });
      break;
    }
    case "overcharge.Transmuted": {
      const x = relics.get(B(a.relicA)), y = relics.get(B(a.relicB));
      ovc.test(!!x && !!y && x.edition === y.edition && x.edition >= 2 && N(a.edition) === x.edition - 1 && B(a.cap) === x.cap + y.cap, `Relic ${a.relicId}`,
        () => `transmuted editions ${x?.edition} and ${y?.edition} into ${a.edition} with cap ${usd(B(a.cap))}`);
      relics.delete(B(a.relicA)); relics.delete(B(a.relicB));
      relics.set(B(a.relicId), { edition: N(a.edition), cap: B(a.cap) });
      break;
    }
    case "overcharge.OverchargeCommitted": relics.delete(B(a.relicId)); break;
  }
}
flushTx();

// =====================================================================================
// The state now, against the replay
// =====================================================================================

const reqIds = [...reqs.keys()];
const reqNow = await Promise.all(reqIds.map((rid) => rd("registry", "getRequest", [BigInt(rid)])));
// a request's listing window opens at its Deed's date, or its mint: read back now (it is fixed by the mint)
const reqStateListingFrom = new Map(reqIds.map((rid, i) => [rid, N(reqNow[i].listingFrom)]));
for (const e of E("registry.RequestEnded")) {
  if (N(e.a.reason) !== 4) continue;
  const r = reqs.get(N(e.a.requestId))!;
  lst.test(e.t > (reqStateListingFrom.get(r.rid) ?? 0) + r.listing, `#${r.rid}`, () => `closed unsold ${date(e.t)}; its window ran to ${date((reqStateListingFrom.get(r.rid) ?? 0) + r.listing)}`);
}
reqIds.forEach((rid, i) => {
  const r = reqs.get(rid)!, x = reqNow[i];
  const held = B(x.verifierShare) + B(x.attestationFee) + B(x.judgmentFee) + B(x.allowance);
  const paidIn = r.vf + r.af + r.jf + r.al, left = r.left.share + r.left.att + r.left.jud + r.left.al;
  upCons.test(held === left, `#${rid}`, () => `paid in ${usd(paidIn)}; the replay leaves ${usd(left)}, the Registry holds ${usd(held)}`);
  lst.test(N(x.listingWindow) === r.listing && N(x.postSaleWindow) === r.postSale, `#${rid}`, () => `took listing ${days(N(x.listingWindow))}, post-sale ${days(N(x.postSaleWindow))}; the country had ${days(r.listing)} and ${days(r.postSale)}`);
});
for (const l of listings) {
  const rid = reqOfToken.get(l.tid)!, r = reqs.get(rid)!, from = reqStateListingFrom.get(rid) ?? 0;
  auc.test(l.endsAt <= from + r.listing, R(l.tid), () => `the auction closes ${date(l.endsAt)}, after its listing window (${date(from + r.listing)})`);
}

// the covenants, their accounts, pools and streams now
const tids = [...covs.keys()];
const covNow = await Promise.all(tids.map(async (tid) => {
  const [c, a, pool, seatNow, rw, holderNow] = await Promise.all([
    rd("core", "getCovenant", [tid]), rd("bank", "getAccount", [tid]), rd("challenge", "poolBalance", [tid]), rd("parties", "getSeat", [tid]),
    rd("tree", "rewardOf", [tid]), rd("core", "holderOf", [tid]),
  ]);
  return { tid, c, a, pool: B(pool), seat: seatNow, rw, holder: L(holderNow) };
}));
let claimable = 0n, unstreamedEv = 0n, livePlaces = 0n, verifierSummary = { terms: 0, share: 0 };
for (const x of covNow) {
  const c = covs.get(x.tid)!, ac = accts.get(x.tid), s = streams.get(x.tid), pl = pools.get(x.tid);
  // the money
  if (ac) {
    const released = E("bank.InstalmentsReleased").filter((e) => B(e.a.tokenId) === x.tid).reduce((v, e) => v + B(e.a.amount), 0n);
    const toPatron = E("bank.PaidToPatron").filter((e) => B(e.a.tokenId) === x.tid).reduce((v, e) => v + B(e.a.amount), 0n);
    const closedHeld = (ac as any).closedHeld ?? 0n;
    saleCons.test(ac.price === ac.pool + released + toPatron + closedHeld + B(x.a.balance), R(x.tid),
      () => `price ${usd(ac.price)} vs pool ${usd(ac.pool)} + released ${usd(released)} + to the patron ${usd(toPatron)} + held at the End Date ${usd(closedHeld)} + held ${usd(B(x.a.balance))}`);
    bankRep.test(ac.balance === B(x.a.balance) && ac.released === N(x.a.released) && ac.consYears === N(x.a.considerationYears) && ac.holds === N(x.a.holds) && ac.per === B(x.a.perRelease) && ac.consPer === B(x.a.consideration), R(x.tid),
      () => `replayed balance ${usd(ac.balance)}, ${ac.released} released, ${ac.consYears} years, holds ${ac.holds}; the Bank has ${usd(B(x.a.balance))}, ${x.a.released}, ${x.a.considerationYears}, holds ${x.a.holds}`);
    if (N(x.c.status) === CovenantStatus.ENDED && ac.splitAt !== -1 && E("bank.PaidToPatron").every((e) => B(e.a.tokenId) !== x.tid) && !(ac as any).closedHeld) {
      // the split the whole term ran under
      const pp = poolPermilleOf(ac.split0.tax, ac.split0.f);
      const expect = ((ac.price - ac.pool - ac.consPaid) * ac.split0.v) / (1000n - pp);
      const diff = ac.verifierPaid > expect ? ac.verifierPaid - expect : expect - ac.verifierPaid;
      vshare.test(diff <= BigInt(ac.total + 2) * 2n, R(x.tid), () => `the verifier earned ${usd(ac.verifierPaid)}; ${usd(expect)} is its share of ${usd(ac.price - ac.pool - ac.consPaid)}`);
      verifierSummary.terms++; verifierSummary.share += Number(ac.verifierPaid) / Number(ac.price);
    }
    // the End Date accounted, long after the term and its grace
    if (N(x.c.status) === CovenantStatus.ENDED) termEnd.test(B(x.a.balance) === 0n && N(x.a.released) === N(x.a.totalReleases), R(x.tid), () => `ended with ${usd(B(x.a.balance))} held, ${x.a.released} of ${x.a.totalReleases} released`);
    else if ([CovenantStatus.ACTIVE, CovenantStatus.BLOCKED].includes(N(x.c.status) as any)) termEnd.test(now < N(x.c.termEnd) + cfg.maxDelay + cfg.review + 120 * DAY, R(x.tid), () => `term ended ${date(N(x.c.termEnd))}, not yet closed`);
    // the holds against the block and the seat (FM P7: a block in the term holds its instalments)
    if ([CovenantStatus.ACTIVE, CovenantStatus.BLOCKED].includes(N(x.c.status) as any)) {
      // the replay's status and seat against Core's and EcoParties' now, then the same rule on the Bank's holds now
      const same = N(x.c.status) === c.status && N(x.c.blockReason) === c.blockReason && !!x.seat.vacant === c.seat.vacant && !!x.seat.reverifyFirst === c.newSeatPending;
      const bad = holdsOk(c, N(x.a.holds));
      blk.test(same && bad.length === 0, R(x.tid), () => same ? `now: holds ${x.a.holds}: ${bad.join("; ")}` : `replayed status ${c.status}/${c.blockReason}, seat ${c.seat.vacant}/${c.newSeatPending}; Core and EcoParties have ${x.c.status}/${x.c.blockReason}, ${x.seat.vacant}/${x.seat.reverifyFirst}`);
    }
  }
  // the Holder now: the mint's, along its line (D7)
  hfee.test(x.holder === resolve(c.holder0), R(x.tid), () => `Core names ${short(x.holder)} as the Holder; the mint's was ${short(c.holder0)}, now ${short(resolve(c.holder0))}`);
  // the pool
  if (pl) {
    poolC.test(pl.fundedAmount === pl.paid + x.pool && pl.pool === x.pool, R(x.tid), () => `funded ${usd(pl.fundedAmount)}, paid ${usd(pl.paid)}, held ${usd(x.pool)} (replayed ${usd(pl.pool)})`);
    if (N(x.c.status) === CovenantStatus.ENDED && x.pool !== 0n && !sweepOf.has(x.tid)) sweep.test(now < N(x.c.termEnd) + cfg.maxDelay + cfg.review + 120 * DAY, R(x.tid), () => `${usd(x.pool)} still in the pool, the term ended ${date(N(x.c.termEnd))}`);
  }
  // TR3
  if (s) {
    const v = x.rw, rel = B(v.released), gross = (rel * 10n) / 100n, ref = L(x.c.referral);
    const refSlot = ref === Z ? 0n : (gross * 30n) / 100n;
    const patron = B(v.patronPaid) + B(v.patronClaimable), guardian = B(v.guardianPaid) + B(v.guardianClaimable), referral = B(v.referralPaid) + B(v.referralClaimable);
    const cl = claims.get(x.tid) ?? { p: 0n, g: 0n, r: 0n };
    trSplit.test(patron === rel - gross && guardian === gross - refSlot && referral === refSlot && cl.p === B(v.patronPaid) && cl.g + cl.r === B(v.guardianPaid) + B(v.referralPaid), R(x.tid),
      () => `released ${usd(rel)}: patron ${usd(patron)}, landowner ${usd(guardian)}, referral ${usd(referral)}; claimed ${usd(cl.p)} / ${usd(cl.g + cl.r)}`);
    trCap.test(B(v.landEarned) <= B(v.allocation) && B(v.landEarned) === s.stream, R(x.tid), () => `land TR3 ${usd(B(v.landEarned))} of ${usd(B(v.allocation))} (the events released ${usd(s.stream)})`);
    if (!s.ended) strCons.test(s.stream + s.credits <= s.alloc, R(x.tid), () => `${usd(s.stream)} released and ${usd(s.credits)} credited of ${usd(s.alloc)}`);
    ovc.test(B(v.boostLeft) === s.left && B(v.mE6) === s.mE6, R(x.tid), () => `boost left ${usd(B(v.boostLeft))} (replayed ${usd(s.left)})`);
    claimable += B(v.patronClaimable) + B(v.guardianClaimable) + B(v.referralClaimable);
  }
}
// the places not released and the allocations they carry, less what each stream has accounted
for (const p of places.values()) {
  if (p.released) continue;
  livePlaces += p.full;
  const tid = [...reqOfToken].find(([, rid]) => rid === p.rid)?.[0];
  const s = tid !== undefined ? streams.get(tid) : undefined;
  unstreamedEv += p.full - (s ? s.stream + s.credits : 0n);
}
// a place never released must be a covenant that started, or a minted one still under way
for (const p of places.values()) {
  const r = reqs.get(p.rid)!;
  if (!p.released && r.ended) plRel.test(E("registry.RequestEnded").some((e) => N(e.a.requestId) === p.rid && N(e.a.reason) === 7), `#${p.rid}`, () => "its request ended without a covenant, yet its place was never released");
}
for (const e of E("tree.PlaceReleased")) plRel.test(!streams.has([...reqOfToken].find(([, rid]) => rid === N(e.a.requestId))?.[0] ?? -1n), `#${e.a.requestId}`, () => "a covenant's land was released");

// the editions: the replay against Tree, and the supply breakdown
{
  const [open, usedNow, openedNow] = await Promise.all([rd("tree", "editionOpen"), rd("tree", "editionUsed"), rd("tree", "editionOpenedAt")]);
  edState.test(N(open) === ed && B(usedNow) === used && N(openedNow) === openedAt, "Tree", () => `Tree: edition ${open} with ${usedNow} land-years, opened ${date(N(openedNow))}; replayed ${ed}, ${used}, ${date(openedAt)}`);
  // the clock as it stands now: editions it has run past that nobody has closed yet
  let n2 = ed, o2 = openedAt, u2 = used;
  while (n2 <= LAST_EDITION && now >= o2 + clock) { n2++; o2 += clock; u2 = 0n; }
  const clockBurn = n2 === ed || ed > LAST_EDITION ? 0n : ((capOf(ed) - used) * PER_EDITION) / capOf(ed) + BigInt(n2 - ed - 1) * PER_EDITION;
  const unplacedEv = n2 > LAST_EDITION ? 0n : ((capOf(n2) - u2) * PER_EDITION) / capOf(n2) + BigInt(LAST_EDITION - n2) * PER_EDITION;
  const [sb, unplaced, supply, mp, mg, mr] = await Promise.all([rd("tree", "supplyBreakdown"), rd("tree", "unplacedCapacity"), rd("tree", "totalSupply"),
    rd("tree", "mintedToPatrons"), rd("tree", "mintedToGuardians"), rd("tree", "mintedToReferrers")]);
  trSup.test(B(supply) === claimedEv && B(supply) === B(mp) + B(mg) + B(mr), "TREE", () => `supply ${usd(B(supply))}, claims ${usd(claimedEv)}, minted to the three parties ${usd(B(mp) + B(mg) + B(mr))}`);
  const parts: [string, bigint, bigint][] = [
    ["minted", B(sb.minted), claimedEv], ["owed", B(sb.owed), releasedEv - claimedEv], ["reserve", B(sb.reserve), reserveEv],
    ["committed", B(sb.committed), committedEv], ["unstreamed", B(sb.unstreamed), unstreamedEv],
    ["burned", B(sb.burned), burnedEv + capBurn + clockBurn], ["unplaced", B(unplaced), unplacedEv],
  ];
  for (const [what, chain, ev] of parts) brk.test(chain === ev, what, () => `Tree has ${usd(chain)}, the events give ${usd(ev)}`);
  const sum = B(sb.minted) + B(sb.owed) + B(sb.reserve) + B(sb.committed) + B(sb.unstreamed) + B(sb.unallocated) + B(sb.burned);
  const dust = B(sb.unallocated) - B(unplaced), bound = BigInt(E("tree.LandPlaced").length + closesCount + 22);
  brk.test(sum === MAX_SUPPLY && dust >= 0n && dust <= bound, "210,000,000", () => `the parts sum to ${usd(sum)}; unallocated ${usd(B(sb.unallocated))} vs unplaced ${usd(B(unplaced))} (dust ${dust} wei, at most ${bound})`);
  brk.test(B(sb.owed) === claimable, "owed", () => `owed ${usd(B(sb.owed))}; the covenants have ${usd(claimable)} claimable`);
  observations.tr3 = {
    minted: usd(B(sb.minted)), owed: usd(B(sb.owed)), reserve: usd(B(sb.reserve)), committed: usd(B(sb.committed)), unstreamed: usd(B(sb.unstreamed)),
    unallocated: usd(B(sb.unallocated)), burned: usd(B(sb.burned)), allocatedLive: usd(livePlaces), dustWei: String(dust),
    placementCapBurned: usd(capBurn), reserveFinalized: E("tree.ReserveFinalized").length > 0,
  };
  observations.editions = {
    open: ed, closed: closesCount, byClock: E("tree.EditionClosed").filter((e) => e.a.byClock).length, noFitCloses: noFit,
    landsLargerThanTheirEdition: truncated, burnedByCloses: usd(E("tree.EditionClosed").reduce((x, e) => x + B(e.a.burned), 0n)),
    placesReleased: E("tree.PlaceReleased").length,
  };
}

// the challenges and the seats, long after their deadlines
for (const ch of chs.values()) chEnd.test(ch.ended || now < ch.openedAt + deadline + 14 * DAY, `challenge ${ch.cid}`, () => `raised ${date(ch.openedAt)}, still open`);
for (const c of covs.values()) {
  if (!c.seat.vacant) continue;
  const st = covNow.find((x) => x.tid === c.tid)!.c.status;
  seat.test(now < c.seat.vacantSince + cfg.firstClaim + cfg.reseat + 90 * DAY || ![CovenantStatus.ACTIVE, CovenantStatus.BLOCKED].includes(N(st) as any), R(c.tid), () => `vacated ${date(c.seat.vacantSince)}, not refilled`);
}
for (const c of covs.values()) if (!c.seat.vacant && c.seat.vacantSince) seat.ok();
for (const x of emergencies) {
  // a freeze nobody ended: the Council may also lift it (unfreeze), replace the Holder, or ratify it
  if (x.end) continue;
  const lifted = events.some((e) => e.t >= x.t && ((e.name === "HolderFrozen" && L(e.a.holder) === x.holder && !e.a.frozen) || (e.name === "HolderReplaced" && L(e.a.old) === x.holder)));
  fr.test(lifted || now <= x.until + 60 * DAY, short(x.holder), () => `frozen ${date(x.t)} until ${date(x.until)}, never ended`);
}

// ---- the money each transaction moved, against its events ----
{
  const trTx = new Map<string, Map<string, bigint>>();
  for (const t of transfers) {
    if (!protocol.has(t.from) || protocol.has(t.to)) continue;
    const m = trTx.get(t.tx) ?? trTx.set(t.tx, new Map()).get(t.tx)!;
    m.set(t.to, (m.get(t.to) ?? 0n) + t.value);
  }
  for (const tx of new Set([...evTx.keys(), ...trTx.keys()])) {
    const ev = evTx.get(tx) ?? new Map(), tr = trTx.get(tx) ?? new Map();
    const diffs: string[] = [];
    for (const k of new Set([...ev.keys(), ...tr.keys()])) {
      if ((ev.get(k) ?? 0n) !== (tr.get(k) ?? 0n)) diffs.push(`${k.slice(0, 8)}: events ${usd(ev.get(k) ?? 0n)}, transfers ${usd(tr.get(k) ?? 0n)}`);
    }
    evTr.test(diffs.length === 0, tx.slice(0, 12), () => diffs.join("; "));
  }
}

// ---- the deployment against the configuration it was given (CONFIG: the scenario file) ----
if (process.env.CONFIG) {
  const j = JSON.parse(readFileSync(process.env.CONFIG, "utf8"));
  const sc = j.scenario ?? j;
  const k = sc.contracts;
  const dep = check("deployment-matches-config", "Configuration", "Every value the contracts were deployed with is the one the configuration asked for: each timing and clock, V, the fee split, the edition scale, every country's settings, fees and allowance, and every flow", "The setup screen; src/deploy.ts");
  const want: [string, number, number][] = [
    ["protocol year", k.yearDays * DAY, cfg.year], ["verification grace", k.maxVerificationDelayDays * DAY, cfg.maxDelay],
    ["acceptance", k.acceptanceDays * DAY, cfg.acceptance], ["watchdog", k.watchdogDays * DAY, cfg.watchdog],
    ["shortest auction", k.minAuctionDays * DAY, cfg.minAuction], ["KYC window", k.kycDays * DAY, cfg.kyc],
    ["review window", k.reviewDays * DAY, cfg.review], ["response", k.responseDays * DAY, cfg.response],
    ["panel", k.panelDays * DAY, cfg.panel], ["redraw", k.redrawDays * DAY, cfg.redraw], ["halt after", k.haltAfter, cfg.haltAfter],
    ["power clock", k.powerDays * DAY, cfg.power], ["anchoring clock", k.anchoringDays * DAY, cfg.anchoring],
    ["attestation clock", k.attestationDays * DAY, cfg.attestation], ["extension decision", k.decisionDays * DAY, cfg.decision],
    ["GTA attests from", k.gtaAttestFromDays * DAY, cfg.gtaFrom], ["landowner anchors from", k.guardianAnchorFromDays * DAY, cfg.guardianFrom],
    ["restore window", k.restoreDays * DAY, cfg.restore], ["damage window", k.damageDays * DAY, cfg.damage],
    ["first claim", k.firstClaimDays * DAY, cfg.firstClaim], ["reseat window", k.reseatDays * DAY, cfg.reseat],
    ["accession window", k.accessionDays * DAY, cfg.accession], ["edition scale", k.editionScale, N(editionScale)],
  ];
  for (const [what, x, y] of want) dep.test(x === y, what, () => `configured ${x}, deployed ${y}`);
  dep.test(BigInt(k.baseFee) * USD === defaultV0, "V", () => `configured ${k.baseFee}, deployed ${usd(defaultV0)}`);
  const first = E("bank.FeeSplitSet")[0]?.a;
  dep.test(!!first && N(first.verifierPermille) === k.verifierPermille && N(first.taxPermille) === k.taxPermille && N(first.foundationPermille) === k.foundationPermille,
    "fee split", () => `configured ${k.verifierPermille}/${k.taxPermille}/${k.foundationPermille}, deployed ${first?.verifierPermille}/${first?.taxPermille}/${first?.foundationPermille}`);
  const flowsDep = new Map(E("countries.FlowDefined").map((e) => [N(e.a.flowId), (e.a.steps as unknown[]).map(Number)]));
  for (const f of sc.flows) dep.test(JSON.stringify(flowsDep.get(f.id)) === JSON.stringify(f.steps), `flow ${f.id}`, () => `configured ${f.steps}, deployed ${flowsDep.get(f.id)}`);
  const enabledEv = new Map(E("countries.CountryEnabled").map((e) => [N(e.a.country), e.a]));
  const nHolders = new Map<number, number>(), nVerifiers = new Map<number, number>();
  for (const e of E("admin.HolderAdded")) nHolders.set(N(e.a.country), (nHolders.get(N(e.a.country)) ?? 0) + 1);
  for (const e of E("admin.VerifierAdded")) nVerifiers.set(N(e.a.country), (nVerifiers.get(N(e.a.country)) ?? 0) + 1);
  const cast = check("cast-matches-config", "Configuration", "Each country has the Trust Admins, organisations and verifiers the configuration asked for (and no more than the governance calendar and recruits add)", "The setup screen; the engine's cast");
  for (const c of sc.countries) {
    const e = enabledEv.get(c.code);
    dep.test(!!e && N(e.settings.flowId) === c.flowId && N(e.settings.minTermYears) === c.minTerm && N(e.settings.maxTermYears) === c.maxTerm
      && N(e.settings.listingWindow) === c.listingDays * DAY && N(e.settings.postSaleWindow) === c.postSaleDays * DAY
      && B(e.fees.baseFee) === BigInt(c.baseFee) * USD && B(e.fees.deskRate) === BigInt(c.deskRate) * USD
      && B(e.fees.allowanceFixed) === BigInt(c.allowanceFixed) * USD && B(e.fees.allowancePerHa) === BigInt(c.allowancePerHa) * USD,
      `${c.name} (${c.code})`, () => e ? `deployed ${JSON.stringify({ ...e.settings, ...e.fees }, (_, v) => typeof v === "bigint" ? v.toString() : v)}` : "not enabled");
    const h = nHolders.get(c.code) ?? 0, v = nVerifiers.get(c.code) ?? 0, wantV = c.holders * c.orgsPerHolder * c.verifiersPerOrg;
    cast.test(h >= c.holders && h <= c.holders + 2 && v >= wantV, `${c.name} (${c.code})`, () => `${h} Trust Admins and ${v} verifiers; configured ${c.holders} and ${wantV}`);
  }
}

// ---- failed transactions ----
{
  const c = check("no-unexpected-reverts", "Transactions", "Every transaction an actor sent succeeded, apart from the ones the simulation tries knowing they may fail", "The simulation's actors (Engine.act, Engine.attempt)");
  for (const f of failed) c.test(f.expected, `block ${f.block}`, () => `${f.to}.${f.fn} from ${short(f.from)} at ${date(f.t)}`);
  c.ok();
}

// ---- the balances now ----
{
  const c = check("balances-now", "Money", "Now: the Registry, the Market, the Bank and EcoChallenge each hold exactly what their records say", "The simulator's invariants 1-3");
  const bal = (a: string) => rd("usdt", "balanceOf", [a]).then(B);
  let reg = 0n, market = 0n, bank = 0n, pool = 0n;
  for (const x of reqNow) reg += B(x.verifierShare) + B(x.attestationFee) + B(x.judgmentFee) + B(x.allowance);
  const settling = await Promise.all(tids.map(async (tid) => (await rd("market", "inSettlement", [tid])) ? B((await rd("market", "getSettlement", [tid])).price) : 0n));
  for (const s of settling) market += s;
  for (const x of covNow) { bank += B(x.a.balance); pool += x.pool; }
  const heldFor = [...new Set(E("bank.HolderFeeHeld").map((e) => L(e.a.holder)))];
  for (const h of heldFor) bank += B(await rd("bank", "heldForSuccessor", [h]));
  const [b1, b2, b3, b4] = await Promise.all([bal(addr.registry), bal(addr.market), bal(addr.bank), bal(addr.challenge)]);
  c.test(b1 === reg, "Registry", () => `holds ${usd(b1)}, records ${usd(reg)}`);
  c.test(b2 === market, "Market", () => `holds ${usd(b2)}, records ${usd(market)}`);
  c.test(b3 === bank, "Bank", () => `holds ${usd(b3)}, records ${usd(bank)}`);
  c.test(b4 === pool, "EcoChallenge", () => `holds ${usd(b4)}, records ${usd(pool)}`);
  // and the withheld shares, replayed
  const held = E("bank.HolderFeeHeld").reduce((x, e) => x + B(e.a.amount), 0n) - E("bank.HolderFeeReleased").reduce((x, e) => x + B(e.a.amount), 0n);
  let heldNow = 0n;
  for (const h of heldFor) heldNow += B(await rd("bank", "heldForSuccessor", [h]));
  hfee.test(held === heldNow, "withheld", () => `the events withheld ${usd(held)} net; the Bank holds ${usd(heldNow)} for successors`);
}

// ---- observations (not rules) ----
{
  const cad2 = [...accts.values()];
  observations.term = {
    accounts: cad2.length, twiceAYear: E("bank.Activated").filter((e) => N(e.a.interval) * 2 === cfg.year).length,
    considerationPaid: usd(cad2.reduce((x, a) => x + a.consPaid, 0n)), verifierShareOfPriceOnCompletedTerms: verifierSummary.terms ? (verifierSummary.share / verifierSummary.terms).toFixed(5) : "none",
  };
  const heldEv = E("bank.HolderFeeHeld"), relEv = E("bank.HolderFeeReleased");
  observations.heldForSuccessor = { instalments: heldEv.length, held: usd(heldEv.reduce((x, e) => x + B(e.a.amount), 0n)), released: usd(relEv.reduce((x, e) => x + B(e.a.amount), 0n)) };
  observations.halts = E("challenge.WindowOpened").filter((e) => e.a.halted).length;
  observations.blocks = E("core.CovenantBlocked").length;
  observations.cancellations = E("core.CovenantCancelled").length;
  observations.reseats = E("core.VerifierReplaced").length;
  observations.challengesByOption = Object.fromEntries(["", "W1A", "W1B", "T3A", "T3B", "T3C", "T3D", "T3E"].map((n, i) => [n, E("challenge.ChallengeRaised").filter((e) => N(e.a.option) === i).length]).filter(([n]) => n));
  observations.verdictsApplied = verdicts.length;
}

// =====================================================================================
// 3. The summary
// =====================================================================================

const count = (n: string) => events.filter((e) => e.name === n).length;
const summary = {
  name: NAME, head: N(last), from: events[0]?.t, to: now, editionScale: N(editionScale),
  transactions: txCount, failed: failed.length, unexpectedFailed: failed.filter((f) => !f.expected).length,
  events: events.length,
  counts: Object.fromEntries(["VerificationRequested", "VerificationSubmitted", "CovenantMinted", "Activated", "CovenantVerified", "InstalmentsReleased",
    "ChallengeRaised", "ChallengeDetermined", "ChallengeLapsed", "ChallengeWithdrawn", "SeatVacated", "VerifierReplaced", "CovenantBlocked",
    "CovenantCancelled", "CovenantClosedEarly", "SaleLapsed", "Sold", "RelicMinted", "BoostCommitted", "RewardClaimed", "EditionClosed",
    "ProposalExecuted", "CountryVoteExecuted", "EmergencyFreeze", "AllowanceDrawn", "AccessionLapsed"].map((n) => [n, count(n)])),
  failedBy: Object.entries(failed.reduce((m, f) => { const k = `${f.to}.${f.fn}${f.expected ? " (expected)" : ""}`; m[k] = (m[k] ?? 0) + 1; return m; }, {} as Record<string, number>)),
  observations, configuration: { ...cfg, defaultBaseFee: usd(defaultV0), editionScale: N(editionScale) },
  checks: checks.map((c) => ({ ...c, failures: c.failures.slice(0, 40), failureCount: c.failures.length })),
};
writeFileSync(new URL("audit.json", OUT), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(observations));
for (const c of checks) console.log(`${c.failures.length ? "FAIL" : "ok  "}  ${c.id.padEnd(26)} ${String(c.checked).padStart(6)} checked  ${c.failures.length} failed${c.failures.length ? `   e.g. ${c.failures[0].ref}: ${c.failures[0].detail}` : ""}`);
const failing = checks.filter((c) => c.failures.length).length;
console.log(`${checks.length} checks, ${checks.length - failing} held, ${failing} failed`);
