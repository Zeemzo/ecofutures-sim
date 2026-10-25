// Audits a run from the chain alone: every event since block 0, every failed transaction, and the state now,
// checked against the protocol's rules as V12 has them. Writes sim/out/audit-<name>/{events.jsonl,failed.jsonl,audit.json}.
//
//   RPC=http://127.0.0.1:8545 NAME=live npx tsx scripts/audit.ts
//
// Sources, as each check names them: the Covenant Flow Map v29 (FM, by page), R's "TR3 -- Model 4" (25 Oct 2026, by
// section: placing, records, gems, stones, the supply identity) and its note "Stones and sockets", the V12 decisions
// (contracts/docs/decisions/V12_Decisions.md, D28 for Model 4), the build notes (contracts/docs/build-notes/
// V12_Build_Notes.md), and the contract function that enforces the rule.
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
import { readFileSync, mkdirSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from "node:fs";
import { decodeEventLog, decodeFunctionData, getAddress, getContractAddress, parseAbiItem, zeroAddress, type Abi, type Log } from "viem";
import { loadDeployment, abis, bulk, addr, decodeAt, readBulk, type Key } from "../src/chain";
import code from "../src/bytecode.json";
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
  const scale = await bulk.readContract({ address: dir.editions, abi: abis.editions, functionName: "editionScale" }) as bigint;
  await loadDeployment({ ...dir, usdt, lens: zeroAddress, forwarder: zeroAddress, editionScale: Number(scale), deployedAt: 0 });
}

const DAY = 86400;
const N = (x: unknown) => Number(x);
const B = (x: unknown) => BigInt(x as any);
const L = (a: unknown) => String(a).toLowerCase();
const Z = zeroAddress.toLowerCase();
const ZH = `0x${"0".repeat(64)}`;
const keyOf = new Map<string, Key>();
for (const k of Object.keys(abis) as Key[]) if (addr[k] && L(addr[k]) !== Z) keyOf.set(L(getAddress(addr[k])), k);
// the contracts that hold money: the Registry (fees 1, 2 and 6), EcoDeeds (fees 3-5), the Market (the price in escrow),
// the Bank (the term's instalments) and EcoChallenge (the review pools)
const protocol = new Set((["registry", "deeds", "market", "bank", "challenge"] as Key[]).map((k) => L(getAddress(addr[k]))));

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
const STEP = 1000n; // a long run's busiest 4,000 blocks overflow a JavaScript string
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
  // the merged build names one contract twice: its rulebook's events are `countries`', the rest `editions`'
  const d = decodeAt(l.address, l.data, l.topics as any);
  if (d) events.push({ block: N(l.blockNumber), tx: l.transactionHash!, i: N(l.logIndex), ord: N(l.blockNumber) * 100000 + N(l.logIndex), t: times.get(l.blockNumber!)!, c: d.contract, name: d.name, a: d.args });
}
events.sort((x, y) => x.ord - y.ord);
console.log(`${events.length} protocol events, ${transfers.length} USDT transfers`);

// failed transactions: every block's receipts
type Failed = { block: number; t: number; from: string; to: string; fn: string; expected: boolean };
/** releaseOvercharge calls, by transaction: their target (no event names it, Model 4 §7.5). */
const releaseTx = new Map<string, bigint>();
const failed: Failed[] = [];
let txCount = 0;
const lensCode = String((code as any).code.lens);
const allAbi = Object.values(abis).flat() as Abi;
for (let from = 1n; from <= last; from += 250n) {
  const nums: bigint[] = [];
  for (let n = from; n < from + 250n && n <= last; n++) nums.push(n);
  const blocks = await Promise.all(nums.map((n) => bulk.getBlock({ blockNumber: n, includeTransactions: true })));
  const receipts = await Promise.all(blocks.flatMap((b) => b.transactions.map((tx: any) => bulk.getTransactionReceipt({ hash: tx.hash }))));
  const txs = blocks.flatMap((b) => b.transactions.map((tx: any) => ({ tx, t: N(b.timestamp), block: N(b.number) })));
  txCount += txs.length;
  txs.forEach(({ tx, t, block }, i) => {
    // EcoLens is in no directory: the app deploys it from its own creation code, which finds it here
    if (!tx.to && receipts[i].contractAddress && L(addr.lens) === Z && String(tx.input).startsWith(lensCode)) addr.lens = getAddress(receipts[i].contractAddress!);
    if (receipts[i].status === "success") {
      if (L(tx.to ?? "") === L(addr.overcharge ?? Z)) {
        try {
          const d = decodeFunctionData({ abi: abis.overcharge, data: tx.input });
          if (d.functionName === "releaseOvercharge") releaseTx.set(tx.hash, BigInt((d.args as any)[0]));
        } catch {}
      }
      return;
    }
    let fn = tx.input.slice(0, 10);
    try { fn = decodeFunctionData({ abi: allAbi, data: tx.input }).functionName; } catch {}
    let target = keyOf.get(L(tx.to)) ?? tx.to;
    // the merged build's one contract at two names: a rulebook call is the rulebook's
    if (target === "editions" && L(addr.countries) === L(addr.editions) && abis.countries.some((x) => x.type === "function" && x.name === fn)) target = "countries";
    // the simulation tries these knowing they may fail (Engine.attempt): an extra Council approval or country
    // vote, a panel member who already voted or whose vote came after the decision
    const expected = (target === "governance" && (fn === "approve" || fn === "voteCountry")) || (target === "challenge" && fn === "vote");
    failed.push({ block, t, from: tx.from, to: String(target), fn, expected });
  });
}
console.log(`${txCount} transactions, ${failed.length} failed (${failed.filter((f) => !f.expected).length} unexpected)`);

{
  // line by line: a long run's events (millions, with daily TR3 claims) are past the longest string Node can build
  const fd = openSync(new URL("events.jsonl", OUT), "w");
  events.forEach((e, i) => writeSync(fd, (i ? "\n" : "") + JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v))));
  closeSync(fd);
}
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
// a view the merged build moved to EcoLens is read there (chain.route)
const rd = (k: Key, fn: string, args: unknown[] = []) => readBulk(k, fn, args, at.blockNumber) as Promise<any>;
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
const editionScale = B(await rd("editions", "editionScale"));
const defaultV0 = B(await rd("countries", "defaultBaseFee"));

// EcoFees, in bigint: the same arithmetic the contracts use
const WAD = 10n ** 18n;
const isqrt = (x: bigint) => { if (x === 0n) return 0n; let z = (x + 1n) / 2n, y = x; while (z < y) { y = z; z = (x / z + z) / 2n; } return y; };
// land in square metres (Model 4 §2.8): 1 + sqrt(ha)
const scaleFor = (u: bigint) => WAD + isqrt(((u * WAD) / 10_000n) * WAD);
const reviewFeeOf = (u: bigint, d: bigint) => (d * (scaleFor(u) + WAD / 2n)) / WAD;
// one lever V (Model 4 §11): D = V / 10, and fee 1 = V x (1 + sqrt ha + ha / 30)
const deskOf = (v: bigint) => v / 10n;
const verificationFeeOf = (u: bigint, v: bigint) => (v * scaleFor(u)) / WAD + (v * u) / 300_000n;
// floor(c) = max(J x c x T x 100, c x T x fee / 0.07) (TR3 Model B item 9), at the request's own fees as it paid them
const floorOf = (years: number, twice: boolean, judgment: bigint, fee: bigint) => {
  const reviews = BigInt((twice ? 2 : 1) * (years === 0 ? 1 : years));
  const byJudge = judgment * reviews * 100n, byVerifier = (fee * reviews * 100n) / 7n;
  return byJudge > byVerifier ? byJudge : byVerifier;
};
const poolPermilleOf = (tax: bigint, fnd: bigint) => { const ap = tax - fnd; return ap - ap / 2n; };
const trancheSplit = (tranche: bigint, vp: bigint, tax: bigint, fnd: bigint) => {
  const ap = tax - fnd;
  const gross = (tranche * 1000n) / (1000n - (ap - ap / 2n));
  const v = (gross * vp) / 1000n, f = (gross * fnd) / 1000n, h = (gross * (ap / 2n)) / 1000n;
  return { v, f, h, g: tranche - v - f - h };
};
// the TR3 model (Model 4): 32 editions, edition k holding SCALE x F(min(k, 10)) x F(k) square-metre-years and giving
// 10,000,000 TR3 to the land placed in it, its room counted in TR3
const fib = (n: number) => { let a = 0n, b = 1n; if (n === 0) return 0n; for (let i = 1; i < n; i++) [a, b] = [b, a + b]; return b; };
const LAST_EDITION = 32, LAST_STEP = 32, MAX_EDITIONS = 32;
const PER_EDITION = 10_000_000n * WAD;
const MAX_SUPPLY = BigInt(LAST_EDITION) * PER_EDITION;
const MAX_BASE = 1_000_000n * WAD;
const stepOf = (n: number) => (n < LAST_STEP ? n : LAST_STEP);
const capOf = (n: number) => { const k = stepOf(n); return editionScale * fib(Math.min(k, 10)) * fib(k); };
// a title takes at most 100 x F(k) hectare-years in edition n: 1,000,000 x F(k) square-metre-years
const limitOf = (n: number) => 1_000_000n * fib(stepOf(n));

// =====================================================================================
// The checks, in the order they are reported. Each names the rule and its source.
// =====================================================================================

// Money: the upfront payment
const upCons = check("upfront-conservation", "Money", "What the landowner paid at the request (the verification, attestation and judgment fees, and fees 3-5) = what was paid out of it + what the Registry and EcoDeeds still hold for it; each refund is exactly what was left", "FM p9; TR3 Model B item 16; EcoRegistry._finish; EcoDeeds.refundFees");
const upParts = check("upfront-parts", "Money", "Each part goes out whole, once, to its payee: the verification fee to the request's verifier at the first attestation (flow B: at the mint; or a refusal or abandonment), less a corrected Deed's second signing, which goes to the request's Holder; the judgment fee to the watchdog judges who voted, or else to the verifier; the attestation fee to the attester of the flow's last document", "FM p8-9; EcoRegistry._payShare, _payVerifier, onAttested, _payJudgment, paySecondSigning");
const paperF = check("paper-fees", "Money", "Fees 3-5 are each paid whole, once, at their step: fee 3 to the Holder that records the registered power, fee 4 to the verifier as the agreement to grant is recorded, fee 5 to the verifier at the flow's last attestation. What a request did not use goes back to its landowner, and only once the request has ended; a completed request has used all it was charged", "TR3 Model B item 16 (20 Oct); EcoDeeds.anchorPower, recordDocument, attest, refundFees");
const forf = check("stale-forfeit", "Money", "A sale called off for a failed or timed-out identity check refunds the winner 99% of its price and sends the 1% (rounded down) to the covenant's review pool, in the same transaction", "TR3 Model B item 3 (20 Oct); EcoMarket.cancelStaleSale; EcoBank.forfeitToPool");
// Money: the sale and the term
const saleCons = check("sale-conservation", "Money", "Sale price = review pool + every instalment released + payouts to the patron + an End Date's held payout + balance still held", "FM p9; EcoBank");
const bankRep = check("bank-replay", "Money", "Each account replayed from its events (balance, instalments released, the instalment, holds) is the account the Bank holds now", "EcoBank");
const pool1 = check("pool-share", "Money", "The review pool is the configured share of the sale (half the tax after the Foundation's: 1% in production), sent to EcoChallenge at the finalisation", "FM p9; EcoFees.reviewPool; EcoBank.openAccount");
const split4 = check("instalment-split", "Money", "Each release splits the whole instalment four ways on its gross-equivalent, at the split in force at the covenant's activation: verifier, Foundation and Holder their permille, the landowner the residual, less a confirmed set-off", "FM v29 Money; TR3 Model B item 9 (90/7/1/1); EcoBank._distribute; EcoFees.trancheSplit");
const consC = check("end-date-held", "Money", "At the End Date every instalment left is paid: to the patron, the EFT's owner, whole, when a breach or Deed hold stands then; otherwise released as usual, four ways. No consideration is paid first (item 9)", "FM v29 P7; TR3 Model B item 9 (FINAL); EcoBank.closeAccount");
const relC = check("release-schedule", "Money", "Instalments are released only as verifications cover them, and then all that are covered (up to the term's last); never while a hold is set (breach, vacancy, Deed, halt, accession, Council)", "FM p9, P7; EcoBank._releaseTo, setHold");
const vshare = check("verifier-share", "Money", "Over a completed term, the verifier earns its permille, at the covenant's own split, of the gross-equivalent of the price after the pool: (price - pool) x 7 / 99 in production, within rounding", "FM v29 Money; EcoFees.trancheSplit");
const hfee = check("holder-fee", "Money", "The Holder's share goes to the covenant's Holder fixed at the mint, along its succession line (never a reseated verifier's Holder); it is withheld exactly when that Holder is removed or frozen, and released only to its successor (or itself once unfrozen)", "D7; FM p19; EcoBank._distribute, releaseHeldHolderFees; Core.holderOf");
const poolC = check("pool-conservation", "Money", "A review pool's funding = what it paid out + what it still holds", "FM p17; EcoChallenge");
const winFee = check("window-fee", "Money", "An attested review window that covered a new interval pays its attester one act's fee (the pool / the term's acts) when it settles; an unattested, off-schedule or forfeited (3A upheld) window pays nothing", "FM p17; EcoChallenge._settle; build notes (off-schedule windows carry no fee)");
const chFee = check("challenge-fee-split", "Money", "A decided term challenge is paid one act's fee: 40% shared equally by the judges who voted, and when upheld the other 60% to the challenger; a lapse pays the judges who voted their 40%; a withdrawal pays nothing. A watchdog challenge pays its judges the judgment fee, the first voter the remainder; with no voter it stays for the verifier", "FM p15-17; EcoChallenge._payChallenge, _close; EcoRegistry._payJudgment");
const sweep = check("pool-sweep", "Money", "What a pool still holds after the End Date goes, whole, to the landowner (or to the EFT's owner when the covenant was cancelled in its term), and only after it; a covenant that never sold (closed unsold, lapsed, or cancelled before its sale) holds only forfeits, which go to the landowner", "EcoChallenge.sweepReviewPool; TR3 Model B item 3");
const evTr = check("events-match-transfers", "Money", "In every transaction, what the payment events say each party received = the USDT the protocol (Registry, EcoDeeds, Market, Bank, EcoChallenge) actually transferred to it", "Every payment event");
// TR3
const trSplit = check("tr3-split", "TR3", "Of everything a covenant has released: the patron's 90% and the landowner's 10% (a referrer taking 30% of it) are what has been claimed plus what is claimable; and the claim events add up to what Tree says was paid", "Tree._due; GUARDIAN_PERCENT, REFERRAL_PERCENT_OF_GUARDIAN");
const trRef = check("tr3-referrer", "TR3", "A referrer who is a GTA, or the land's own verifier, when the claim is made takes nothing; its share stays with the landowner. Anyone else is paid", "Tree._referrerEligible (R, 18 Oct, R4: anyone except a Council member or whoever scores that land)");
const trCap = check("tr3-cap", "TR3", "No allocation is above 1,000,000 TR3, no land's allocation with every stone committed to it above 1,000,000, and no covenant's land TR3 (released less its stones') above its allocation", "Model 4 §2.6, §7.2; EcoEditions._place; EcoOvercharge.LAND_CAP, _commitment");
const rsClaim = check("resale-claims", "Resale", "The patron's TR3 is minted only by a patron claim, to the EFT's owner at that moment, never in a transfer; a guardian claim mints the patron nothing", "R, 14 Oct, Part 1 items 1-3; Tree.claimPatron, claimGuardian");
const rsOrd = check("resale-orders", "Resale", "Every resale takes a live order at its price: a listing or an offer made at the EFT's order counter in force, an offer before its expiry", "R, 14 Oct, Part 1 items 4 and 6; EcoFuturesToken.buy, acceptOffer");
const trSup = check("tr3-supply", "TR3", "TR3's supply = everything the claim events minted = minted to patrons + guardians + referrers", "Tree");
const plc = check("placement-in-turn", "Editions", "A sign-up reserves nothing; the first verification sets the land's turn for good, the later of 81 days after its sign-up and its watchdog's close. Lands are placed only once their turn has come, in turn (the earlier turn, then the lower request id), the passed-over lands an open or earlier edition now takes first: each in the OPEN edition, within its title limit, its allocation N = H x r_k fixed then -- straddling once into the next edition when it needs more than the room left -- or, over the title limit, passed over to the first edition that takes it; after Edition 32, only into returned room", "Model 4 §3.1-3.5, §3.9; EcoEditions.queue, _placeDue, _place");
const cls = check("edition-open", "Editions", "Editions open one at a time, each with 10,000,000 TR3 of room: the next exactly when the OPEN one's room runs out (filled, or straddled); Edition 32 filling makes the ladder full. No edition closes on time", "Model 4 §2, §3.3; EcoEditions._filled, _open");
const edState = check("edition-state", "Editions", "The editions replayed from the events end where EcoEditions is now: each edition's room and TR3 placed, when it opened, the OPEN edition, whether the ladder is full, every request's place and allocation, and the TR3 placed and not yet active", "EcoEditions.rawEdition, current, full, reservationOf, placedOpen");
const plRel = check("place-released", "Editions", "A place is released exactly when its request ends before its activation: its allocation goes at once to the open edition's room; a land released while it waits is never placed; a sold land is never released", "Model 4 §3.7; EcoEditions.release; EcoRegistry._finish");
const e4 = check("room-returned", "Editions", "Exactly five things return TR3 to room, each to the OPEN edition (Edition 32's after the ladder is full) in the transaction that frees it: a released place, an early end's or an acquired part's unstreamed allocation, TR3 blocked at an End-Date hold not lifted, a drop with no weight anywhere, and a gem pair's excess over its land's mint", "Model 4 §3.8; EcoEditions.returnRoom, _toRoom");
const asg = check("edition-assignment", "Editions", "Each covenant activates in the edition it was placed in, with the allocation fixed at its placement", "Model 4 §3.2; EcoEditions.sell; Tree.assignEdition");
const qAssign = check("verifier-assigned", "Requests", "A request no verifier claimed is assigned by an active Holder of its country, to one of its own verifiers, only after 30 days unclaimed (and any first claim over); by the Council only after 60; no request is ever ended for want of a verifier", "R, 13 Oct, section 4.1-4.3; EcoParties.assignVerifier, reassignVerifier")
const qReject = check("rejection", "Requests", "A rejection is filed by the claiming verifier inside its claim, with a reason (land not found, no valid title, no access given) and evidence; it ends the request only after the watchdog has closed with no challenge open, the verification fee to the verifier and the rest refunded; an upheld 1A reopens it", "R, 13 Oct, section 4.4; EcoParties.rejectRequest; EcoRegistry.cancelRequest")
const rew = check("tr3-reward", "TR3", "Each covenant's stream starts with the allocation fixed at its placement, at the covenant's score", "Model 4 §3.2, §4.1; Tree.startReward");
const relScore = check("tr3-release-score", "TR3", "TR3 streams forward (C9): outside a verification it settles at the score in force, never past the horizon the last verification underwrote and never while stopped; a verification settles what it underwrote at the old score, then the rest -- late days -- at the score it records; what a stop held is released at the lower of the score that opened its interval and the one named now; the shortfall drops to the records: released = floor(span x score / 100)", "R, 18-19 Oct, C9; Model 4 §4.2, §4.9; Tree._settle, _sync, pass");
const hzn = check("tr3-horizon", "TR3", "Each verification underwrites the interval after it: the stream may run to the earlier of one interval after it and the next scheduled due date (the term's end after the last); at the activation, one interval after the verification before the sale, never past the first due date.", "R, 18-19 Oct, C9; Tree.startReward, pass, _nextHorizon");
const strCons = check("tr3-stream-conservation", "TR3", "Every allocation is accounted exactly: what the land released + its shortfall dropped to the records + what went back to room (an early end, an End-Date hold not lifted, an acquired part) = the allocation once the stream ends, and never more before", "Model 4 §4; Tree._settle, _end, endPart");
const late = check("late-verification", "TR3", `A re-verification is late only past its due date + the grace (${days(cfg.maxDelay)}): it records when it fell overdue, and nothing of its TR3 is forfeited -- only the score's shortfall drops (R, 18 Oct, C9)`, "D3; Core.verify; Tree._settle");
const brk = check("tr3-supply-identity", "TR3", "Every TR3 of the 320,000,000, at every block: in an edition not yet open, room, placed and not yet active, unstreamed, owed, minted, held by the records and gems, or committed to an overcharge -- each part as the events give it, summing exactly. Nothing is burned", "Model 4 §10; EcoLens.supply");
const recC = check("records", "Records", "One record per land from its activation (a mirror of EcoOvercharge, to the wei): its weight m x j (m = A' x S / (100 T), j = min(releases + 1, n), n = T / 3), set at activation and at every Loop Anchor from the score just named, 0 under a breach, Deed or partition hold, after a pause (only once the verification is overdue) and after the last interval; every drop -- a land's shortfall, a shattered record -- shared at once by one index over the total weight, or back to room when no record weighs", "Model 4 §5, §6.1-6.3; EcoOvercharge.born, settle, anchor, hold, lift, pause, _drop");
const pairC = check("gem-pairs", "Records", "A pair at the Loop Anchor completing each 3 years (releases due together are one pair), the last at the End Date: x = min(the record's balance, what its land minted since its last pair), the Patron's x - floor(x / 2) to the EFT's owner and the Guardian's floor(x / 2) to the payee of record, the rest back to room; an early end or an End-Date hold not lifted shatters the record instead, its balance dropping to the others, and an acquired part shatters that share", "Model 4 §6.4-6.7; EcoOvercharge._pair, end, cut");
const gemC = check("gems", "Gems", "Every gem's edition, half, land and carats replay to what EcoOvercharge holds now: minted at a pair, its carats moved only by setting it into land, what comes back to it, and fusing -- two or more of one edition, the caller's, none with an open commitment, into the first, never above 1,000,000 carats", "Model 4 §6.8, §8; EcoOvercharge._mintGem, transmute, _back");
const stoneC = check("stones", "Stones", "Stones are set only into a new land (activated, in its first interval, under no hold) by its EFT's owner, at most 21, earliest edition first: each commits C = min(its carats, floor(M x room left), 1,000,000 - the allocation - every commitment), M = max(1, sqrt(r_stone / r_land)), using ceil(C / M) of the room (the allocation); what they commit is minted with the land's stream at its score or comes back to the stones -- never more -- and it all has, once the land's TR3 ends or the overcharge is released", "Model 4 §7; Stones and sockets; EcoOvercharge.setStones, accrue, _confirm, _returnStones, releaseOvercharge");
const land = check("land-at-request", "Editions", "Every request's land is at least 100 m2, and its square-metre-years within Edition 32's title limit (100 x F(32) ha-years)", "Model 4 §2.5, §2.8; EcoEditions.reserve");
const term = check("term-at-request", "Editions", "Every request's term is within its country's range and one of 3, 6 ... 99 years", "Model 4 §2.8; EcoCountries.requestTerms; EcoEditions.reserve");
// Timing and the term
const wd = check("watchdog", "Challenges", `A watchdog challenge (W1A, W1B) is raised against the request's current verification, within the watchdog window after it (${days(cfg.watchdog)})`, "FM p15; EcoRegistry.challengeTarget");
const setOffC = check("set-off", "Money", "An enforcement cost is filed by the covenant's Holder only while it is held for a breach, never above the landowner's share of what is still held; a cure at least 14 days after the filing confirms it, any other end voids it", "FM v29 P7; decisions of 17 Oct; TR3 Model B item 9; EcoParties.fileEnforcementCost; EcoBank.fileSetOff, _resolveSetOff");
const second = check("second-signing", "Money", "A second signing is drawn only for a correction the verifier recorded, once, at most half the unpaid verification fee", "FM v29 P2; decisions of 17 Oct; EcoDeeds.drawSecondSigning");
const setOffs = new Map<bigint, number>();
const cool = check("challenge-cooldown", "Challenges", "After a challenge is withdrawn or lapses, its challenger's organisation (a landowner: itself) raises on that request or covenant again only after a review window", "decisions of 17 Oct; EcoChallenge.raise, _close, _coolKey");
const lastClose = new Map<string, number>();
const coolKey = (who: string, kind: number, subject: bigint) => `${verifiers.get(who)?.org ?? 0n}|${kind}|${subject}`;
const winOpt = check("window-options", "Challenges", "3A and 3B are raised only inside an open review window and not by its attester; 3E only by the landowner of a covenant blocked for a breach; every term option only in the term (after the End Date, 3A and 3B still in the last window, 3E on a breach block); one undecided challenge per subject", "FM p15-17; build notes (rules of ours); EcoChallenge.raise");
const raiser = check("challenge-raiser", "Challenges", "Every challenger but 3E's is a verifier of the country from another organisation than the land's verifier (under the same Holder or not), and never that verifier or the landowner; each challenge names the defendant its option names (the verifier; the Holder for 3A; the landowner for 3D)", "FM p15; EcoChallenge._independentVerifier");
const panelC = check("panel-independence", "Challenges", "Three judges: the country's eligible Trust Admins first, GTAs for the seats too few remain for; never the landowner, the covenant's Holder or either party's organisation's Holder; only seated judges vote", "FM p15; EcoChallenge._draw, _eligible; PanelLib");
const dl = check("challenge-deadline", "Challenges", `Every challenge ends within one deadline from its raise (response + panel + redraw: ${days(deadline)}): decided before it, lapsed only at or after it`, "FM p15; EcoChallenge.deadlineOf");
const chEnd = check("challenges-end", "Challenges", "No challenge stays undecided long past its deadline", "FM p15");
const cons = check("challenge-consequences", "Challenges", "Each verdict has exactly its option's consequences, in the same transaction. Dismissed: the challenger is flagged (never the landowner on 3E) and nothing changes. Upheld: W1A reopens the request and bars the verifier; W1B fails it; 3A blocks the covenant (Deed hold) and flags the last attester, forfeiting an unsettled window's fee; 3B vacates the seat (the challenger's first claim) and holds the TR3 for rescoring; 3C sets a re-verification due; 3D blocks for a breach; 3E lifts a breach block. W1A, W1B, 3B and 3E flag the verifier", "FM p15-17; EcoChallenge._decide; Core.applyVerdict; EcoRegistry.onChallengeResolved");
const sched = check("verification-schedule", "Term", "Each re-verification is by the seated verifier and covers every interval begun since the term started (up to the last); one that covers none is a cure of a breach block, the re-verification 3C called for, or a newly seated verifier's first; none while a challenge on the covenant is undecided, nor before the last review window has closed", "Core.verify; EcoChallenge.openWindow; EcoParties.onVerification");
const blk = check("block-holds", "Term", "A seated verifier blocks at most twice per review window (partition and 3D blocks aside); a block in the term holds the instalments (breach or Deed), its lift releases them; now, every covenant's holds match its block and its seat", "FM P4, P7; Core.blockCovenant, _block, _unblock; EcoParties._vacate");
const termEnd = check("term-closed", "Term", "A term closes only after its last re-verification, unless a breach, Deed or partition block stands then (C9); a covenant whose term and grace have long passed has had its End Date accounted: nothing left in its account, every instalment released", "FM p9; R, 18 Oct, C9; Core.closeTerm; EcoBank.closeAccount");
const tclk = check("term-clocks", "Term", "3A: a covenant closes early only after its restore window; 3C: the re-verification falls due at the verdict, or at the close of a review window still open (then the usual grace), unless the scheduled one comes within a review window of it; a winner's identity check is called off for time only after the KYC window; a buyer of the land's accession lapses only after the accession window", "FM p4-5, p8, P6; Core.applyVerdict, closeEarly; EcoMarket.cancelStaleSale; EcoParties.lapseAccession");
const fr = check("emergency-freeze", "Governance", `An emergency freeze lasts ${days(cfg.emergency)}: ratified by the Council by then, lifted by the multisig, or ended after it; never again on the same Trust Admin within ${days(cfg.cooldown)} of its end`, "FM p4, p19; Governance.emergencyFreeze");
const seat = check("seat-refilled", "Term", "A vacated seat is filled again", "FM P4");
const rst = check("reseat-rule", "Term", "A seat passes only when it is vacant, or its verifier is out of standing or late beyond the grace: to the 3B challenger inside its first claim, or to a nominee of the covenant's Holder (after the first claim, within the reseat window) or of the Council; the new verifier is of the country, takes work, is not the one replaced, the one that lost the seat or the landowner, and is either of the replaced verifier's organisation or was never in it", "FM P4; EcoParties.nominateVerifier, acceptSeat, claimSeat, _requireSuccessor; D7");
const firstClaim = check("first-claim", "Requests", "A request reopened by W1A is claimed only by the challenger during its first claim, and never by the verifier it was removed from; every claim is by a verifier of the request's country that takes work, whose Holder the event names and is not frozen", "FM p4, p15; EcoRegistry.claim, onChallengeResolved");
// the paper flow
const paper = check("deeds-clocks", "Paper", "Before the sale each document is recorded, and attested, inside its clock (anchoring, attestation: from when the step became current, with the extensions granted, silence counting as granted after the decision window); a request lapses only after its clock; the landowner anchors only from its day", "FM p12-13; D8; EcoDeeds._deadline, recordDocument, attest, lapse");
const gtaA = check("gta-attest-from", "Paper", `Every attester is independent: a verifier of the country from another organisation than the land's verifier, a Trust Admin of the country other than the land's, or a GTA -- a document from ${days(cfg.gtaFrom)} after it was recorded, a review window from seven tenths of it`, "FM p12, p17; EcoDeeds._requireAttester; EcoChallenge._eligibleAttester");
// the configuration, enforced
const fees = check("upfront-fees", "Configuration", "Each request's upfront is the fee model's for its land and its country's fees at the time, V never below the Council's Vmin: V x (1 + sqrt ha + ha / 30), V, (V / 10) x (1.5 + sqrt ha); and fees 3-5: P only where the flow has a power, A only where it has an agreement to grant, C0 + C1 x ha", "FM p9; Model 4 §11; TR3 Model B item 16; EcoCountries.quote");
const floorC = check("price-floor", "Configuration", "No auction starts below the covenant's yearly floor at its request's own fees, max(J x T x 100, T x fee / 0.07)", "TR3 Model B item 9 (FINAL); EcoMarket.listForAuction; EcoEditions.floorOf; EcoFees.priceFloor");
const termC = check("term-length", "Configuration", `Each term runs exactly its Stated Period: years x the protocol year (${days(cfg.year)})`, "Core.activate");
const cad = check("instalment-schedule", "Configuration", "Each sale is paid twice a year exactly when its price reaches floor(2) at its request's fees, else yearly: interval = year / releases a year, years x that many instalments after the first, the first taking the division's remainder", "TR3 Model B item 9 (FINAL); EcoBank._openAccount");
const rev = check("review-window", "Configuration", `Every review window runs exactly the configured review (${days(cfg.review)})`, "EcoChallenge.openWindow");
const halt = check("halt-threshold", "Configuration", `The unattested run counts each window that settles unattested and resets at an attestation; a window opens halted exactly when it reaches the threshold (${cfg.haltAfter})`, "FM p17; EcoChallenge.openWindow, _settle, attestVerification");
const auc = check("auction-length", "Configuration", `No auction is shorter than the configured minimum (${days(cfg.minAuction)}), and each closes inside its listing window`, "EcoMarket.listForAuction");
const acc = check("acceptance", "Configuration", `A verification is submitted by the claiming verifier within the acceptance window of its claim (${days(cfg.acceptance)})`, "EcoRegistry.submitVerification");
const wdw = check("watchdog-wait", "Configuration", `A request enters its paper flow only once its land is placed and its watchdog window has passed (${days(cfg.watchdog)}); a land placed more than a protocol year after its verification, only after its verifier has re-verified it`, "Model 4 §3.1; EcoRegistry.enterFlow, _context, _verifying");
const lst = check("listing-window", "Configuration", "Each request takes its country's listing and post-sale windows at the request; it closes unsold only after the listing window", "FM p8; EcoRegistry.requestVerification, closeUnsold");
const pst = check("post-sale-window", "Configuration", "A path B sale completes inside its post-sale window, and lapses only after it", "FM p5; EcoRegistry.lapseSale; EcoDeeds.attest");
const flw = check("flow-order", "Configuration", "Every request walks its country's flow, step by step, in order", "EcoCountries flows; FlowCode");

// ---- the chronological replay: the protocol's state at each event, and every check that needs it ----
type Fees = { baseFee: bigint; powerFee: bigint; agreementFee: bigint; registrationFixed: bigint; registrationPerHa: bigint };
type Settings = { flowId: number; min: number; max: number; listing: number; postSale: number };
const countries = new Map<number, { settings: Settings; fees: Fees }>();
const flows = new Map<number, number[]>();
let defaultV = defaultV0;
/** Vmin: the default V at the initializer, then the Council's (SET_MIN_BASE_FEE); no V below it (Model 4 §11). */
let minV = -1n;
const vOf = (f: Fees) => { const v = f.baseFee !== 0n ? f.baseFee : defaultV; return v < minV ? minV : v; };
let split = { wallet: Z, v: 0n, tax: 0n, f: 0n };
const splitChanges: number[] = [];

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
  vf: bigint; af: bigint; jf: bigint; paper: bigint;
  /** Fees 1 and 2 as paid at the request: its price floor for good (item 9). */
  vf0: bigint; jf0: bigint; pf: bigint; gf: bigint; rf: bigint;
  left: { share: bigint; att: bigint; jud: bigint; p: bigint; g: bigint; r: bigint };
  /** Fees 3-5 as the model gives them for this request, checked against EcoDeeds' FeesHeld. */
  wantPaper: [bigint, bigint, bigint];
  shareTaken: boolean; judgmentSettled: boolean; status: number; verifier: string; claimedAt: number; verifiedAt: number;
  cursor: number; stepAt: number; ext: Map<number, Ext>; before?: { stepAt: number; cursor: number; ext: Map<number, Ext> };
  saleAt: number; listing: number; postSale: number; firstClaimant: string; firstClaimUntil: number; barred: string;
  recordedAt: Map<number, number>; tokenId?: bigint; ended: boolean; openedAt: number; rejected: boolean; assignedFrom?: number;
  correction?: { index: number; by: string; drawn: boolean };
};
const reqs = new Map<number, Req>();
type Seat = { vacant: boolean; removed: string; firstClaimant: string; firstClaimUntil: number; vacantSince: number };
type Cov = {
  tid: bigint; rid: number; guardian: string; verifier: string; country: number; units: bigint; term: number; score: number;
  holder0: string; status: number; blockReason: number; termStart: number; termEnd: number; interval: number; total: number;
  through: number; verifications: number; blockWindow: number; blocksInWindow: number; reverifyPending: boolean;
  newSeatPending: boolean; seat: Seat; nominee: string; nominatedBy: string; restoreBy: number; owner: string;
  saleApprovedAt: number; settledAt: number; accessionPending: boolean; openChallenge: bigint;
  /** A 3C verdict's re-check date (and the one before it, in the transaction that set it), and the challenge time
   *  since the last verification that fell after the due date (decision 8). */
  reverifyBy: number; reverifyOld: number; reverifyTx: string; barred: number; graceFrom: number; graceOld: number; graceTx: string;
};
const covs = new Map<bigint, Cov>();
type Acct = { price: bigint; pool: bigint; balance: bigint; per: bigint; total: number; released: number; holds: number;
  shareToPatron: boolean; first: bigint; verifierPaid: bigint; splitAt: number; closedHeld: bigint; split0: typeof split };
const accts = new Map<bigint, Acct>();
/** A covenant's stream, replayed (Tree): its allocation (less acquired parts), what the land released, what it dropped
 *  to the records, what went back to room at its end, and where it stands (C9). */
type Stream = { alloc: bigint; edition: number; score: number; rescore: boolean; ended: boolean; stream: bigint; credits: bigint; toRoom: bigint;
  /** C9: where the stream stands (the last release's end), how far the last verification underwrote it, and whether it is
   *  stopped (a block or an upheld 3B). */
  mark: number; horizon: number; held: boolean;
  /** What acquired parts cut from the allocation (Tree.endPart), back to room. */
  cut: bigint;
  /** Whether a breach, Deed or partition hold stood at the End Date. */
  heldAtEnd: boolean;
  /** The intervals Loop Anchors have confirmed, and what its stones have released. */
  anchored: number; overcharge: bigint };
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

// ---- TR3 Model 4, replayed to the wei: the editions and the places (§3), the records (§5-6), the gems (§8) and the
// stones set into land (§7) ----
type Place = { rid: number; units: bigint; years: number; ly: bigint; signedAt: number; turn: number;
  /** 0 not yet verified; 1 its turn is its watchdog's close; 2 its sign-up's day 81; 3 passed over, in a list */
  stream: number;
  edition: number; rest: number; alloc: bigint; placedAt: number; stale: boolean; sold: boolean; released: boolean };
const places = new Map<number, Place>();
const NE = MAX_EDITIONS + 2;
/** Each edition's room (TR3 not yet given to land), the TR3 placed in it, and when it opened. */
const edRoom: bigint[] = Array(NE).fill(0n), edPlaced: bigint[] = Array(NE).fill(0n), edOpened: number[] = Array(NE).fill(0);
/** The OPEN edition, whether Edition 32 has filled, and the TR3 allocated to land placed and not yet active. */
let ed = 0, ladderFull = false, placedOpenEv = 0n;
/** Each edition's passed-over lands, first in, first out. */
const lists = new Map<number, number[]>();
const TURN_DELAY = 81 * DAY;
const RS = { RELEASED: 0, EARLY_END: 1, END_HOLD: 2, NO_WEIGHT: 3, PAIR_CAP: 4 };
const turnBefore = (x: Place, y: Place) => x.turn < y.turn || (x.turn === y.turn && x.rid < y.rid);
/** The land whose turn is next (Model 4 §3.2-3.5): the passed-over lands an open or earlier edition now takes first,
 *  earliest turn first (a land released while it waits drops out); then the earliest turn of every verified land not yet
 *  placed whose turn has come, ties by request id; none after Edition 32 while no room is there. */
const nextInTurn = (t: number, open = ed): Place | undefined => {
  if (ladderFull && edRoom[LAST_EDITION] === 0n) return undefined;
  let best: Place | undefined;
  for (let e = 1; e <= open; e++) {
    const l = lists.get(e);
    while (l && l.length && places.get(l[0])!.released) l.shift();
    if (l && l.length) { const p = places.get(l[0])!; if (!best || turnBefore(p, best)) best = p; }
  }
  if (best) return best;
  for (const p of places.values()) if ((p.stream === 1 || p.stream === 2) && p.edition === 0 && !p.released && p.turn <= t && (!best || turnBefore(p, best))) best = p;
  return best;
};

/** A land's record (EcoOvercharge.Record): its weight, its allocation A', its balance settled to `index`, and what its
 *  land minted since its last pair. */
type Rec = { edition: number; state: number; n: number; releases: number; term: number; weight: bigint; alloc: bigint; balance: bigint; minted: bigint; index: bigint;
  /** an acquired part handled in this transaction, and the balance it shattered */
  cutDone: string; cutAmount?: bigint };
const recs = new Map<bigint, Rec>();
const RSt = { NONE: 0, ASLEEP: 1, HELD: 2, PAUSED: 3, CLOSED: 4 };
const INDEX = 10n ** 36n;
/** The total weight, the drop index (TR3 per unit of weight x 10^36), all the records and gems hold (with the index's
 *  dust), and the stones' TR3 committed to land and not yet minted or returned. */
let totalW = 0n, dropIdx = 0n, poolEv = 0n, committedEv = 0n;
const settleRec = (r: Rec) => { if (r.weight !== 0n) r.balance += (r.weight * (dropIdx - r.index)) / INDEX; r.index = dropIdx; };
/** w = m x j: m = floor(A' x S / (100 T)), j = min(releases made + 1, n). */
const weightOf = (r: Rec, score: number) => {
  const m = (r.alloc * BigInt(score)) / (100n * BigInt(r.term));
  const j = Math.min(r.releases + 1, r.n);
  return m * BigInt(j);
};
/** The next of EcoOvercharge's events for this land after `e`, in its transaction. */
const nextFor = (e: Ev, tid: bigint) => (byTx.get(e.tx) ?? []).find((x) => x.ord > e.ord && x.c === "overcharge" && x.a.land !== undefined && B(x.a.land) === tid)?.name;

/** The gems (ERC-721): edition, half (1 Patron, 2 Guardian, 3 fused), release, land, carats, and the lands it is set in
 *  with something unpaid. */
type Gem = { edition: number; half: number; release: number; land: bigint; balance: bigint; open: number; burned?: boolean };
const gemsL = new Map<bigint, Gem>(), gemOwner = new Map<bigint, string>();
const CARAT_CAP = 1_000_000n * WAD;
/** A land's sockets (EcoOvercharge.Land) and its stones. */
type Stone = { set: boolean; unpaid: bigint; instalment: bigint };
type LandS = { room: bigint; roomUsed: bigint; committed: bigint; allocation: bigint; instalment: bigint; left: bigint; carry: bigint;
  from: number; to: number; mark: number; ids: bigint[]; st: Map<bigint, Stone> };
const landsS = new Map<bigint, LandS>();
const STOPS = Holds.BREACH | Holds.DEED | Holds.PARTITION | Holds.VACANCY;
/** What each transaction's Carried events should be, by `tx|gem|amount`, and what they were. */
const carriedWant = new Map<string, number>(), carriedEv = new Map<string, number>();
const back = (tx: string, id: bigint, amount: bigint, s: Stone) => {
  const g = gemsL.get(id);
  if (amount !== 0n) {
    if (g) g.balance += amount;
    const k = `${tx}|${id}|${amount}`;
    carriedWant.set(k, (carriedWant.get(k) ?? 0) + 1);
  }
  if (g && s.unpaid === 0n && s.instalment === 0n && g.open !== 0) g.open -= 1;
};
/** EcoOvercharge.accrue: the instalments of the interval running accrue with the land's stream to `to`, at its score. */
const accrue = (tid: bigint, to: number, score: number) => {
  const L_ = landsS.get(tid);
  if (!L_ || L_.left === 0n) return 0n;
  const t = Math.min(to, L_.to);
  if (t <= L_.mark) return 0n;
  const p = t === L_.to ? L_.left : (L_.left * BigInt(t - L_.mark)) / BigInt(L_.to - L_.mark);
  L_.left -= p; L_.mark = t;
  const minted = (p * BigInt(score)) / 100n;
  L_.carry += p - minted;
  committedEv -= minted;
  return minted;
};
/** EcoOvercharge._confirm: the interval confirmed, what the score withheld returns to each stone. */
const confirm = (tid: bigint, tx: string) => {
  const L_ = landsS.get(tid);
  if (!L_ || L_.instalment === 0n) return;
  const inst = L_.instalment, carry = L_.carry, left = L_.left;
  L_.instalment = 0n; L_.left = 0n; L_.carry = 0n;
  let seen = 0n, gaveC = 0n, gaveL = 0n;
  for (const id of L_.ids) {
    const s = L_.st.get(id)!, si = s.instalment;
    if (si === 0n) continue;
    s.instalment = 0n; seen += si;
    const c = seen === inst ? carry - gaveC : (carry * si) / inst, l = seen === inst ? left - gaveL : (left * si) / inst;
    gaveC += c; gaveL += l;
    s.unpaid += l;
    back(tx, id, c, s);
  }
  committedEv -= carry; poolEv += carry;
};
/** EcoOvercharge._openInstalments: each stone's share of the interval [from, to) of the term still to run. */
const openInstalments = (tid: bigint, from: number, to: number, termEnd: number) => {
  const L_ = landsS.get(tid);
  if (!L_ || L_.ids.length === 0) return;
  const lastInterval = to >= termEnd;
  let total = 0n;
  for (const id of L_.ids) {
    const s = L_.st.get(id)!, u = s.unpaid;
    if (u === 0n) continue;
    const pay = lastInterval ? u : (u * BigInt(to - from)) / BigInt(termEnd - from);
    s.unpaid = u - pay; s.instalment = pay; total += pay;
  }
  Object.assign(L_, { instalment: total, left: total, carry: 0n, from, to, mark: from });
};
/** EcoOvercharge._returnStones: `pm` per thousand of what each stone has not been paid goes back to it. */
const returnStones = (tid: bigint, pm: bigint, tx: string) => {
  const L_ = landsS.get(tid);
  if (!L_ || L_.ids.length === 0) return;
  const inst = L_.instalment, dl = (L_.left * pm) / 1000n, dc = (L_.carry * pm) / 1000n;
  L_.left -= dl; L_.carry -= dc;
  const pend = dl + dc;
  let seen = 0n, gave = 0n, total = 0n;
  for (const id of L_.ids) {
    const s = L_.st.get(id)!, du = (s.unpaid * pm) / 1000n;
    s.unpaid -= du;
    let dp = 0n;
    if (s.instalment !== 0n) {
      seen += s.instalment;
      dp = seen === inst ? pend - gave : (pend * s.instalment) / inst;
      gave += dp;
      if (pm === 1000n) s.instalment = 0n;
    }
    total += du + dp;
    back(tx, id, du + dp, s);
  }
  if (pm === 1000n) L_.instalment = 0n;
  committedEv -= total; poolEv += total;
};
/** EcoOvercharge.cut: an acquired part of the land -- that share of the stones' unpaid, of the room, of the record's
 *  balance (which drops) and of its allocation. */
const cutRecord = (tid: bigint, r: Rec, pm: bigint, tx: string) => {
  returnStones(tid, pm, tx);
  const L_ = landsS.get(tid);
  if (L_) { L_.room -= (L_.room * pm) / 1000n; L_.roomUsed = (L_.roomUsed * (1000n - pm) + 999n) / 1000n; }
  settleRec(r);
  const b = (r.balance * pm) / 1000n;
  r.balance -= b; r.alloc -= (r.alloc * pm) / 1000n;
  r.cutAmount = b; r.cutDone = tx;
};
const owners = new Map<bigint, string>();
// the resale market: each EFT's order counter, its listing and its offers, as their events recorded them
const orderCounter = new Map<bigint, number>();
const resaleListings = new Map<bigint, { counter: number; price: bigint }>();
const resaleOffers = new Map<string, { counter: number; price: bigint; expiry: number }>();
let releasedEv = 0n, claimedEv = 0n, droppedEv = 0n;
const LAND_CAP = 1_000_000n * WAD;
/** M x 1e18 for a stone of step r on land of step t: max(1, floor(sqrt(num x 1e36 / den))); 0 outside steps 1-32. */
const multOf = (t: number, r: number) => {
  if (t === 0 || r === 0 || t > 32 || r > 32) return 0n;
  const num = fib(Math.min(t, 10)) * fib(t), den = fib(Math.min(r, 10)) * fib(r);
  return num <= den ? WAD : isqrt((num * 10n ** 36n) / den);
};
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
// The re-check due now: the scheduled date, or a 3C verdict's when it comes first (Core.nextVerificationDue)
const dueOf = (c: Cov, rb: number) => {
  const sch = c.through < c.total ? c.termStart + (c.through + 1) * c.interval : 0;
  return rb !== 0 && (sch === 0 || rb < sch) ? rb : sch;
};
// A challenge closing: the part of its time after the due date (EcoChallenge._barred), with the due date as it stood
// before a verdict in the same transaction moved it
// counted only to the challenge's deadline, past which anyone may lapse it (third security pass)
const bar = (c: Cov, openedAt: number, t: number, tx: string) => {
  const due = dueOf(c, c.reverifyTx === tx ? c.reverifyOld : c.reverifyBy);
  const from = due > openedAt ? due : openedAt;
  const end = Math.min(t, openedAt + deadline);
  if (end > from) c.barred += end - from;
};
// When the verifier turns late (EcoParties.lateFrom): never while a Deed or partition block stands; from the later of
// the due date and when it could act again (a lift, a new seat, the Council suspension's end), plus the grace and the
// challenge time after the due date (decisions of 17 Oct)
const councilEnd = new Map<string, number>();
// (a cure's own lift, in the same transaction, comes after the verification is judged: its grace is not counted)
const lateAtOf = (c: Cov, tx = "") => {
  const due = dueOf(c, c.reverifyBy);
  if (due === 0 || (c.status === CovenantStatus.BLOCKED && c.blockReason !== BlockReason.BREACH)) return 0;
  const start = Math.max(due, c.graceTx === tx ? c.graceOld : c.graceFrom, councilEnd.get(c.verifier) ?? 0);
  return start + cfg.maxDelay + c.barred;
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
// a block's own hold is set while it stands (a partition has its own, FM v29), and the vacancy and accession holds
// are set exactly while the seat waits for its new verifier's first re-verification, or the buyer's accession.
const holdsOk = (c: Cov, holds: number) => {
  const st = c.status, reason = c.blockReason;
  const bad: string[] = [];
  if (st === CovenantStatus.ACTIVE && holds & (Holds.BREACH | Holds.DEED)) bad.push("active with a breach or Deed hold that no lift can release");
  if (st === CovenantStatus.BLOCKED && reason === BlockReason.BREACH && !(holds & Holds.BREACH)) bad.push("blocked for a breach without the breach hold");
  if (st === CovenantStatus.BLOCKED && reason === BlockReason.PARTITION && !(holds & Holds.PARTITION)) bad.push("blocked for a partition without the partition hold");
  if (st === CovenantStatus.ACTIVE && holds & Holds.PARTITION) bad.push("active with a partition hold");
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
  if (e.tx !== curTx) {
    flushTx(); curTx = e.tx; curT = t;
    // the EFT's owner ends its land's overcharge during a hold (Model 4 §7.5): every stone gets back what is unpaid
    const target = releaseTx.get(e.tx);
    if (target !== undefined) {
      const ac = accts.get(target);
      stoneC.test(!!ac && (ac.holds & STOPS) !== 0, R(target), () => `the overcharge released with holds ${ac?.holds}: only during a hold`);
      returnStones(target, 1000n, e.tx);
    }
  }
  if (a.tokenId !== undefined && (e.c === "core" || e.c === "bank" || e.c === "parties" || e.c === "challenge")) touched.add(B(a.tokenId));
  switch (`${e.c}.${e.name}`) {
    // ---- the rulebook ----
    case "countries.FlowDefined": flows.set(N(a.flowId), (a.steps as unknown[]).map(Number)); break;
    case "countries.DefaultFeeSet": defaultV = B(a.baseFee); if (minV < 0n) minV = defaultV; break;
    case "countries.MinBaseFeeSet": minV = B(a.minBaseFee); break;
    case "countries.CountryEnabled": case "countries.SettingsApplied": case "countries.CountryFeesSet": {
      const x = countries.get(N(a.country));
      const s = a.settings ? { flowId: N(a.settings.flowId), min: N(a.settings.minTermYears), max: N(a.settings.maxTermYears), listing: N(a.settings.listingWindow), postSale: N(a.settings.postSaleWindow) } : x!.settings;
      const f = a.fees ? {
        baseFee: B(a.fees.baseFee), powerFee: B(a.fees.powerFee), agreementFee: B(a.fees.agreementFee),
        registrationFixed: B(a.fees.registrationFixed), registrationPerHa: B(a.fees.registrationPerHa),
      } : x!.fees;
      countries.set(N(a.country), { settings: s, fees: f });
      break;
    }
    case "bank.FeeSplitSet": split = { wallet: L(a.feeWallet), v: B(a.verifierPermille), tax: B(a.taxPermille), f: B(a.foundationPermille) }; splitChanges.push(e.ord); break;
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
    case "admin.VerifierSuspended": {
      const v = verifiers.get(L(a.verifier)); if (v) v.suspended = true;
      if (L(a.by) === L(addr.governance)) councilEnd.set(L(a.verifier), t + 30 * DAY); // the Council's: at most 30 days
      break;
    }
    case "admin.VerifierUnsuspended": {
      const v = verifiers.get(L(a.verifier)); if (v) v.suspended = false;
      const end = councilEnd.get(L(a.verifier)); if (end && end > t) councilEnd.set(L(a.verifier), t); // lifted early
      break;
    }
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
        vf: B(a.verificationFee), af: B(a.attestationFee), jf: B(a.judgmentFee), paper: B(a.registrationFees), pf: 0n, gf: 0n, rf: 0n,
        vf0: B(a.verificationFee), jf0: B(a.judgmentFee),
        left: { share: B(a.verificationFee), att: B(a.attestationFee), jud: B(a.judgmentFee), p: 0n, g: 0n, r: 0n }, wantPaper: [0n, 0n, 0n],
        shareTaken: false, judgmentSettled: false, status: RequestStatus.OPEN, verifier: Z, claimedAt: 0, verifiedAt: 0,
        cursor: 0, stepAt: 0, ext: new Map(), saleAt: 0, listing: st.settings.listing, postSale: st.settings.postSale,
        firstClaimant: Z, firstClaimUntil: 0, barred: Z, recordedAt: new Map(), ended: false, openedAt: t, rejected: false,
      };
      reqs.set(rid, r);
      const f = st.fees, v = vOf(f);
      const want = [verificationFeeOf(units, v), v, reviewFeeOf(units, deskOf(v))];
      // fees 3-5 (item 16): the power's only where the flow has a power, the agreement's only where it has an agreement
      r.wantPaper = [r.steps.includes(Step.POWER) ? f.powerFee : 0n, r.steps.includes(Step.AGREEMENT) ? f.agreementFee : 0n,
        f.registrationFixed + (f.registrationPerHa * units) / 10_000n];
      const wantPaper = r.wantPaper[0] + r.wantPaper[1] + r.wantPaper[2];
      fees.test(r.vf === want[0] && r.af === want[1] && r.jf === want[2] && r.paper === wantPaper, `#${rid}`,
        () => `paid ${[r.vf, r.af, r.jf, r.paper].map(usd).join(" / ")}; the model gives ${[...want, wantPaper].map(usd).join(" / ")}`);
      // the land fits some edition, and the term the country's range (V12.1: the queue picks the edition, rule 1)
      term.test(years >= st.settings.min && years <= st.settings.max && years >= 3 && years <= 99 && years % 3 === 0, `#${rid}`, () => `${years} years in ${country}: range ${st.settings.min}-${st.settings.max}`);
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
    case "registry.VerifierReassigned": {
      const r = reqs.get(N(a.requestId))!;
      r.verifier = L(a.newVerifier);
      r.assignedFrom = r.status;
      if (r.status === RequestStatus.OPEN) {
        // assigned (section 4): by a Holder (VerifierAssigned follows in the same call), or by the Council from day 60
        if (inTx(e, "parties.VerifierAssigned", (x) => N(x.a.requestId) === r.rid).length === 0) {
          qAssign.test(t > r.openedAt + 2 * cfg.acceptance && t > r.firstClaimUntil && L(a.newVerifier) !== r.guardian, `#${r.rid}`,
            () => `the Council assigned ${short(a.newVerifier)} ${days(t - r.openedAt)} after the sign-up`);
        }
        r.status = RequestStatus.CLAIMED; r.claimedAt = t;
      } else if (r.status === RequestStatus.CLAIMED) r.claimedAt = t;
      break;
    }
    case "parties.VerifierAssigned": {
      const r = reqs.get(N(a.requestId))!, v = L(a.verifier), h = L(a.holder);
      qAssign.test(r.assignedFrom === RequestStatus.OPEN && t > r.openedAt + cfg.acceptance && t > r.firstClaimUntil
        && holders.get(h)?.country === r.country && !isFrozen(h) && holderOf(v) === h && takesWork(v) && v !== r.guardian,
        `#${r.rid}`, () => `assigned ${date(t)} by ${short(h)} to ${short(v)}; open since ${date(r.openedAt)}, status ${r.status}`);
      break;
    }
    case "registry.VerificationSubmitted": {
      const r = reqs.get(N(a.requestId))!, p = places.get(r.rid);
      if (r.status === RequestStatus.VERIFIED) {
        // a land placed more than a year after its verification is re-verified, title and score, by its verifier (§3.1)
        wdw.test(!!p && p.stale && L(a.verifier) === r.verifier, `#${r.rid}`, () => `verified again ${date(t)} while VERIFIED${p?.stale ? "" : ", its place not waiting for a re-verification"}`);
        if (p) p.stale = false;
      } else acc.test(L(a.verifier) === r.verifier && t <= r.claimedAt + cfg.acceptance, `#${r.rid}`, () => `submitted ${days(t - r.claimedAt)} after the claim`);
      r.verifiedAt = t; r.status = RequestStatus.VERIFIED; r.cursor = 0; r.stepAt = t + cfg.watchdog; // the flow opens when the watchdog closes (D8)
      r.rejected = false;
      break;
    }
    case "parties.RequestRejected": {
      // a rejection in place of a verification (R, 13 Oct, section 4.4): the watchdog opens as for a verification
      const r = reqs.get(N(a.requestId))!;
      qReject.test(L(a.verifier) === r.verifier && r.status === RequestStatus.CLAIMED && t <= r.claimedAt + cfg.acceptance
        && N(a.reason) >= 1 && N(a.reason) <= 3 && a.evidenceHash !== ZH, `#${r.rid}`,
        () => `rejected by ${short(a.verifier)} (the claim is ${short(r.verifier)}'s, ${days(t - r.claimedAt)} old), reason ${a.reason}`);
      acc.test(t <= r.claimedAt + cfg.acceptance, `#${r.rid}`, () => `rejected ${days(t - r.claimedAt)} after the claim`);
      r.verifiedAt = t; r.status = RequestStatus.VERIFIED; r.cursor = 0; r.stepAt = t + cfg.watchdog;
      r.rejected = true;
      break;
    }
    case "registry.RequestReopened": {
      const r = reqs.get(N(a.requestId))!;
      r.status = RequestStatus.OPEN; r.barred = L(a.barredVerifier); r.verifier = Z; r.verifiedAt = 0; r.openedAt = t; r.rejected = false;
      break;
    }
    case "registry.VerifierPaid": {
      const r = reqs.get(N(a.requestId))!, amt = B(a.amount);
      pay(e.tx, a.verifier, amt);
      // an upheld W1B pays the verification fee to its challenger as a bounty (R, 18 Oct, C3)
      const w1b = inTx(e, "registry.RequestEnded", (x) => N(x.a.requestId) === r.rid && N(x.a.reason) === 3).length > 0;
      const bountyTo = w1b ? [...chs.values()].filter((x) => x.option === Option.W1B && x.subject === BigInt(r.rid)).pop()?.challenger : undefined;
      upParts.test(L(a.verifier) === (w1b ? bountyTo : r.verifier), `#${r.rid}`, () => `paid ${short(a.verifier)}, the request's verifier is ${short(r.verifier)}${w1b ? `, the W1B challenger ${short(bountyTo ?? Z)}` : ""}`);
      const rejectedEnd = inTx(e, "registry.RequestEnded", (x) => N(x.a.requestId) === r.rid && N(x.a.reason) === 11).length > 0;
      if (!w1b && r.status === RequestStatus.VERIFIED && !r.judgmentSettled && !rejectedEnd) {
        // the watchdog passed with no judges to pay (entering the flow, abandoning or lapsing): the judgment fee
        upParts.test(amt === r.left.jud, `#${r.rid}`, () => `the judgment fee to the verifier was ${usd(amt)}; ${usd(r.left.jud)} was held`);
        r.judgmentSettled = true; r.left.jud = 0n;
      } else {
        // at the first attestation, or (flow B, nothing attested before it) at the mint
        const why = inTx(e, "deeds.DocumentAttested", (x) => N(x.a.requestId) === r.rid).length > 0
          || inTx(e, "registry.CovenantMinted", (x) => N(x.a.requestId) === r.rid).length > 0
          || inTx(e, "registry.RequestEnded", (x) => N(x.a.requestId) === r.rid && [2, 3, 8, 11].includes(N(x.a.reason))).length > 0;
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
    case "deeds.FeesHeld": {
      const r = reqs.get(N(a.requestId))!, got: [bigint, bigint, bigint] = [B(a.powerFee), B(a.agreementFee), B(a.registrationFee)];
      fees.test(got.every((x, k) => x === r.wantPaper[k]) && got[0] + got[1] + got[2] === r.paper, `#${r.rid}`,
        () => `EcoDeeds holds ${got.map(usd).join(" / ")} of ${usd(r.paper)}; the model gives ${r.wantPaper.map(usd).join(" / ")}`);
      [r.pf, r.gf, r.rf] = got;
      r.left.p = got[0]; r.left.g = got[1]; r.left.r = got[2];
      break;
    }
    case "deeds.FeePaid": {
      const r = reqs.get(N(a.requestId))!, amt = B(a.amount), fee = N(a.fee), to = L(a.to);
      pay(e.tx, a.to, amt);
      let why = "";
      if (fee === 3) {
        const anchor = inTx(e, "deeds.PowerAnchored", (x) => N(x.a.requestId) === r.rid)[0];
        if (!anchor) why = "fee 3 with no power recorded";
        else if (to !== L(anchor.a.holder) || to !== holderOf(r.verifier)) why = `fee 3 to ${short(to)}; the Holder that recorded the power is ${short(anchor.a.holder)}`;
        else if (amt !== r.left.p) why = `fee 3 of ${usd(amt)}; ${usd(r.left.p)} was held`;
        r.left.p = 0n;
      } else if (fee === 4) {
        const doc = inTx(e, "deeds.DocumentRecorded", (x) => N(x.a.requestId) === r.rid && N(x.a.step) === Step.AGREEMENT && !x.a.replaced);
        if (!doc.length) why = "fee 4 with no agreement recorded";
        else if (to !== r.verifier) why = `fee 4 to ${short(to)}, not the verifier ${short(r.verifier)}`;
        else if (amt !== r.left.g) why = `fee 4 of ${usd(amt)}; ${usd(r.left.g)} was held`;
        r.left.g = 0n;
      } else if (fee === 5) {
        const lastAttest = r.steps.lastIndexOf(Step.ATTEST);
        const att = inTx(e, "deeds.DocumentAttested", (x) => N(x.a.requestId) === r.rid && N(x.a.index) + 1 === lastAttest);
        if (!att.length) why = "fee 5 not at the flow's last attestation";
        else if (to !== r.verifier) why = `fee 5 to ${short(to)}, not the verifier ${short(r.verifier)}`;
        else if (amt !== r.left.r) why = `fee 5 of ${usd(amt)}; ${usd(r.left.r)} was held`;
        r.left.r = 0n;
      } else why = `fee ${fee}`;
      paperF.test(why === "", `#${r.rid}`, () => why);
      break;
    }
    case "deeds.FeesRefunded": {
      const r = reqs.get(N(a.requestId))!, amt = B(a.amount), left = r.left.p + r.left.g + r.left.r;
      pay(e.tx, a.guardian, amt);
      paperF.test(r.ended && L(a.guardian) === r.guardian && amt === left, `#${r.rid}`,
        () => `refunded ${usd(amt)} to ${short(a.guardian)}${r.ended ? "" : " before the request ended"}; ${usd(left)} was left`);
      upCons.test(amt === left, `#${r.rid}`, () => `fees 3-5 refunded ${usd(amt)}; ${usd(left)} was left`);
      r.left.p = 0n; r.left.g = 0n; r.left.r = 0n;
      break;
    }
    case "registry.RequestEnded": {
      const r = reqs.get(N(a.requestId))!, refund = B(a.refund);
      pay(e.tx, r.guardian, refund);
      const left = r.left.share + r.left.att + r.left.jud;
      upCons.test(refund === left, `#${r.rid}`, () => `refunded ${usd(refund)}; ${usd(left)} was left`);
      r.left.share = 0n; r.left.att = 0n; r.left.jud = 0n;
      if (N(a.reason) === 11) qReject.test(r.rejected && r.status === RequestStatus.VERIFIED && t > r.verifiedAt + cfg.watchdog && r.shareTaken, `#${r.rid}`,
        () => `ended rejected ${date(t)}: rejection filed ${r.rejected}, verified ${date(r.verifiedAt)}, verifier paid ${r.shareTaken}`);
      r.status = RequestStatus.ENDED; r.ended = true;
      break;
    }
    case "registry.FlowEntered": {
      const r = reqs.get(N(a.requestId))!;
      const p = places.get(r.rid);
      wdw.test(t > r.verifiedAt + cfg.watchdog && !!p && p.edition !== 0 && !p.stale, `#${r.rid}`,
        () => `the flow began ${days(t - r.verifiedAt)} after the verification${p?.edition ? "" : ", its land not placed"}${p?.stale ? ", before its re-verification" : ""}`);
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
        // the landowner from day 7, but never the agreement to grant, which nothing attests in flow B (FM v29)
        const guardianOk = L(a.by) !== r.guardian || (!a.replaced && t >= st.stepAt + cfg.guardianFrom && N(a.step) !== Step.AGREEMENT);
        paper.test(t <= dl0 && guardianOk, `#${r.rid}`, () => `${a.replaced ? "corrected" : "recorded"} document ${index} by ${L(a.by) === r.guardian ? "the landowner" : short(a.by)} ${date(t)}; its clock ran from ${date(st.stepAt)} to ${date(dl0)}`);
      } else {
        pst.test(t <= r.saleAt + r.postSale, `#${r.rid}`, () => `recorded ${days(t - r.saleAt)} after the sale`);
      }
      if (a.replaced) { r.stepAt = t; r.ext.delete(r.cursor); r.correction = { index, by: L(a.by), drawn: false }; }
      break;
    }
    case "deeds.SecondSigningReceipts": {
      // a corrected Deed's second signing, paid by the Registry from the verifier's unpaid fee (FM v29 P2)
      const r = reqs.get(N(a.requestId))!, amt = B(a.amount), k = r.correction;
      pay(e.tx, a.holder, amt);
      second.test(!!k && k.by === r.verifier && !k.drawn && amt * 2n <= r.left.share, `#${r.rid}`,
        () => `drew ${usd(amt)}: ${!k ? "no correction" : k.by !== r.verifier ? `the correction was ${short(k.by)}'s, not the verifier's` : k.drawn ? "a second draw" : `over half of ${usd(r.left.share)}`}`);
      upParts.test(amt <= r.left.share && L(a.holder) === holderOf(r.verifier), `#${r.rid}`,
        () => `${short(a.holder)} drew ${usd(amt)} of ${usd(r.left.share)} left of the verification fee; the request's Holder is ${short(holderOf(r.verifier))}`);
      if (k) k.drawn = true;
      r.left.share -= amt; r.vf -= amt;
      break;
    }
    case "bank.SetOffFiled": {
      const tid = B(a.tokenId), c = cov(tid)!, ac = accts.get(tid), amt = B(a.amount);
      // at most the landowner's share of what is still held (item 9: no consideration)
      const cap = ac ? trancheSplit(ac.balance, ac.split0.v, ac.split0.tax, ac.split0.f).g : 0n;
      setOffC.test(((c.causes ?? 0) & 1) !== 0 && L(a.holder) === resolve(c.holder0) && amt <= cap, R(tid),
        () => `filed ${usd(amt)} by ${short(a.holder)}: breach ${((c.causes ?? 0) & 1) !== 0}, the Holder ${short(resolve(c.holder0))}, the landowner's share held ${usd(cap)}`);
      setOffs.set(tid, t);
      break;
    }
    case "bank.SetOffResolved": {
      const tid = B(a.tokenId), filedAt = setOffs.get(tid) ?? t;
      const cure = inTx(e, "core.CovenantVerified", (x) => B(x.a.tokenId) === tid).length > 0;
      setOffC.test(!!a.confirmed === (cure && t >= filedAt + 14 * DAY), R(tid),
        () => `${a.confirmed ? "confirmed" : "voided"} ${days(t - filedAt)} after the filing${cure ? ", at a cure" : ", with no re-verification"}`);
      if (!a.confirmed) setOffs.delete(tid);
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
    case "token.OrdersVoided": orderCounter.set(B(a.tokenId), N(a.counter)); break;
    case "token.Listed": resaleListings.set(B(a.tokenId), { counter: N(a.counter), price: B(a.price) }); break;
    case "token.OfferMade": resaleOffers.set(`${a.tokenId}:${L(a.buyer)}`, { counter: N(a.counter), price: B(a.price), expiry: N(a.expiry) }); break;
    case "token.Sold": {
      // the sale's own transfer has just moved the counter on by one
      const tid = B(a.tokenId), before = (orderCounter.get(tid) ?? 0) - 1, price = B(a.price);
      const o: { counter: number; price: bigint; expiry?: number } | undefined =
        a.byOffer ? resaleOffers.get(`${a.tokenId}:${L(a.buyer)}`) : resaleListings.get(tid);
      const live = !!o && o.counter === before && o.price === price && (o.expiry === undefined || t < o.expiry);
      rsOrd.test(live, R(tid), () => `sold ${a.byOffer ? "by offer" : "at the listing"} for ${usd(price)} at counter ${before}; the order: ${o ? `counter ${o.counter}, ${usd(o.price)}` : "none"}`);
      break;
    }
    case "core.CovenantCreated": {
      const tid = B(a.tokenId), rid = N(a.requestId), v = L(a.verifier);
      covs.set(tid, {
        tid, rid, guardian: L(a.guardian), verifier: v, country: N(a.country), units: B(a.landUnits), term: N(a.termYears), score: N(a.ecoScore),
        holder0: holderOf(v), status: CovenantStatus.MINTED, blockReason: 0, termStart: 0, termEnd: 0, interval: 0, total: 0, through: 0,
        verifications: 0, blockWindow: 0, blocksInWindow: 0, reverifyPending: false, newSeatPending: false,
        seat: { vacant: false, removed: Z, firstClaimant: Z, firstClaimUntil: 0, vacantSince: 0 }, nominee: Z, nominatedBy: Z, restoreBy: 0,
        owner: L(a.guardian), saleApprovedAt: 0, settledAt: 0, accessionPending: false, openChallenge: 0n,
        reverifyBy: 0, reverifyOld: 0, reverifyTx: "", barred: 0, graceFrom: 0, graceOld: 0, graceTx: "",
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
    case "core.DeedRestored": { const c = cov(a.tokenId)!; liftCause(c, 2); c.graceFrom = t; break; }
    case "parties.PartitionEnded": { const c = cov(a.tokenId)!; liftCause(c, 4); c.graceFrom = t; break; }
    case "core.CovenantUnblocked": {
      const c = cov(a.tokenId)!;
      c.graceOld = c.graceFrom; c.graceTx = e.tx; c.graceFrom = t; // a lift gives a fresh grace
      c.causes = 0;
      c.status = c.termStart !== 0 ? CovenantStatus.ACTIVE : CovenantStatus.MINTED; c.blockReason = 0;
      const s = streams.get(c.tid);
      // the last cause lifted without a verification (Tree.onLift): the stream resumes -- even with nothing to release,
      // so no StreamReleased says so -- unless an upheld 3B's stop waits for the new verifier
      if (s && c.termStart !== 0 && !s.ended && s.held && !s.rescore && inTx(e, "core.CovenantVerified", (x) => B(x.a.tokenId) === c.tid).length === 0) s.held = false;
      if (s && c.termStart !== 0 && !s.ended) s.rescore = false; // the lift passes the stream
      break;
    }
    case "core.CovenantCancelled": cov(a.tokenId)!.status = CovenantStatus.CANCELLED; break;
    case "core.CovenantClosed": cov(a.tokenId)!.status = CovenantStatus.CLOSED; break;
    case "core.CovenantEnded": {
      // the term closes only after its last re-verification, unless the land's own failure blocks it (R, 18 Oct, C9)
      const c = cov(a.tokenId)!;
      termEnd.test(c.through >= c.total || c.status === CovenantStatus.BLOCKED, R(c.tid),
        () => `closed with ${c.through} of ${c.total} intervals verified, status ${c.status}`);
      c.status = CovenantStatus.ENDED;
      break;
    }
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
      // FM v29: due at once; no re-verification is possible before an open review window closes; a scheduled one within
      // a review window of that is the re-check, and none is set (EcoParties.recheckDue; 17 Oct)
      const closes = pools.get(c.tid)?.win?.closesAt ?? 0, at = closes > t ? closes : t;
      const scheduled = dueOf(c, 0), merged = scheduled !== 0 && scheduled <= at + cfg.review;
      const dueAt = merged ? 0 : at;
      tclk.test(N(a.by) === dueAt, R(c.tid), () => `a re-verification due ${N(a.by) ? date(N(a.by)) : "with the scheduled one"} after the verdict (expected ${dueAt ? date(dueAt) : "the scheduled one"})`);
      c.reverifyOld = c.reverifyBy; c.reverifyTx = e.tx;
      if (!merged) { c.reverifyPending = true; c.reverifyBy = N(a.by); }
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
      // overdue (D3): past due + grace, from due + grace -- the due date the scheduled one or a 3C verdict's, and the
      // grace moved by the challenge time after it (FM v29; decision 8; Core.lateFrom)
      const due = dueOf(c, c.reverifyBy);
      const lateAt = lateAtOf(c, e.tx);
      const wantOd = lateAt !== 0 && t > lateAt ? lateAt : 0;
      c.reverifyBy = 0; c.barred = 0;
      const st = streams.get(c.tid);
      // late days are deferred, never forfeited: nothing reaches the Reserve for lateness (source 1 is no longer used)
      const credited = inTx(e, "tree.ReserveCredited", (x) => B(x.a.tokenId) === c.tid && N(x.a.source) === 1).length > 0;
      late.test(od === wantOd && !credited, R(c.tid),
        () => `overdueSince ${od ? date(od) : "none"}, expected ${wantOd ? date(wantOd) : "none"} (due ${date(due)}, verified ${date(t)})${credited ? "; late days were credited to the Reserve" : ""}`);
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
      const due = dueOf(c, c.reverifyBy), lateAt = lateAtOf(c);
      const overdue = lateAt !== 0 && t > lateAt;
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
      c.graceFrom = t; // the new seat's grace runs from its filling
      c.seat = { ...s, vacant: false, firstClaimant: Z, firstClaimUntil: 0 };
      c.verifier = nu; c.nominee = Z;
      break;
    }
    case "parties.LandSaleApproved": { const c = cov(a.tokenId)!; c.saleApprovedAt = t; c.accessionPending = !!a.accessionDue; break; }
    // a buyer who accedes, or heirs the Council switches to, take the landowner's share again (FM P6; 17 Oct)
    case "parties.Acceded": { cov(a.tokenId)!.accessionPending = false; const ac = accts.get(B(a.tokenId)); if (ac) ac.shareToPatron = false; break; }
    case "parties.PayeeSwitchedByCouncil": {
      { const ac = accts.get(B(a.tokenId)); if (ac) ac.shareToPatron = false; }
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
      const c = cov(a.tokenId)!, rq = reqs.get(c.rid)!;
      // the floor at the request's own fees, whatever a later fee vote set (item 9)
      const p = B(a.startPrice), yearly = floorOf(rq.term, false, rq.jf0, rq.vf0);
      floorC.test(p >= yearly, R(c.tid), () => `listed from ${usd(p)}; the yearly floor is ${usd(yearly)} (fees ${usd(rq.vf0)} / ${usd(rq.jf0)}, ${rq.term} years)`);
      // the paper flow opened at placement, so a land listed has its place, its allocation fixed (Model 4 §3.1)
      const pl = places.get(c.rid);
      asg.test(!!pl && pl.edition !== 0 && !pl.released, R(c.tid), () => `listed with no place (edition ${pl?.edition ?? 0})`);
      auc.test(N(a.endsAt) - N(a.startsAt) >= cfg.minAuction && N(a.startsAt) >= t, R(c.tid), () => `an auction of ${days(N(a.endsAt) - N(a.startsAt))}`);
      listings.push({ tid: c.tid, endsAt: N(a.endsAt) });
      break;
    }
    case "market.AuctionSettled": if (a.kycPending) cov(a.tokenId)!.settledAt = t; break;
    case "market.StaleSaleCancelled": {
      const c = cov(a.tokenId)!, price = B(a.price), forfeit = B(a.forfeit);
      pay(e.tx, a.buyer, price - forfeit);
      const toPool = inTx(e, "challenge.ReviewPoolFunded", (x) => B(x.a.tokenId) === c.tid).reduce((x, y) => x + B(y.a.amount), 0n);
      forf.test(forfeit === price / 100n && toPool === forfeit, R(c.tid), () => `forfeited ${usd(forfeit)} of ${usd(price)}; ${usd(toPool)} reached the pool`);
      if (!a.failedCheck) tclk.test(t > c.settledAt + cfg.kyc, R(c.tid), () => `called off ${days(t - c.settledAt)} after the auction; the KYC window is ${days(cfg.kyc)}`);
      break;
    }
    case "market.SaleRefunded": pay(e.tx, a.buyer, B(a.price)); break;
    // the top bid is held in escrow; the bid it overtakes is refunded in the same transaction (decided 17 Oct)
    case "market.BidRefunded": pay(e.tx, a.bidder, B(a.amount)); break;
    // a refund the token refused is kept for its owner, who collects it (decided 17 Oct)
    case "market.RefundClaimed": pay(e.tx, a.to, B(a.amount)); break;
    // a payment or refund the token refused stays in the contract, owed: not a transfer in this transaction
    case "bank.PaymentOwed": pay(e.tx, a.to, -B(a.amount)); break;
    case "market.RefundOwed": // an outbid refund refused emits no BidRefunded; a sale's refund is booked by its own event
      if (inTx(e, "market.StaleSaleCancelled", () => true).length + inTx(e, "market.SaleRefunded", () => true).length > 0) pay(e.tx, a.to, -B(a.amount));
      break;
    case "bank.PaymentClaimed": pay(e.tx, a.to, B(a.amount)); break;

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
        ac = { price, pool, balance: net - first, per, total, released: 0, holds: 0, shareToPatron: false, first, verifierPaid: 0n, splitAt: splitChanges.length, closedHeld: 0n, split0: { ...split } };
        accts.set(tid, ac);
        c.interval = N(act.a.interval); c.total = total;
        // the cadence (item 9): twice a year exactly when the price clears floor(2) at the request's own fees
        const rq = reqs.get(c.rid)!;
        const twice = price >= floorOf(rq.term, true, rq.jf0, rq.vf0);
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
      // the whole instalment split at the covenant's own split, nothing paid first (item 9)
      const s = trancheSplit(amount, ac.split0.v, ac.split0.tax, ac.split0.f);
      // a Holder's enforcement cost recovered from the landowner's share (FM v29 P7), paid just before
      const soEv = inTx(e, "bank.SetOffPaid", (x) => B(x.a.tokenId) === tid && x.ord < e.ord);
      const setOff = soEv.reduce((v, x) => v + B(x.a.amount), 0n);
      // a set-off due to a frozen or removed Holder is withheld for it (HolderFeeHeld just before its SetOffPaid), not sent
      const withheld = (x: any) => inTx(e, "bank.HolderFeeHeld", (y) => B(y.a.tokenId) === tid && y.ord === x.ord - 1 && B(y.a.amount) === B(x.a.amount)).length > 0;
      for (const x of soEv) if (!withheld(x)) pay(e.tx, x.a.holder, B(x.a.amount));
      const lastSo = soEv.length ? Math.max(...soEv.map((x) => x.ord)) : -1;
      const heldEv = inTx(e, "bank.HolderFeeHeld", (x) => B(x.a.tokenId) === tid && x.ord < e.ord && x.ord > lastSo);
      const held = heldEv.reduce((x, y) => x + B(y.a.amount), 0n);
      split4.test(B(p.verifierFee) === s.v && B(p.foundationFee) === s.f && B(p.holderFee) + held === s.h && B(p.guardianAmount) + setOff === s.g
        && B(p.verifierFee) + B(p.foundationFee) + B(p.holderFee) + held + B(p.guardianAmount) + setOff === amount && L(p.verifier) === c.verifier && L(p.guardian) === c.guardian, R(tid),
        () => `instalment ${usd(amount)} (set-off ${usd(setOff)}): verifier ${usd(B(p.verifierFee))} (${usd(s.v)}), Foundation ${usd(B(p.foundationFee))} (${usd(s.f)}), Holder ${usd(B(p.holderFee) + held)} (${usd(s.h)}), landowner ${usd(B(p.guardianAmount))} (${usd(s.g)})`);
      ac.verifierPaid += B(p.verifierFee);
      // the Holder fixed at the mint, along its succession line (D7); withheld while it is removed or frozen
      const h = resolve(c.holder0), withhold = !isActiveHolder(h) || isFrozen(h);
      hfee.test(L(p.holder) === h && (s.h === 0n || (withhold ? held === s.h && B(p.holderFee) === 0n : held === 0n)), R(tid),
        () => `the Holder's share to ${short(p.holder)} (${usd(B(p.holderFee))}, ${usd(held)} withheld); the covenant's Holder is ${short(h)}${withhold ? ", removed or frozen" : ""}`);
      pay(e.tx, p.verifier, B(p.verifierFee)); pay(e.tx, split.wallet, B(p.foundationFee)); pay(e.tx, p.holder, B(p.holderFee));
      pay(e.tx, ac.shareToPatron ? owners.get(tid) ?? Z : p.guardian, B(p.guardianAmount));
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
      ac.balance -= amt; ac.per = (ac.per * (1000n - pm)) / 1000n;
      const c = cov(tid); if (c) c.units = (c.units * (1000n - pm)) / 1000n;
      break;
    }
    case "bank.AccountClosed": {
      const tid = B(a.tokenId), ac = accts.get(tid)!, c = cov(tid)!;
      const rel = inTx(e, "bank.InstalmentsReleased", (x) => B(x.a.tokenId) === tid && x.ord < e.ord);
      if (rel.length) {
        consC.test(B(a.toGuardian) === B(rel[0].a.amount) && B(a.toPatron) === 0n && (ac.holds & (Holds.BREACH | Holds.DEED)) === 0, R(tid),
          () => `closed with ${usd(B(a.toGuardian))} released after a release of ${usd(B(rel[0].a.amount))}; holds ${ac!.holds}`);
      } else {
        // held for a breach or a Deed: everything left to the patron, the EFT's owner (FM P7, item 9)
        consC.test(B(a.toGuardian) === 0n && B(a.toPatron) === ac.balance && (ac.holds & (Holds.BREACH | Holds.DEED)) !== 0, R(tid),
          () => `closed with ${usd(B(a.toGuardian))} released and ${usd(B(a.toPatron))} to the patron of ${usd(ac!.balance)}; holds ${ac!.holds}`);
        pay(e.tx, owners.get(tid) ?? Z, B(a.toPatron));
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
        // never sold (closed, or cancelled before its sale): only forfeits, to the landowner (item 3)
        const toLandowner = c.status === CovenantStatus.ENDED || c.status === CovenantStatus.CLOSED || (c.status === CovenantStatus.CANCELLED && c.termStart === 0);
        sweep.test(amt === pl.pool && ((toLandowner && L(a.to) === c.guardian) || (c.status === CovenantStatus.CANCELLED && c.termStart !== 0 && L(a.to) === owner)), R(tid),
          () => `swept ${usd(amt)} of ${usd(pl.pool)} to ${short(a.to)} with the covenant at status ${c.status}`);
        sweepOf.add(tid);
      }
      if (cid !== 0n) { const ch = chs.get(cid)!; if (ch.firstPool === undefined) ch.firstPool = pl.pool; }
      pl.pool -= amt; pl.paid += amt;
      break;
    }
    case "challenge.ChallengeRaised": {
      const cid = B(a.challengeId), o = N(a.option), subject = B(a.subject), who = L(a.challenger);
      { const last = lastClose.get(coolKey(who, o <= Option.W1B ? 1 : 2, subject));
        cool.test(last === undefined || t >= last + cfg.review, `challenge ${cid}`, () => `raised ${days(t - last!)} after its organisation's last challenge on the subject closed`); }
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
        // from the End Date only 3C and 3D are closed: the last window stays open to 3A and 3B, a breach block to 3E
        if (!(c.status === CovenantStatus.ACTIVE || c.status === CovenantStatus.BLOCKED) || (t >= c.termEnd && (o === Option.T3C || o === Option.T3D))) why = `outside the term (status ${c.status})`;
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
        bar(c, ch.openedAt, t, e.tx);
        c.openChallenge = 0n;
      }
      cons.test(got.length === 0, `challenge ${ch.cid}`, () => `option ${o} ${upheld ? "upheld" : "dismissed"}: ${got.join("; ")} (transaction emitted ${same.map((x) => x.name).join(", ")})`);
      ch.ended = true;
      break;
    }
    case "challenge.ChallengeLapsed": case "challenge.ChallengeWithdrawn": {
      const ch = chs.get(B(a.challengeId))!, lapsed = e.name === "ChallengeLapsed";
      lastClose.set(coolKey(ch.challenger, ch.option <= Option.W1B ? 1 : 2, ch.subject), t);
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
        if (lapsed) bar(cov(ch.subject)!, ch.openedAt, t, e.tx); // a withdrawn challenge excuses no lateness
        cov(ch.subject)!.openChallenge = 0n;
      } else {
        const jp = same.filter((x) => x.name === "JudgmentPaid");
        chFee.test(voters.size === 0 ? jp.length === 0 : jp.every((x) => sameSet((x.a.voters as string[]).map(L), [...voters])), `challenge ${ch.cid}`, () => `undecided with ${voters.size} voters, ${jp.length} judgment payments`);
      }
      ch.ended = true;
      break;
    }

    // ---- TR3 Model 4: the editions and the places (§3) ----
    case "editions.EditionOpened": {
      const n = N(a.edition), at = N(a.at);
      // the next opens exactly as the open one's room runs out: its placement follows in the same call
      const filling = n === 1 || inTx(e, "editions.Placed", (x) => x.ord > e.ord && N(x.a.edition) === n - 1).length > 0;
      cls.test(n === ed + 1 && n <= LAST_EDITION && at === t && filling && !ladderFull, `edition ${n}`,
        () => `opened ${date(at)} after edition ${ed}${filling ? "" : ", with no placement filling it"}${ladderFull ? ", the ladder full" : ""}`);
      edRoom[n] = PER_EDITION; edOpened[n] = at; ed = n;
      break;
    }
    case "editions.LadderFull": {
      const filling = inTx(e, "editions.Placed", (x) => x.ord > e.ord && N(x.a.edition) === LAST_EDITION).length > 0;
      cls.test(ed === LAST_EDITION && !ladderFull && filling, "edition 32", () => `the ladder full with edition ${ed} open${filling ? "" : ", with no placement filling it"}`);
      ladderFull = true;
      break;
    }
    case "editions.Reserved": {
      const rid = N(a.requestId), units = B(a.landUnits), years = N(a.termYears), ly = B(a.landYears);
      plc.test(ly === units * BigInt(years) && !places.has(rid), `#${rid}`, () => `reserved ${ly} m2-years for ${units} m2 x ${years} years`);
      land.test(units >= 100n && ly <= limitOf(LAST_EDITION) && years % 3 === 0, `#${rid}`, () => `${N(units) / 10_000} ha for ${years} years: ${ly} m2-years; Edition 32's limit is ${limitOf(LAST_EDITION)}`);
      places.set(rid, { rid, units, years, ly, signedAt: t, turn: 0, stream: 0, edition: 0, rest: 0, alloc: 0n, placedAt: 0, stale: false, sold: false, released: false });
      break;
    }
    case "editions.Queued": {
      // the first verification sets the turn, for good: the later of the sign-up's day 81 and the watchdog's close
      const rid = N(a.requestId), p = places.get(rid);
      const filed = inTx(e, "registry.VerificationSubmitted", (x) => N(x.a.requestId) === rid).length > 0;
      const watch = t + cfg.watchdog, bySignup = (p?.signedAt ?? 0) + TURN_DELAY;
      const want = Math.max(watch, bySignup), signup = watch < bySignup;
      plc.test(!!p && p.stream === 0 && !p.released && filed && N(a.turn) === want && !!a.bySignup === signup, `#${rid}`,
        () => `turn ${date(N(a.turn))} (${a.bySignup ? "by sign-up" : "by watchdog"}); expected ${date(want)}${filed ? "" : ", with no verification filed"}${p?.stream ? ", queued before" : ""}`);
      if (p) { p.turn = N(a.turn); p.stream = a.bySignup ? 2 : 1; }
      break;
    }
    case "editions.PassedOver": {
      const rid = N(a.requestId), p = places.get(rid), k = N(a.edition), next = nextInTurn(t);
      let first = ed + 1;
      while (p && first <= LAST_EDITION && p.ly > limitOf(first)) first++;
      plc.test(!!p && next === p && p.ly > limitOf(ed) && k === first, `#${rid}`,
        () => `passed over to edition ${k} (the first that takes ${p?.ly} m2-years is ${first}; the open edition ${ed} takes ${limitOf(ed)}); next in turn: ${next ? `#${next.rid}` : "none"}`);
      if (p) { p.stream = 3; (lists.get(k) ?? lists.set(k, []).get(k)!).push(rid); }
      break;
    }
    case "editions.Placed": {
      const rid = N(a.requestId), p = places.get(rid), k = N(a.edition), alloc = B(a.allocation), restEd = N(a.restEdition), rest = B(a.restAllocation);
      // the open edition when it was placed: an edition its placement filled opened just before this event, and the
      // next land in turn was chosen before that
      const opened = inTx(e, "editions.EditionOpened", (x) => x.ord < e.ord && N(x.a.edition) === k + 1).length > 0;
      const open = opened ? k : ed, room = edRoom[k], cap = capOf(k);
      // the land cap: no land takes more than 1,000,000 TR3 (only below the production scale does a title need more)
      let need = p ? (p.ly * PER_EDITION) / cap : 0n;
      if (need > MAX_BASE) need = MAX_BASE;
      const next = nextInTurn(t, open);
      let wa = need, wrE = 0, wr = 0n;
      if (need > room) {
        wa = room;
        if (!(ladderFull || k === LAST_EDITION)) {
          const used = (room * cap + PER_EDITION - 1n) / PER_EDITION;
          wrE = k + 1; wr = p && p.ly > used ? ((p.ly - used) * PER_EDITION) / capOf(k + 1) : 0n;
          if (wa + wr > MAX_BASE) wr = MAX_BASE - wa;
        }
      }
      plc.test(!!p && next === p && p.edition === 0 && !p.released && t >= p.turn && k === open && p.ly <= limitOf(k) && alloc === wa && rest === wr && (wr === 0n ? restEd === 0 : restEd === wrE)
        && !(ladderFull && room === 0n), `#${rid}`,
        () => `placed in edition ${k} (open ${open}) ${date(t)}, turn ${date(p?.turn ?? 0)}: ${usd(alloc)} + ${usd(rest)} in ${restEd}; expected ${usd(wa)} + ${usd(wr)} in ${wrE} (room ${usd(room)}); next in turn ${next ? `#${next.rid}` : "none"}`);
      edRoom[k] -= alloc; edPlaced[k] += alloc;
      if (rest !== 0n) { edRoom[restEd] -= rest; edPlaced[restEd] += rest; }
      placedOpenEv += alloc + rest;
      if (p) {
        if (p.stream === 3) lists.get(k)?.shift(); // its list's head (an earlier list's never: the earliest turn goes first)
        for (const [, l] of lists) { const i = l.indexOf(rid); if (i >= 0) l.splice(i, 1); }
        p.edition = k; p.rest = restEd; p.alloc = alloc + rest; p.placedAt = t;
        // the paper flow opens now, or -- placed more than a year after its verification -- once re-verified (§3.1)
        const rq = reqs.get(rid);
        p.stale = !!rq && rq.verifiedAt !== 0 && t > rq.verifiedAt + cfg.year;
        if (rq && rq.status === RequestStatus.VERIFIED && !p.stale) rq.stepAt = Math.max(rq.verifiedAt + cfg.watchdog, t);
      }
      break;
    }
    case "editions.Released": {
      const rid = N(a.requestId), p = places.get(rid), en = N(a.edition), alloc = B(a.allocation);
      const endedTx = inTx(e, "registry.RequestEnded", (x) => N(x.a.requestId) === rid && N(x.a.reason) !== 7).length > 0;
      const back = inTx(e, "editions.RoomReturned", (x) => N(x.a.source) === RS.RELEASED && N(x.a.id) === rid && B(x.a.amount) === alloc).length > 0;
      plRel.test(!!p && !p.released && !p.sold && p.edition === en && p.alloc === alloc && endedTx && (en === 0 || alloc === 0n || back), `#${rid}`,
        () => `released edition ${en}, ${usd(alloc)}; its place: edition ${p?.edition}, ${usd(p?.alloc ?? 0n)}${endedTx ? "" : ", with no request ending"}${back ? "" : ", its room not returned"}`);
      if (p) { p.released = true; if (p.edition !== 0) placedOpenEv -= p.alloc; }
      break;
    }
    case "editions.RoomReturned": {
      const src = N(a.source), amt = B(a.amount), to = N(a.toEdition), id = B(a.id);
      // what freed it, in the same transaction
      let why = false;
      if (src === RS.RELEASED) why = inTx(e, "editions.Released", (x) => B(x.a.requestId) === id && B(x.a.allocation) === amt).length > 0;
      else if (src === RS.EARLY_END) why = inTx(e, "tree.RewardEnded", (x) => B(x.a.tokenId) === id && B(x.a.toRoom) === amt).length > 0
        || inTx(e, "parties.Acquired", (x) => B(x.a.tokenId) === id && N(x.a.permille) < 1000).length > 0;
      else if (src === RS.END_HOLD) why = inTx(e, "tree.RewardEnded", (x) => B(x.a.tokenId) === id && !x.a.completed && B(x.a.toRoom) === amt).length > 0;
      else if (src === RS.NO_WEIGHT) why = totalW === 0n && inTx(e, "overcharge.Drop", (x) => B(x.a.land) === id && B(x.a.amount) === amt && x.ord < e.ord).length > 0;
      else if (src === RS.PAIR_CAP) why = inTx(e, "overcharge.GemsReleased", (x) => B(x.a.land) === id && B(x.a.toRoom) === amt).length > 0;
      e4.test(why && to === ed && amt !== 0n, `${["a released place", "an early end", "an End-Date hold", "a drop with no weight", "a pair's excess"][src] ?? src} ${id}`,
        () => `${usd(amt)} back to edition ${to} (the open one is ${ed})${why ? "" : ", with nothing in the transaction freeing it"}`);
      edRoom[to] += amt;
      if (src === RS.EARLY_END && !inTx(e, "tree.RewardEnded", (x) => B(x.a.tokenId) === id).length) { const s = streams.get(id); if (s) { s.alloc -= amt; s.cut += amt; } }
      if (src === RS.PAIR_CAP) poolEv -= amt;
      break;
    }
    case "editions.Sold": {
      const rid = N(a.requestId), p = places.get(rid), en = N(a.edition), alloc = B(a.allocation);
      asg.test(!!p && p.edition === en && !p.sold && !p.released && p.alloc === alloc, `#${rid}`,
        () => `activated in edition ${en} with ${usd(alloc)}; placed in ${p?.edition} with ${usd(p?.alloc ?? 0n)}`);
      trCap.test(alloc <= MAX_BASE, `#${rid}`, () => `allocation ${usd(alloc)}`);
      if (p) { p.sold = true; placedOpenEv -= p.alloc; }
      break;
    }

    // ---- TR3: the stream (Tree) ----
    case "tree.EditionAssigned": {
      const tid = B(a.tokenId), p = places.get(reqOfToken.get(tid) ?? -1);
      asg.test(!!p && p.sold && N(a.edition) === p.edition && B(a.landYears) === p.ly, R(tid), () => `activated in edition ${a.edition} with ${a.landYears}; placed in ${p?.edition} with ${p?.ly}`);
      break;
    }
    case "tree.RewardStarted": {
      const tid = B(a.tokenId), p = places.get(reqOfToken.get(tid) ?? -1), c = cov(tid)!;
      rew.test(!!p && B(a.allocation) === p.alloc && N(a.edition) === p.edition && N(a.ecoScore) === c.score && !streams.has(tid), R(tid),
        () => `${usd(B(a.allocation))} TR3 in edition ${a.edition} at score ${a.ecoScore}; placed with ${usd(p?.alloc ?? 0n)} in ${p?.edition}, score ${c.score}`);
      streams.set(tid, { alloc: B(a.allocation), edition: N(a.edition), score: N(a.ecoScore), rescore: false, ended: false,
        stream: 0n, credits: 0n, toRoom: 0n, mark: 0, horizon: 0, held: false, heldAtEnd: false, cut: 0n, anchored: 0, overcharge: 0n });
      break;
    }
    case "tree.RewardHeld": { const s = streams.get(B(a.tokenId)); if (s) { s.held = true; if (a.rescoreOnLift) s.rescore = true; } break; }
    case "tree.Underwritten": {
      const tid = B(a.tokenId), s = streams.get(tid)!, c = cov(tid)!, h = N(a.horizon);
      const ver = inTx(e, "core.CovenantVerified", (x) => B(x.a.tokenId) === tid)[0];
      let want = -1;
      if (ver) {
        // a verification underwrites the interval after it, never past the next scheduled due date (C9)
        const k = N(ver.a.verifiedThrough), due = k >= c.total ? c.termEnd : c.termStart + (k + 1) * c.interval;
        want = Math.min(t + c.interval, due);
      } else {
        // the activation: one interval after the verification before the sale, never past the first due date
        const act = inTx(e, "core.CovenantActivated", (x) => B(x.a.tokenId) === tid)[0], acct = inTx(e, "bank.Activated", (x) => B(x.a.tokenId) === tid)[0];
        if (act && acct) want = Math.min((reqs.get(c.rid)?.verifiedAt ?? 0) + N(acct.a.interval), N(act.a.termStart) + N(acct.a.interval));
      }
      if (want >= 0) hzn.test(h === want, R(tid), () => `underwrote to ${date(h)}; expected ${date(want)}`);
      s.horizon = h;
      if (ver) s.held = false; // the verification lifts a stop
      break;
    }
    case "tree.StreamReleased": {
      const tid = B(a.tokenId), s = streams.get(tid)!, amt = B(a.amount), score = N(a.score), through = N(a.through);
      const ver = inTx(e, "core.CovenantVerified", (x) => B(x.a.tokenId) === tid)[0];
      // C9: a verification settles what the last one underwrote at the old score, then the rest at the score it records;
      // what a stop held, at the lower of the two (§4.9); anything else settles at the score in force, up to the horizon
      const start = s.mark || cov(tid)!.termStart, cut = Math.min(s.horizon, t);
      if (!ver && s.held && !s.rescore && inTx(e, "core.CovenantUnblocked", (x) => B(x.a.tokenId) === tid).length > 0) s.held = false;
      const named = ver ? N(ver.a.ecoScore) : s.score;
      const oldPart = ver && !s.held && start < cut && through <= cut;
      const want = ver ? (s.held ? Math.min(s.score, named) : oldPart ? s.score : named) : s.score;
      const reach = ver ? through <= t : through <= s.horizon && !s.held;
      relScore.test(reach, R(tid), () => `released through ${date(through)} from ${date(start)}${ver ? " in a verification" : ""}; the horizon was ${date(s.horizon)}${s.held ? ", and the stream was stopped" : ""}`);
      s.mark = through;
      // the span's shortfall: its Drop follows, after the stones' release (Tree._settle, EcoOvercharge.settle)
      const tx = byTx.get(e.tx)!, k = tx.indexOf(e);
      let drop = 0n, paidEv = 0n;
      for (let j = k + 1; j < tx.length; j++) {
        const x = tx[j];
        if (x.c === "tree" && x.name === "OverchargeReleased" && B(x.a.tokenId) === tid) { paidEv = B(x.a.amount); continue; }
        if (x.c === "overcharge" && x.name === "Drop" && B(x.a.land) === tid) drop = B(x.a.amount);
        break;
      }
      relScore.test(score === want && amt === ((amt + drop) * BigInt(score)) / 100n, R(tid), () => `released ${usd(amt)} at score ${score} (expected ${want}), ${usd(drop)} dropped for the shortfall`);
      // the stones' instalments accrue with the stream, at its score (EcoOvercharge.accrue, before the release)
      const paid = accrue(tid, through, score);
      stoneC.test(paid === paidEv, R(tid), () => `the stones released ${usd(paidEv)}; the instalments give ${usd(paid)}`);
      s.stream += amt; releasedEv += amt + paid; s.overcharge += paid;
      const r = recs.get(tid); if (r) r.minted += amt;
      break;
    }
    case "tree.OverchargeReleased": break; // checked with its StreamReleased
    case "tree.RewardEnded": {
      const tid = B(a.tokenId), s = streams.get(tid)!, rest = B(a.toRoom);
      const atEnd = inTx(e, "core.CovenantEnded", (x) => B(x.a.tokenId) === tid).length > 0;
      if (s.held && atEnd) s.heldAtEnd = true;
      const src = s.held && atEnd ? RS.END_HOLD : RS.EARLY_END;
      const back = rest === 0n || inTx(e, "editions.RoomReturned", (x) => N(x.a.source) === src && B(x.a.id) === tid && B(x.a.amount) === rest).length > 0;
      strCons.test(s.stream + s.credits + rest === s.alloc && !s.ended && back, R(tid),
        () => `ended with ${usd(s.stream)} released, ${usd(s.credits)} dropped and ${usd(rest)} back to room, of ${usd(s.alloc)}${back ? "" : "; the room return is missing"}`);
      // completed: the End Date with no stop standing; an early end or a stop at the End Date shatters the record
      pairC.test(!!a.completed === (atEnd && !s.held), R(tid), () => `ended ${a.completed ? "completed" : "not completed"} (End Date ${atEnd}, stopped ${s.held})`);
      s.toRoom += rest; s.ended = true; s.held = false;
      break;
    }
    case "tree.RewardClaimed": {
      const tid = B(a.tokenId), x = claims.get(tid) ?? { p: 0n, g: 0n, r: 0n };
      if (B(a.patronAmount) !== 0n) {
        const inTransfer = (byTx.get(e.tx) ?? []).some((y) => y.c === "token" && y.name === "Transfer");
        rsClaim.test(L(a.patron) === owners.get(tid) && B(a.guardianAmount) === 0n && !inTransfer, R(tid),
          () => `${usd(B(a.patronAmount))} minted to ${short(a.patron)}; the owner is ${short(owners.get(tid) ?? Z)}${inTransfer ? ", in a transfer" : ""}`);
      } else rsClaim.ok();
      x.p += B(a.patronAmount); x.g += B(a.guardianAmount); x.r += B(a.referrerAmount);
      claims.set(tid, x);
      claimedEv += B(a.patronAmount) + B(a.guardianAmount) + B(a.referrerAmount);
      const ref = L(a.referrer);
      if (ref !== Z) {
        const judges = gtas.has(ref) || ref === cov(tid)!.verifier;
        if (judges) trRef.test(B(a.referrerAmount) === 0n, R(tid), () => `the referrer ${short(ref)} sits on the Council or scores the land, yet took ${usd(B(a.referrerAmount))}`);
        else trRef.ok();
      }
      break;
    }

    // ---- the records (EcoOvercharge, Model 4 §5-6) ----
    case "overcharge.WeightSet": {
      const tid = B(a.land), w = B(a.weight), s = streams.get(tid), c = cov(tid);
      const nextOf = nextFor(e, tid);
      let r = recs.get(tid), want = -1n, op = "";
      if (!r) {
        // born at the activation, just before RewardStarted
        op = "born";
        const st = inTx(e, "tree.RewardStarted", (x) => B(x.a.tokenId) === tid)[0];
        const term = c?.term ?? 0, alloc = st ? B(st.a.allocation) : 0n;
        r = { edition: st ? N(st.a.edition) : 0, state: RSt.ASLEEP, n: Math.floor(term / 3), releases: 0, term, weight: 0n, alloc, balance: 0n, minted: 0n, index: dropIdx, cutDone: "" };
        recs.set(tid, r);
        landsS.set(tid, { room: alloc, roomUsed: 0n, committed: 0n, allocation: alloc, instalment: 0n, left: 0n, carry: 0n, from: 0, to: 0, mark: 0, ids: [], st: new Map() });
        want = weightOf(r, st ? N(st.a.ecoScore) : 0);
        recC.test(!!st && !!c, R(tid), () => "a record born with no activation");
      } else {
        settleRec(r);
        const ver = inTx(e, "core.CovenantVerified", (x) => B(x.a.tokenId) === tid)[0];
        const through = ver ? N(ver.a.verifiedThrough) : 0;
        if (nextOf === "RecordHeld") { op = "hold"; recC.test(r.state === RSt.ASLEEP || r.state === RSt.PAUSED, R(tid), () => `held from state ${r!.state}`); r.state = RSt.HELD; want = 0n; }
        else if (nextOf === "RecordPaused") {
          op = "pause";
          const due = c ? lateAtOf(c) : 0;
          recC.test(r.state === RSt.ASLEEP && !!c && due !== 0 && t > due, R(tid), () => `paused from state ${r!.state} ${date(t)}; its verification was overdue from ${due ? date(due) : "never"}`);
          r.state = RSt.PAUSED; want = 0n;
        } else if (nextOf === "GemsReleased" || nextOf === "RecordShattered") {
          // the term ended: every stone gets back what it has not been paid, first (EcoOvercharge.end)
          op = "end"; returnStones(tid, 1000n, e.tx); r.state = RSt.CLOSED; want = 0n;
        } else if (nextOf === "PartlyAcquired") {
          op = "cut";
          const pa = inTx(e, "overcharge.PartlyAcquired", (x) => B(x.a.land) === tid && x.ord > e.ord)[0];
          cutRecord(tid, r, BigInt(N(pa.a.permille)), e.tx);
          want = weightOf(r, s?.score ?? 0);
        } else if (ver && s && through > s.anchored) {
          // a Loop Anchor (§6.3): the withheld part back to the stones, the releases due (made as one pair, above), the
          // weight from the score just named, 0 after the last interval, and the next interval's instalments
          op = "anchor";
          confirm(tid, e.tx);
          const due = Math.min(Math.floor((through * c!.interval) / (3 * cfg.year)), r.n - 1);
          const paired = inTx(e, "overcharge.GemsReleased", (x) => B(x.a.land) === tid && x.ord < e.ord).length > 0;
          pairC.test(paired === due > r.releases, R(tid), () => `the anchor confirming interval ${through}: ${due} releases due, ${r!.releases} made, ${paired ? "a pair made" : "no pair"}`);
          r.releases = Math.max(r.releases, due);
          r.state = RSt.ASLEEP;
          const last = through >= c!.total;
          want = last ? 0n : weightOf(r, N(ver.a.ecoScore));
          s.anchored = through;
          const from = c!.termStart + through * c!.interval, to = Math.min(from + c!.interval, c!.termEnd);
          if (from < c!.termEnd) openInstalments(tid, from, to, c!.termEnd);
        } else {
          // a hold lifted: by a verification off schedule, or the Council, the Deed restored, an upheld 3E
          op = "lift";
          recC.test(r.state === RSt.HELD || r.state === RSt.PAUSED, R(tid), () => `lifted from state ${r!.state}`);
          r.state = RSt.ASLEEP;
          want = weightOf(r, ver ? N(ver.a.ecoScore) : s?.score ?? 0);
        }
      }
      recC.test(w === want, R(tid), () => `weight ${usd(w)} at ${op}; the record gives ${usd(want)} (allocation ${usd(r!.alloc)}, ${r!.term} years, releases ${r!.releases} of ${r!.n})`);
      totalW += w - r.weight; r.weight = w;
      break;
    }
    case "overcharge.RecordHeld": case "overcharge.RecordPaused": break; // with their WeightSet
    case "overcharge.Drop": {
      const tid = B(a.land), amt = B(a.amount);
      // a shattered record's balance (already held here), or a land's shortfall from its stream
      const shatter = inTx(e, "overcharge.RecordShattered", (x) => B(x.a.land) === tid && x.ord < e.ord).length > 0
        || inTx(e, "overcharge.PartlyAcquired", (x) => B(x.a.land) === tid && x.ord < e.ord).length > 0;
      if (!shatter) { const s = streams.get(tid); if (s) s.credits += amt; }
      if (totalW === 0n) {
        const back = inTx(e, "editions.RoomReturned", (x) => N(x.a.source) === RS.NO_WEIGHT && B(x.a.id) === tid && B(x.a.amount) === amt && x.ord > e.ord).length > 0;
        recC.test(back, R(tid), () => `${usd(amt)} dropped with no weight anywhere, and not returned to room`);
        if (shatter) poolEv -= amt;
      } else {
        dropIdx += (amt * INDEX) / totalW;
        if (!shatter) poolEv += amt;
      }
      droppedEv += amt;
      break;
    }
    case "overcharge.RecordShattered": {
      const tid = B(a.land), r = recs.get(tid)!;
      settleRec(r);
      recC.test(B(a.balance) === r.balance && r.state === RSt.CLOSED, R(tid), () => `shattered ${usd(B(a.balance))}; the record holds ${usd(r.balance)}, state ${r.state}`);
      r.balance = 0n;
      break;
    }
    case "overcharge.PartlyAcquired": {
      const tid = B(a.land), r = recs.get(tid)!, pm = BigInt(N(a.permille));
      if (r.cutDone !== e.tx) cutRecord(tid, r, pm, e.tx);
      recC.test(B(a.shattered) === r.cutAmount, R(tid), () => `an acquired ${pm}‰ shattered ${usd(B(a.shattered))}; the record gives ${usd(r.cutAmount ?? 0n)}`);
      break;
    }
    case "overcharge.GemsReleased": {
      const tid = B(a.land), r = recs.get(tid)!, x = B(a.amount), excess = B(a.toRoom);
      settleRec(r);
      const b = r.balance, wantX = b < r.minted ? b : r.minted;
      const ending = r.state === RSt.CLOSED;
      const release = N(a.release), wantRelease = ending ? r.n : r.releases + 1;
      const owner = owners.get(tid) ?? Z, payee = accts.get(tid)?.shareToPatron ? owner : L(cov(tid)?.guardian ?? Z);
      const pg = B(a.patronGem), gg = B(a.guardianGem);
      const okGems = x === 0n ? pg === 0n && gg === 0n
        : pg !== 0n && gemOwner.get(pg) === owner && (x / 2n === 0n ? gg === 0n : gg !== 0n && gemOwner.get(gg) === payee);
      pairC.test(x === wantX && excess === b - wantX && release === wantRelease && okGems, R(tid),
        () => `pair ${release} (expected ${wantRelease}): ${usd(x)} in gems ${pg} / ${gg}, ${usd(excess)} to room; the record holds ${usd(b)}, its land minted ${usd(r.minted)} since its last pair; to ${short(gemOwner.get(pg) ?? Z)} / ${short(gemOwner.get(gg) ?? Z)}, expected the owner ${short(owner)} / the payee ${short(payee)}`);
      if (pg !== 0n) gemsL.set(pg, { edition: r.edition, half: 1, release, land: tid, balance: x - x / 2n, open: 0 });
      if (gg !== 0n) gemsL.set(gg, { edition: r.edition, half: 2, release, land: tid, balance: x / 2n, open: 0 });
      if (ending) r.releases = r.n;
      r.balance = 0n; r.minted = 0n;
      break;
    }
    case "overcharge.Transfer": {
      // the gems are ERC-721s: minted at a pair, burned when fused
      gemOwner.set(B(a.tokenId), L(a.to));
      break;
    }

    // ---- gems and stones (Model 4 §7-8) ----
    case "overcharge.Overcharged": {
      const tid = B(a.target), id = B(a.gem), c = B(a.commitment), m = B(a.multiplierE18);
      const g = gemsL.get(id), L_ = landsS.get(tid), r = recs.get(tid), cv = cov(tid), ac = accts.get(tid);
      const okLand = !!cv && !!ac && cv.status === CovenantStatus.ACTIVE && cv.through === 0 && t < cv.termStart + cv.interval && (ac.holds & STOPS) === 0;
      const prev = inTx(e, "overcharge.Overcharged", (x) => B(x.a.target) === tid && x.ord < e.ord).pop();
      const pg = prev ? gemsL.get(B(prev.a.gem)) : undefined;
      const inOrder = !prev || !pg || !g || pg.edition < g.edition || (pg.edition === g.edition && B(prev.a.gem) < id);
      const wantM = g && r ? multOf(stepOf(r.edition), stepOf(g.edition)) : 0n;
      let want = 0n;
      if (g && L_) {
        const roomLeft = L_.room > L_.roomUsed ? L_.room - L_.roomUsed : 0n;
        want = (wantM * roomLeft) / WAD;
        const used = L_.allocation + L_.committed, cap = LAND_CAP > used ? LAND_CAP - used : 0n;
        if (want > cap) want = cap;
        if (want > g.balance) want = g.balance;
      }
      const owned = !!g && gemOwner.get(id) === owners.get(tid);
      stoneC.test(okLand && inOrder && owned && m === wantM && c === want && c !== 0n, R(tid),
        () => `gem ${id} (edition ${g?.edition}, ${usd(g?.balance ?? 0n)} carats) set ${usd(c)} at M = ${Number(m) / 1e18}; expected ${usd(want)} at ${Number(wantM) / 1e18}${okLand ? "" : ", into land that is not new"}${inOrder ? "" : ", out of edition order"}${owned ? "" : ", not its EFT owner's"}`);
      if (g && L_) {
        let st = L_.st.get(id);
        if (!st) { st = { set: true, unpaid: 0n, instalment: 0n }; L_.st.set(id, st); L_.ids.push(id); g.open++; }
        else if (st.unpaid === 0n) g.open++;
        stoneC.test(L_.ids.length <= 21, R(tid), () => `${L_.ids.length} stones set`);
        L_.roomUsed += (c * WAD + m - 1n) / m; L_.committed += c; st.unpaid += c; g.balance -= c;
        trCap.test(L_.allocation + L_.committed <= LAND_CAP, R(tid), () => `allocation ${usd(L_.allocation)} with ${usd(L_.committed)} committed`);
      }
      poolEv -= c; committedEv += c;
      break;
    }
    case "overcharge.Carried": {
      const k = `${e.tx}|${B(a.gem)}|${B(a.amount)}`;
      carriedEv.set(k, (carriedEv.get(k) ?? 0) + 1);
      break;
    }
    case "overcharge.Transmuted": {
      const ids = (a.ids as unknown[]).map((x) => B(x)), into = B(a.into), first = gemsL.get(into);
      let sum = 0n, ok = !!first && ids.length >= 2 && ids[0] === into, oneLand = true;
      const owner = gemOwner.get(into);
      for (const [i, id] of ids.entries()) {
        const g = gemsL.get(id);
        if (!g || !first || g.edition !== first.edition || g.open !== 0 || (i > 0 && id === into)) ok = false;
        if (g && first && g.land !== first.land) oneLand = false;
        // the others are burned in this call: their owner, before, is the caller's
        if (i > 0 && !inTx(e, "overcharge.Transfer", (x) => B(x.a.tokenId) === id && L(x.a.from) === owner && L(x.a.to) === Z).length) ok = false;
        sum += g?.balance ?? 0n;
      }
      gemC.test(ok && sum <= CARAT_CAP, `gem ${into}`, () => `fused ${ids.join(", ")} into ${into}: ${usd(sum)} carats${sum > CARAT_CAP ? ", above the cap" : ""}`);
      for (const id of ids.slice(1)) { const g = gemsL.get(id); if (g) { g.balance = 0n; g.burned = true; } }
      if (first) { first.balance = sum; first.half = 3; if (!oneLand) { first.land = 0n; first.release = 0; } }
      break;
    }
    case "overcharge.MetadataUpdate": break;
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
const feesNow = await Promise.all(reqIds.map((rid) => rd("deeds", "feesOf", [BigInt(rid)])));
reqIds.forEach((rid, i) => {
  const r = reqs.get(rid)!, x = reqNow[i], f = feesNow[i];
  const held = B(x.verifierShare) + B(x.attestationFee) + B(x.judgmentFee);
  const paidIn = r.vf + r.af + r.jf, left = r.left.share + r.left.att + r.left.jud;
  upCons.test(held === left, `#${rid}`, () => `paid in ${usd(paidIn)}; the replay leaves ${usd(left)}, the Registry holds ${usd(held)}`);
  const inDeeds = [B(f.power), B(f.agreement), B(f.registration)], replay = [r.left.p, r.left.g, r.left.r];
  upCons.test(inDeeds.every((v, k) => v === replay[k]), `#${rid}`, () => `fees 3-5: the replay leaves ${replay.map(usd).join(" / ")}, EcoDeeds holds ${inDeeds.map(usd).join(" / ")}`);
  if (N(x.endReason) === 7) paperF.test(inDeeds.every((v) => v === 0n), `#${rid}`, () => `completed with ${inDeeds.map(usd).join(" / ")} of fees 3-5 unused`);
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
let claimable = 0n, pendingNow = 0n, unstreamedEv = 0n, verifierSummary = { terms: 0, share: 0 };
for (const x of covNow) {
  const c = covs.get(x.tid)!, ac = accts.get(x.tid), s = streams.get(x.tid), pl = pools.get(x.tid);
  // the money
  if (ac) {
    const released = E("bank.InstalmentsReleased").filter((e) => B(e.a.tokenId) === x.tid).reduce((v, e) => v + B(e.a.amount), 0n);
    const toPatron = E("bank.PaidToPatron").filter((e) => B(e.a.tokenId) === x.tid).reduce((v, e) => v + B(e.a.amount), 0n);
    const closedHeld = (ac as any).closedHeld ?? 0n;
    saleCons.test(ac.price === ac.pool + released + toPatron + closedHeld + B(x.a.balance), R(x.tid),
      () => `price ${usd(ac.price)} vs pool ${usd(ac.pool)} + released ${usd(released)} + to the patron ${usd(toPatron)} + held at the End Date ${usd(closedHeld)} + held ${usd(B(x.a.balance))}`);
    bankRep.test(ac.balance === B(x.a.balance) && ac.released === N(x.a.released) && ac.holds === N(x.a.holds) && ac.per === B(x.a.perRelease), R(x.tid),
      () => `replayed balance ${usd(ac.balance)}, ${ac.released} released, ${usd(ac.per)} an instalment, holds ${ac.holds}; the Bank has ${usd(B(x.a.balance))}, ${x.a.released}, ${usd(B(x.a.perRelease))}, holds ${x.a.holds}`);
    if (N(x.c.status) === CovenantStatus.ENDED && ac.splitAt !== -1 && E("bank.PaidToPatron").every((e) => B(e.a.tokenId) !== x.tid) && !(ac as any).closedHeld) {
      // the split the whole term ran under
      const pp = poolPermilleOf(ac.split0.tax, ac.split0.f);
      const expect = ((ac.price - ac.pool) * ac.split0.v) / (1000n - pp);
      const diff = ac.verifierPaid > expect ? ac.verifierPaid - expect : expect - ac.verifierPaid;
      vshare.test(diff <= BigInt(ac.total + 2) * 2n, R(x.tid), () => `the verifier earned ${usd(ac.verifierPaid)}; ${usd(expect)} is its share of ${usd(ac.price - ac.pool)}`);
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
    // what has streamed and not yet settled is claimable too (C9): Tree splits released + pending
    const v = x.rw, rel = B(v.released) + B(v.pending), gross = (rel * 10n) / 100n, ref = L(x.c.referral);
    const refSlot = ref === Z ? 0n : (gross * 30n) / 100n;
    // while a land buyer has not acceded the landowner's side is owed but not claimable (Tree.rewardOf shows it as 0):
    // what it is owed is the released share less what was paid, split as Tree._due would
    const accession = (N(x.a.holds) & Holds.ACCESSION) !== 0;
    const gHeld = accession ? gross - refSlot - B(v.guardianPaid) : 0n, rHeld = accession ? refSlot - B(v.referralPaid) : 0n;
    const patron = B(v.patronPaid) + B(v.patronClaimable), guardian = B(v.guardianPaid) + B(v.guardianClaimable) + gHeld, referral = B(v.referralPaid) + B(v.referralClaimable) + rHeld;
    const cl = claims.get(x.tid) ?? { p: 0n, g: 0n, r: 0n };
    trSplit.test(patron === rel - gross && guardian === gross - refSlot && referral === refSlot && cl.p === B(v.patronPaid) && cl.g + cl.r === B(v.guardianPaid) + B(v.referralPaid), R(x.tid),
      () => `released ${usd(rel)}: patron ${usd(patron)}, landowner ${usd(guardian)}, referral ${usd(referral)}; claimed ${usd(cl.p)} / ${usd(cl.g + cl.r)}`);
    trCap.test(B(v.landEarned) <= B(v.allocation) && B(v.released) - B(v.overchargePaid) === s.stream && B(v.overchargePaid) === s.overcharge && B(v.allocation) === s.alloc, R(x.tid),
      () => `land TR3 ${usd(B(v.landEarned))} of ${usd(B(v.allocation))} (replayed ${usd(s.alloc)}), released ${usd(B(v.released) - B(v.overchargePaid))} and ${usd(B(v.overchargePaid))} of stones' (the events released ${usd(s.stream)} and ${usd(s.overcharge)})`);
    hzn.test(N(v.horizon) === s.horizon, R(x.tid), () => `Tree has the horizon ${date(N(v.horizon))}; replayed ${date(s.horizon)}`);
    pendingNow += B(v.pending);
    if (!s.ended) strCons.test(s.stream + s.credits <= s.alloc && B(v.allocationLeft) === s.alloc - s.stream - s.credits, R(x.tid),
      () => `${usd(s.stream)} released and ${usd(s.credits)} dropped of ${usd(s.alloc)}; Tree has ${usd(B(v.allocationLeft))} left`);
    claimable += B(v.patronClaimable) + B(v.guardianClaimable) + B(v.referralClaimable) + gHeld + rHeld;
    if (accession) trSplit.test(B(v.guardianClaimable) + B(v.referralClaimable) === 0n, R(x.tid), () => "a buyer's accession is pending, yet the landowner's side shows claimable");
  }
}
// the active allocations not yet released or dropped, and the places: every request ended without its sale released
for (const s of streams.values()) unstreamedEv += s.alloc - s.stream - s.credits - s.toRoom;
for (const p of places.values()) {
  const r = reqs.get(p.rid)!;
  if (!p.released && r.ended) plRel.test(p.sold && E("registry.RequestEnded").some((e) => N(e.a.requestId) === p.rid && N(e.a.reason) === 7), `#${p.rid}`, () => "its request ended without a sale, yet its place was never released");
  // a land whose turn came long ago is placed, or waits for an edition not yet open, or (after Edition 32) for room
  if (p.stream === 1 || p.stream === 2) {
    const waits = p.edition === 0 && !p.released && p.turn + 30 * DAY < now && !(ladderFull && edRoom[LAST_EDITION] === 0n);
    plc.test(!waits, `#${p.rid}`, () => `its turn came ${date(p.turn)}, and it is still not placed`);
  }
}

// the editions and the places: the replay against EcoEditions now
{
  const [curNow, fullNow, openNow, ...eds] = await Promise.all([rd("editions", "current"), rd("editions", "full"), rd("editions", "placedOpen"),
    ...Array.from({ length: LAST_EDITION }, (_, i) => rd("editions", "rawEdition", [i + 1]))]);
  for (let n = 1; n <= LAST_EDITION; n++) {
    const x = eds[n - 1];
    edState.test(B(x.room) === edRoom[n] && B(x.placed) === edPlaced[n] && N(x.openedAt) === edOpened[n], `edition ${n}`,
      () => `EcoEditions: room ${usd(B(x.room))}, placed ${usd(B(x.placed))}, opened ${date(N(x.openedAt))}; replayed ${usd(edRoom[n])}, ${usd(edPlaced[n])}, ${date(edOpened[n])}`);
  }
  edState.test(N(curNow) === ed && !!fullNow === ladderFull && B(openNow) === placedOpenEv, "the ladder",
    () => `EcoEditions: edition ${curNow} open, full ${fullNow}, ${usd(B(openNow))} placed and not active; replayed ${ed}, ${ladderFull}, ${usd(placedOpenEv)}`);
  const pls = [...places.values()];
  const resNow = await Promise.all(pls.map((p) => rd("editions", "reservationOf", [BigInt(p.rid)])));
  pls.forEach((p, i) => {
    const x = resNow[i];
    edState.test(N(x.edition) === p.edition && N(x.restEdition) === p.rest && B(x.allocation) === p.alloc && N(x.turn) === p.turn && N(x.stream) === p.stream
      && !!x.sold === p.sold && !!x.released === p.released, `#${p.rid}`,
      () => `EcoEditions: edition ${x.edition} (+${x.restEdition}), ${usd(B(x.allocation))}, turn ${date(N(x.turn))}, stream ${x.stream}, sold ${x.sold}, released ${x.released}; replayed ${p.edition} (+${p.rest}), ${usd(p.alloc)}, ${date(p.turn)}, ${p.stream}, ${p.sold}, ${p.released}`);
  });

  // the supply identity (Model 4 §10): every part as the events give it, summing to 320,000,000 exactly
  const [sp, supply, mp, mg, mr] = await Promise.all([rd("lens", "supply"), rd("tree", "totalSupply"),
    rd("tree", "mintedToPatrons"), rd("tree", "mintedToGuardians"), rd("tree", "mintedToReferrers")]);
  trSup.test(B(supply) === claimedEv && B(supply) === B(mp) + B(mg) + B(mr), "TREE", () => `supply ${usd(B(supply))}, claims ${usd(claimedEv)}, minted to the three parties ${usd(B(mp) + B(mg) + B(mr))}`);
  const room = edRoom[ed];
  const parts: [string, bigint, bigint][] = [
    ["unallocated", B(sp.unallocated), BigInt(LAST_EDITION - ed) * PER_EDITION], ["open room", B(sp.openRoom), ladderFull ? 0n : room],
    ["room after 32", B(sp.roomAfter32), ladderFull ? room : 0n], ["placed, not active", B(sp.placedOpen), placedOpenEv],
    ["unstreamed", B(sp.unstreamed), unstreamedEv], ["owed", B(sp.owed), releasedEv - claimedEv], ["minted", B(sp.minted), claimedEv],
    ["records and gems", B(sp.held), poolEv], ["committed", B(sp.committed), committedEv],
  ];
  for (const [what, chain, ev] of parts) brk.test(chain === ev, what, () => `the chain has ${usd(chain)}, the events give ${usd(ev)}`);
  const sum = parts.reduce((x, p) => x + p[1], 0n), sumEv = parts.reduce((x, p) => x + p[2], 0n);
  brk.test(sum === MAX_SUPPLY && sumEv === MAX_SUPPLY, "320,000,000", () => `the chain's parts sum to ${usd(sum)}, the events' to ${usd(sumEv)}`);
  // what is claimable counts what has streamed and not yet settled; owed is what has been released (C9)
  brk.test(B(sp.owed) === claimable - pendingNow, "owed", () => `owed ${usd(B(sp.owed))}; the covenants have ${usd(claimable)} claimable, ${usd(pendingNow)} of it not yet settled`);
  observations.tr3 = Object.fromEntries(parts.map(([k, v]) => [k, usd(v)]));
  observations.editions = {
    open: ed, ladderFull, reservations: E("editions.Reserved").length, queued: E("editions.Queued").length,
    bySignup: E("editions.Queued").filter((e) => e.a.bySignup).length, placed: E("editions.Placed").length,
    straddled: E("editions.Placed").filter((e) => N(e.a.restEdition) !== 0).length, passedOver: E("editions.PassedOver").length,
    released: E("editions.Released").length, sold: E("editions.Sold").length,
    roomReturned: Object.fromEntries(["released", "earlyEnd", "endHold", "noWeight", "pairCap"].map((k, i) => [k, usd(E("editions.RoomReturned").filter((e) => N(e.a.source) === i).reduce((x, e) => x + B(e.a.amount), 0n))])),
    placedLate: [...places.values()].filter((p) => p.stale).length,
    assignedByHolders: E("parties.VerifierAssigned").length, rejectionsFiled: E("parties.RequestRejected").length,
    rejected: E("registry.RequestEnded").filter((e) => N(e.a.reason) === 11).length,
    placedInEdition: Object.fromEntries(Array.from({ length: Math.max(ed, 1) }, (_, i) => [i + 1, usd(edPlaced[i + 1])]).filter(([, v]) => v !== "0")),
  };
}

// the records, gems and stones: the replay against EcoOvercharge now
{
  const [tw, di, pool, committed] = await Promise.all([rd("overcharge", "totalWeight"), rd("overcharge", "dropIndex"), rd("overcharge", "pool"), rd("overcharge", "committed")]);
  recC.test(B(tw) === totalW && B(di) === dropIdx && B(pool) === poolEv, "the ledger",
    () => `EcoOvercharge: weight ${usd(B(tw))}, index ${di}, ${usd(B(pool))} held; replayed ${usd(totalW)}, ${dropIdx}, ${usd(poolEv)}`);
  stoneC.test(B(committed) === committedEv, "the ledger", () => `EcoOvercharge: ${usd(B(committed))} committed; replayed ${usd(committedEv)}`);
  const lands = [...recs.keys()];
  const [recNow, landNow] = await Promise.all([Promise.all(lands.map((tid) => rd("overcharge", "record", [tid]))), Promise.all(lands.map((tid) => rd("overcharge", "landOf", [tid])))]);
  let held = 0n;
  lands.forEach((tid, i) => {
    const r = recs.get(tid)!, x = recNow[i], bal = r.balance + (r.weight * (dropIdx - r.index)) / INDEX;
    held += bal;
    recC.test(N(x.state) === r.state && N(x.n) === r.n && N(x.releases) === r.releases && B(x.weight) === r.weight && B(x.allocation) === r.alloc
      && B(x.balance) === bal && B(x.minted) === r.minted, R(tid),
      () => `EcoOvercharge: state ${x.state}, releases ${x.releases}/${x.n}, weight ${usd(B(x.weight))}, A' ${usd(B(x.allocation))}, ${usd(B(x.balance))}, minted ${usd(B(x.minted))}; replayed ${r.state}, ${r.releases}/${r.n}, ${usd(r.weight)}, ${usd(r.alloc)}, ${usd(bal)}, ${usd(r.minted)}`);
    const L_ = landsS.get(tid), y = landNow[i];
    if (L_) stoneC.test(B(y.room) === L_.room && B(y.roomUsed) === L_.roomUsed && B(y.committed) === L_.committed && B(y.instalment) === L_.instalment
      && B(y.left) === L_.left && B(y.carry) === L_.carry, R(tid),
      () => `EcoOvercharge: room ${usd(B(y.room))}, used ${usd(B(y.roomUsed))}, committed ${usd(B(y.committed))}, instalment ${usd(B(y.instalment))}, left ${usd(B(y.left))}, carry ${usd(B(y.carry))}; replayed ${usd(L_.room)}, ${usd(L_.roomUsed)}, ${usd(L_.committed)}, ${usd(L_.instalment)}, ${usd(L_.left)}, ${usd(L_.carry)}`);
  });
  // every stone in every land
  const set = lands.flatMap((tid) => (landsS.get(tid)?.ids ?? []).map((id) => [tid, id] as const));
  const stNow = await Promise.all(set.map(([tid, id]) => rd("overcharge", "stoneOf", [tid, id])));
  set.forEach(([tid, id], i) => {
    const s = landsS.get(tid)!.st.get(id)!, x = stNow[i];
    stoneC.test(!!x.set && B(x.unpaid) === s.unpaid && B(x.instalment) === s.instalment, `${R(tid)}, gem ${id}`,
      () => `EcoOvercharge: unpaid ${usd(B(x.unpaid))}, instalment ${usd(B(x.instalment))}; replayed ${usd(s.unpaid)}, ${usd(s.instalment)}`);
  });
  // what came back to the stones, transaction by transaction
  for (const k of new Set([...carriedWant.keys(), ...carriedEv.keys()])) {
    const want = carriedWant.get(k) ?? 0, got = carriedEv.get(k) ?? 0, [tx, id, amt] = k.split("|");
    stoneC.test(want === got, `gem ${id}`, () => `${got} Carried of ${usd(BigInt(amt))} in ${tx.slice(0, 12)}; the replay gives ${want}`);
  }
  // every gem
  const gids = [...gemsL.keys()];
  const [gNow, oNow] = await Promise.all([Promise.all(gids.map((id) => rd("overcharge", "gem", [id]))),
    Promise.all(gids.map((id) => rd("overcharge", "ownerOf", [id]).catch(() => Z)))]);
  let gemTotal = 0n;
  gids.forEach((id, i) => {
    const g = gemsL.get(id)!, x = gNow[i];
    gemTotal += g.balance;
    gemC.test(N(x.edition) === (g.burned ? N(x.edition) : g.edition) && N(x.half) === (g.burned ? N(x.half) : g.half) && B(x.balance) === g.balance
      && B(x.land) === (g.burned ? B(x.land) : g.land) && N(x.release) === (g.burned ? N(x.release) : g.release) && N(x.openLands) === g.open
      && L(oNow[i]) === (g.burned ? Z : gemOwner.get(id) ?? Z), `gem ${id}`,
      () => `EcoOvercharge: edition ${x.edition}, half ${x.half}, release ${x.release}, land ${x.land}, ${usd(B(x.balance))} carats, open in ${x.openLands}, owner ${short(oNow[i])}; replayed ${g.edition}, ${g.half}, ${g.release}, ${g.land}, ${usd(g.balance)}, ${g.open}, ${short(g.burned ? Z : gemOwner.get(id) ?? Z)}`);
    gemC.test(g.balance <= CARAT_CAP, `gem ${id}`, () => `${usd(g.balance)} carats`);
  });
  // the records and gems hold all of the pool, but the index's dust
  recC.test(held + gemTotal <= poolEv && poolEv - held - gemTotal <= BigInt(recs.size + E("overcharge.Drop").length + 2), "the ledger",
    () => `the records hold ${usd(held)} and the gems ${usd(gemTotal)}, of ${usd(poolEv)} (dust ${poolEv - held - gemTotal} wei)`);
  observations.records = {
    records: recs.size, drops: E("overcharge.Drop").length, dropped: usd(droppedEv), paused: E("overcharge.RecordPaused").length,
    shattered: E("overcharge.RecordShattered").length, pairs: E("overcharge.GemsReleased").filter((e) => B(e.a.amount) > 0n).length,
    toGems: usd(E("overcharge.GemsReleased").reduce((x, e) => x + B(e.a.amount), 0n)),
    pairExcessToRoom: usd(E("overcharge.GemsReleased").reduce((x, e) => x + B(e.a.toRoom), 0n)),
  };
  observations.gems = {
    gems: gids.length, fused: E("overcharge.Transmuted").length, stonesSet: E("overcharge.Overcharged").length,
    landsOvercharged: new Set(E("overcharge.Overcharged").map((e) => String(e.a.target))).size,
    committed: usd(E("overcharge.Overcharged").reduce((x, e) => x + B(e.a.commitment), 0n)),
    paid: usd(E("tree.OverchargeReleased").reduce((x, e) => x + B(e.a.amount), 0n)),
    carriedBack: usd(E("overcharge.Carried").reduce((x, e) => x + B(e.a.amount), 0n)), released: releaseTx.size,
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
  const dep = check("deployment-matches-config", "Configuration", "Every value the contracts were deployed with is the one the configuration asked for: each timing and clock, V, the fee split, the edition scale, every country's settings and fees, and every flow", "The setup screen; src/deploy.ts");
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
      && B(e.fees.baseFee) === BigInt(c.baseFee) * USD
      && B(e.fees.powerFee) === BigInt(c.powerFee) * USD && B(e.fees.agreementFee) === BigInt(c.agreementFee) * USD
      && B(e.fees.registrationFixed) === BigInt(c.registrationFixed) * USD && B(e.fees.registrationPerHa) === BigInt(c.registrationPerHa) * USD,
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
  const c = check("balances-now", "Money", "Now: the Registry, EcoDeeds, the Market (settling prices and live auctions' top bids), the Bank and EcoChallenge each hold exactly what their records say", "The simulator's invariants 1-3");
  const bal = (a: string) => rd("usdt", "balanceOf", [a]).then(B);
  let reg = 0n, deeds = 0n, market = 0n, bank = 0n, pool = 0n;
  for (const x of reqNow) reg += B(x.verifierShare) + B(x.attestationFee) + B(x.judgmentFee);
  for (const f of feesNow) deeds += B(f.power) + B(f.agreement) + B(f.registration);
  const settling = await Promise.all(tids.map(async (tid) => (await rd("market", "inSettlement", [tid])) ? B((await rd("market", "getSettlement", [tid])).price) : 0n));
  for (const s of settling) market += s;
  // and each live auction's escrowed top bid (decided 17 Oct)
  const tops = await Promise.all(tids.map(async (tid) => (await rd("market", "hasAuction", [tid])) ? B((await rd("market", "getAuction", [tid])).highestBid) : 0n));
  for (const s of tops) market += s;
  for (const x of covNow) { bank += B(x.a.balance); pool += x.pool; }
  const heldFor = [...new Set(E("bank.HolderFeeHeld").map((e) => L(e.a.holder)))];
  for (const h of heldFor) bank += B(await rd("bank", "heldForSuccessor", [h]));
  const [b1, b2, b3, b4, b5] = await Promise.all([bal(addr.registry), bal(addr.market), bal(addr.bank), bal(addr.challenge), bal(addr.deeds)]);
  c.test(b1 === reg, "Registry", () => `holds ${usd(b1)}, records ${usd(reg)}`);
  c.test(b5 === deeds, "EcoDeeds", () => `holds ${usd(b5)}, records ${usd(deeds)}`);
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
verifierShareOfPriceOnCompletedTerms: verifierSummary.terms ? (verifierSummary.share / verifierSummary.terms).toFixed(5) : "none",
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
    "CovenantCancelled", "CovenantClosedEarly", "SaleLapsed", "Sold", "Placed", "PassedOver", "GemsReleased", "Overcharged", "Transmuted", "RecordPaused", "RewardClaimed", "EditionOpened",
    "ProposalExecuted", "CountryVoteExecuted", "EmergencyFreeze", "FeePaid", "FeesRefunded", "StaleSaleCancelled", "AccessionLapsed"].map((n) => [n, count(n)])),
  failedBy: Object.entries(failed.reduce((m, f) => { const k = `${f.to}.${f.fn}${f.expected ? " (expected)" : ""}`; m[k] = (m[k] ?? 0) + 1; return m; }, {} as Record<string, number>)),
  observations, configuration: { ...cfg, defaultBaseFee: usd(defaultV0), editionScale: N(editionScale) },
  checks: checks.map((c) => ({ ...c, failures: c.failures.slice(0, 40), failureCount: c.failures.length })),
};
writeFileSync(new URL("audit.json", OUT), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(observations));
for (const c of checks) console.log(`${c.failures.length ? "FAIL" : "ok  "}  ${c.id.padEnd(26)} ${String(c.checked).padStart(6)} checked  ${c.failures.length} failed${c.failures.length ? `   e.g. ${c.failures[0].ref}: ${c.failures[0].detail}` : ""}`);
const failing = checks.filter((c) => c.failures.length).length;
console.log(`${checks.length} checks, ${checks.length - failing} held, ${failing} failed`);
