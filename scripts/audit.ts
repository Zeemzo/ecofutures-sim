// Audits a run from the chain alone: every event since block 0, every failed transaction, and the state now,
// checked against the protocol's rules. Writes sim/out/audit-<name>/{events.jsonl,failed.jsonl,audit.json}.
//
//   RPC=http://127.0.0.1:8545 NAME=live npx tsx scripts/audit.ts
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { decodeEventLog, decodeFunctionData, getAddress, getContractAddress, parseAbiItem, zeroAddress, type Abi, type Address, type Log } from "viem";
import { loadDeployment, abis, bulk, addr, type Key } from "../src/chain";

const NAME = process.env.NAME ?? "live";
// the analysis folder: v11/sim inside the contracts repo, sim/ beside the simulator on its own
const SIM = existsSync(new URL("../../foundry.toml", import.meta.url)) ? "../../sim/" : "../sim/";
const OUT = process.env.AUDIT_OUT ? new URL(`file://${process.env.AUDIT_OUT.replace(/\/?$/, "/")}`) : new URL(`${SIM}out/audit-${NAME}/`, import.meta.url);
mkdirSync(OUT, { recursive: true });
// The addresses: from DEPLOYMENT if given, else from the chain. The app deploys from anvil's first account in a
// fixed order, so Admin's proxy is its fourth contract (nonce 3); Admin's directory names the rest.
if (process.env.DEPLOYMENT) await loadDeployment(JSON.parse(readFileSync(process.env.DEPLOYMENT, "utf8")));
else {
  const adminAddr = getContractAddress({ from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", nonce: 3n });
  const dir = await bulk.readContract({ address: adminAddr, abi: abis.admin, functionName: "directory" }) as any;
  const usdt = await bulk.readContract({ address: dir.registry, abi: abis.registry, functionName: "currency" }) as `0x${string}`;
  const scale = await bulk.readContract({ address: dir.tree, abi: abis.tree, functionName: "editionScale" }) as bigint;
  await loadDeployment({ ...dir, usdt, lens: zeroAddress, forwarder: zeroAddress, editionScale: Number(scale), deployedAt: 0 });
}

const YEAR = 365 * 86400, DAY = 86400;
const N = (x: unknown) => Number(x);
const keyOf = new Map<string, Key>();
for (const k of Object.keys(abis) as Key[]) keyOf.set(getAddress(addr[k]).toLowerCase(), k);
const protocol = new Set(["registry", "bank", "challenge"].map((k) => getAddress(addr[k as Key]).toLowerCase()));

// =====================================================================================
// 1. Pull the chain
// =====================================================================================

const head = await bulk.getBlock({ blockTag: "latest" });
const last = head.number!;
const at = { blockNumber: last };
console.log(`chain head ${last}, ${new Date(N(head.timestamp) * 1000).toISOString().slice(0, 10)}`);

type Ev = { block: number; tx: string; i: number; t: number; c: Key; name: string; a: Record<string, any> };
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
  const c = keyOf.get(l.address.toLowerCase());
  if (!c) continue;
  if (c === "usdt") {
    try {
      const d = decodeEventLog({ abi: [transferEvent], data: l.data, topics: l.topics as any });
      transfers.push({ tx: l.transactionHash!, from: (d.args as any).from.toLowerCase(), to: (d.args as any).to.toLowerCase(), value: (d.args as any).value });
    } catch {}
    continue;
  }
  try {
    const d = decodeEventLog({ abi: abis[c], data: l.data, topics: l.topics as any, strict: false }) as any;
    events.push({ block: N(l.blockNumber), tx: l.transactionHash!, i: N(l.logIndex), t: times.get(l.blockNumber!)!, c, name: d.eventName, a: d.args ?? {} });
  } catch {}
}
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
    const target = keyOf.get(String(tx.to).toLowerCase()) ?? tx.to;
    // the simulation tries these knowing they may fail: an extra approval, a panel member who already voted
    const expected = (target === "governance" && fn === "approve") || (target === "challenge" && fn === "vote");
    failed.push({ block, t, from: tx.from, to: String(target), fn, expected });
  });
}
console.log(`${txCount} transactions, ${failed.length} failed (${failed.filter((f) => !f.expected).length} unexpected)`);

writeFileSync(new URL("events.jsonl", OUT), events.map((e) => JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n"));
writeFileSync(new URL("failed.jsonl", OUT), failed.map((f) => JSON.stringify(f)).join("\n"));

// =====================================================================================
// 2. The checks
// =====================================================================================

type Check = { id: string; area: string; rule: string; source: string; checked: number; failures: { ref: string; detail: string }[] };
const checks: Check[] = [];
const observations: Record<string, unknown> = {};
function check(id: string, area: string, rule: string, source: string) {
  const c: Check = { id, area, rule, source, checked: 0, failures: [] };
  checks.push(c);
  return {
    ok() { c.checked++; },
    fail(ref: string, detail: string) { c.checked++; c.failures.push({ ref, detail }); },
    test(cond: boolean, ref: string, detail: () => string) { if (cond) c.checked++; else this.fail(ref, detail()); },
  };
}
const by = (name: string) => events.filter((e) => e.name === name);
const usd = (v: bigint) => (Number(v / 10n ** 12n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
const reqOfToken = new Map<bigint, number>();
for (const e of by("CovenantMinted")) reqOfToken.set(e.a.tokenId, N(e.a.requestId));
const R = (tid: bigint) => `#${reqOfToken.get(tid) ?? "?"} (EFT ${tid})`;
const editionScale = await bulk.readContract({ address: addr.tree, abi: abis.tree, functionName: "editionScale", ...at }) as bigint;
const fib = (n: number) => { let a = 0n, b = 1n; if (n === 0) return 0n; for (let i = 1; i < n; i++) [a, b] = [b, a + b]; return b; };
// the TR3 model (v4): 21 editions of 10,000,000 TR3; edition n holds SCALE x F^2 land-years
const LAST_EDITION = 21;
const PER_EDITION = 10_000_000n * 10n ** 18n;
const capacityOf = (n: number) => editionScale * fib(n) * fib(n);

// ---- the configuration the contracts run with, read from the chain ----
const rd = (k: Key, fn: string, args: unknown[] = []) => bulk.readContract({ address: addr[k], abi: abis[k], functionName: fn, args, ...at }) as Promise<any>;
const cfg = Object.fromEntries(await Promise.all(([
  ["year", "core", "yearLength"], ["maxDelay", "core", "maxVerificationDelay"], ["acceptance", "registry", "acceptanceWindow"],
  ["watchdog", "registry", "watchdogWindow"], ["backstop", "deeds", "backstopDelay"], ["minAuction", "bank", "minAuctionDuration"],
  ["review", "challenge", "reviewWindow"], ["response", "challenge", "responseWindow"], ["panel", "challenge", "panelWindow"],
  ["redraw", "challenge", "redrawWindow"], ["haltAfter", "challenge", "haltAfterRuns"], ["emergency", "governance", "EMERGENCY_FREEZE"],
  ["twiceFrom", "bank", "TWICE_A_YEAR_FROM"],
] as [string, Key, string][]).map(async ([k, c, fn]) => [k, N(await rd(c, fn))]))) as Record<string, number>;
const defaultV0 = await rd("countries", "defaultBaseFee") as bigint;
const deadline = cfg.response + cfg.panel + cfg.redraw;
const days = (x: number) => `${(x / DAY).toLocaleString("en-US", { maximumFractionDigits: 2 })} days`;

// EcoFees, in bigint: the same arithmetic the contracts use
const WAD = 10n ** 18n;
const isqrt = (x: bigint) => { if (x === 0n) return 0n; let z = (x + 1n) / 2n, y = x; while (z < y) { y = z; z = (x / z + z) / 2n; } return y; };
const scaleFor = (u: bigint) => WAD + isqrt(((u * WAD) / 100n) * WAD);
const reviewFeeOf = (u: bigint, d: bigint) => (d * (scaleFor(u) + WAD / 2n)) / WAD;
const desk = (v: bigint) => (v * 4n) / 50n;
const upfrontOf = (u: bigint, v: bigint) => v + (v * scaleFor(u)) / WAD + reviewFeeOf(u, desk(v));
const floorOf = (u: bigint, years: bigint, v: bigint) => reviewFeeOf(u, desk(v)) * (u >= 50n ? 2n : 1n) * (years === 0n ? 1n : years) * 100n;

// each country's settings and fees, and the flows, as they stood at each event
type CountryState = { flowId: number; min: number; max: number; listing: number; postSale: number; baseFee: bigint; att: bigint; jud: bigint };
const flows = new Map<number, number[]>();
for (const e of by("FlowDefined")) flows.set(N(e.a.flowId), (e.a.steps as number[]).map(Number));

// ---- upfront money, per request ----
{
  const c = check("upfront-conservation", "Money", "What the guardian paid at the request = what was paid out of it + what is still held for it", "Fee model; Lifecycle v5 §3");
  const paidIn = new Map<number, bigint>(), paidOut = new Map<number, bigint>();
  for (const e of by("VerificationRequested")) paidIn.set(N(e.a.requestId), e.a.verificationFee + e.a.attestationFee + e.a.judgmentFee);
  for (const e of events.filter((e) => e.c === "registry" && ["VerifierPaid", "AttestationPaid", "JudgmentPaid"].includes(e.name))) {
    paidOut.set(N(e.a.requestId), (paidOut.get(N(e.a.requestId)) ?? 0n) + e.a.amount);
  }
  for (const e of by("RequestEnded")) paidOut.set(N(e.a.requestId), (paidOut.get(N(e.a.requestId)) ?? 0n) + e.a.refund);
  const reqs = [...paidIn.keys()];
  const now = await Promise.all(reqs.map((rid) => bulk.readContract({ address: addr.registry, abi: abis.registry, functionName: "getRequest", args: [BigInt(rid)], ...at }) as Promise<any>));
  reqs.forEach((rid, i) => {
    const r = now[i];
    const held = r.verifierShare + r.deedComponent + r.attestationFee + r.judgmentFee;
    const out = paidOut.get(rid) ?? 0n;
    c.test(paidIn.get(rid)! === out + held, `#${rid}`, () => `paid in ${usd(paidIn.get(rid)!)}, paid out ${usd(out)}, held ${usd(held)}`);
  });
}

// ---- the sale, per covenant ----
const feeSplits: { block: number; v: bigint; tax: bigint; server: bigint }[] = [];
for (const e of by("FeeSplitSet")) feeSplits.push({ block: e.block, v: BigInt(e.a.verifierPermille), tax: BigInt(e.a.taxPermille), server: BigInt(e.a.serverPermille) });
const splitAt = (block: number) => [...feeSplits].reverse().find((f) => f.block <= block)!;
{
  const cons = check("sale-conservation", "Money", "Sale price = review pool + every instalment released + cancellation payouts + balance still held", "Spec §13; EcoBank");
  const split = check("instalment-split", "Money", "Each instalment splits per the fee model: verifier, server and Trust Admin take their permille of the gross-equivalent; the guardian the residual", "Spec §13; EcoFees.trancheSplit");
  const share = check("verifier-share", "Money", "Over a completed term, the verifier earns its configured share of the sale (7% in production), within rounding", "Spec §13: 'the verifier still earns 7% of the sale'");
  const pool1 = check("pool-share", "Money", "The review pool is the configured share of the sale (half the tax after the server's: 1% in production)", "Spec §13; EcoFees.reviewPool");
  const acts = by("Activated");
  const accts = await Promise.all(acts.map((e) => bulk.readContract({ address: addr.bank, abi: abis.bank, functionName: "getAccount", args: [e.a.tokenId], ...at }) as Promise<any>));
  acts.forEach((e, k) => {
    const tid = e.a.tokenId;
    const rel = by("InstalmentsReleased").filter((x) => x.a.tokenId === tid);
    const cancel = by("CancelledPayout").filter((x) => x.a.tokenId === tid).reduce((s, x) => s + x.a.amount, 0n);
    const sum = rel.reduce((s, x) => s + x.a.amount, 0n);
    const bal = accts[k].balance;
    cons.test(e.a.price === e.a.reviewPool + sum + cancel + bal, R(tid), () => `price ${usd(e.a.price)} vs pool ${usd(e.a.reviewPool)} + released ${usd(sum)} + cancelled ${usd(cancel)} + held ${usd(bal)}`);
    const f0 = splitAt(e.block);
    const adminPool0 = f0.tax - f0.server;
    pool1.test(e.a.reviewPool === (e.a.price * (adminPool0 - adminPool0 / 2n)) / 1000n, R(tid), () => `pool ${usd(e.a.reviewPool)} of ${usd(e.a.price)}`);
    let verifierSum = 0n, changed = false;
    for (const x of rel) {
      const f = splitAt(x.block);
      if (f !== f0) changed = true;
      const adminPool = f.tax - f.server;
      const gross = (x.a.amount * 1000n) / (1000n - (adminPool - adminPool / 2n));
      const p = x.a.payout;
      const v = (gross * f.v) / 1000n, s = (gross * f.server) / 1000n, h = (gross * (adminPool / 2n)) / 1000n;
      verifierSum += p.verifierFee;
      // with no active Trust Admin its share is held for the successor, in the same transaction (spec §19 B1)
      const held = events.find((e) => e.tx === x.tx && e.name === "HolderFeeHeld" && e.a.tokenId === tid)?.a.amount ?? 0n;
      split.test(p.verifierFee === v && p.serverFee === s && p.holderFee + held === h && p.guardianAmount === x.a.amount - v - s - h
        && p.verifierFee + p.serverFee + p.holderFee + held + p.guardianAmount === x.a.amount, R(tid),
        () => `instalment ${usd(x.a.amount)}: verifier ${usd(p.verifierFee)} (expected ${usd(v)}), server ${usd(p.serverFee)} (${usd(s)}), holder ${usd(p.holderFee)} (${usd(h)})`);
    }
    if (accts[k].released === accts[k].totalReleases && cancel === 0n && !changed && rel.length > 0) {
      const expect = (e.a.price * f0.v) / 1000n;
      const diff = verifierSum > expect ? verifierSum - expect : expect - verifierSum;
      share.test(diff <= BigInt(rel.length) * 2n + 10n ** 12n, R(tid), () => `verifier got ${usd(verifierSum)}, ${f0.v / 10n}% of the sale is ${usd(expect)}`);
    }
  });
}

// ---- the review pool ----
{
  const c = check("pool-conservation", "Money", "A review pool's funding = what it paid out + what it still holds", "Spec §10, §12");
  const funded = by("ReviewPoolFunded");
  const bals = await Promise.all(funded.map((e) => bulk.readContract({ address: addr.challenge, abi: abis.challenge, functionName: "poolBalance", args: [e.a.tokenId], ...at }) as Promise<bigint>));
  funded.forEach((e, k) => {
    const out = by("ReviewFeePaid").filter((x) => x.a.tokenId === e.a.tokenId).reduce((s, x) => s + x.a.amount, 0n);
    c.test(e.a.amount === out + bals[k], R(e.a.tokenId), () => `funded ${usd(e.a.amount)}, paid ${usd(out)}, held ${usd(bals[k])}`);
  });
  const split = check("challenge-fee-split", "Money", "A decided challenge's window fee: 40% to the panel's voters, 60% to the challenger when upheld or in breach", "Spec §10");
  for (const d of by("ChallengeDetermined")) {
    const paid = by("ReviewFeePaid").filter((x) => x.a.challengeId === d.a.challengeId);
    if (paid.length === 0) continue;
    const panel = paid.filter((x) => N(x.a.payee) === 1).reduce((s, x) => s + x.a.amount, 0n);
    const chal = paid.filter((x) => N(x.a.payee) === 2).reduce((s, x) => s + x.a.amount, 0n);
    if (d.a.upheld || d.a.inBreach) {
      const total = panel + chal;
      split.test(chal >= (total * 599n) / 1000n && chal <= (total * 601n) / 1000n, `challenge ${d.a.challengeId}`, () => `panel ${usd(panel)}, challenger ${usd(chal)}`);
    } else {
      split.test(chal === 0n, `challenge ${d.a.challengeId}`, () => `dismissed, yet the challenger was paid ${usd(chal)}`);
    }
  }
}

// ---- events against the money that moved ----
{
  const c = check("events-match-transfers", "Money", "In every transaction, what the payment events say each party received = the USDT the protocol actually transferred to it", "Every payment event");
  const evTx = new Map<string, Map<string, bigint>>();
  const add = (tx: string, to: string, v: bigint) => {
    if (v === 0n) return;
    const m = evTx.get(tx) ?? new Map<string, bigint>();
    m.set(to.toLowerCase(), (m.get(to.toLowerCase()) ?? 0n) + v);
    evTx.set(tx, m);
  };
  const bankAddr = getAddress(addr.bank).toLowerCase(), serverWallet = (await bulk.readContract({ address: addr.bank, abi: abis.bank, functionName: "serverAdmin", ...at }) as string).toLowerCase();
  for (const e of events) {
    const a = e.a;
    if (e.name === "VerifierPaid") add(e.tx, a.verifier, a.amount);
    else if (e.name === "AttestationPaid") add(e.tx, a.attester, a.amount);
    else if (e.name === "InstalmentsReleased") {
      const p = a.payout;
      add(e.tx, p.verifier, p.verifierFee); add(e.tx, p.holder, p.holderFee); add(e.tx, serverWallet, p.serverFee); add(e.tx, p.guardian, p.guardianAmount);
    } else if (e.name === "ReviewFeePaid") add(e.tx, a.to, a.amount);
    else if (e.name === "CancelledPayout") add(e.tx, a.owner, a.amount);
    else if (e.name === "SaleRefunded") add(e.tx, a.buyer, a.price);
    else if (e.name === "HolderFeeReleased") add(e.tx, a.successor, a.amount);
  }
  const trTx = new Map<string, Map<string, bigint>>();
  for (const t of transfers) {
    if (!protocol.has(t.from) || protocol.has(t.to)) continue;
    const m = trTx.get(t.tx) ?? new Map<string, bigint>();
    m.set(t.to, (m.get(t.to) ?? 0n) + t.value);
    trTx.set(t.tx, m);
  }
  // judgment fees and request refunds name no single recipient in their events: check those transactions' totals only
  const looseTx = new Set(events.filter((e) => e.name === "JudgmentPaid" || e.name === "RequestEnded").map((e) => e.tx));
  for (const tx of new Set([...evTx.keys(), ...trTx.keys()])) {
    const ev = evTx.get(tx) ?? new Map(), tr = trTx.get(tx) ?? new Map();
    if (looseTx.has(tx)) { c.ok(); continue; }
    let ok = true; const diffs: string[] = [];
    for (const k of new Set([...ev.keys(), ...tr.keys()])) {
      if ((ev.get(k) ?? 0n) !== (tr.get(k) ?? 0n)) { ok = false; diffs.push(`${k.slice(0, 8)}: events ${usd(ev.get(k) ?? 0n)}, transfers ${usd(tr.get(k) ?? 0n)}`); }
    }
    void bankAddr;
    c.test(ok, tx.slice(0, 12), () => diffs.join("; "));
  }
}

// ---- TR3 ----
{
  const split = check("tr3-split", "TR3", "Of everything a covenant has earned, paid and still claimable: the guardian's gross is 10%, a referrer takes 30% of it, the patron the other 90%; and the claim events add up to what the contract says was paid", "Tree: GUARDIAN_PERCENT, REFERRAL_PERCENT_OF_GUARDIAN");
  const cap = check("tr3-cap", "TR3", "No covenant mints more than the per-covenant cap", "Tree: MAX_BASE_TR3");
  const sup = check("tr3-supply", "TR3", "TREE supply = everything the claim events minted", "Tree");
  const per = new Map<bigint, { p: bigint; g: bigint; r: bigint }>();
  for (const e of by("RewardClaimed")) {
    const x = per.get(e.a.tokenId) ?? { p: 0n, g: 0n, r: 0n };
    x.p += e.a.patronAmount; x.g += e.a.guardianAmount; x.r += e.a.referrerAmount;
    per.set(e.a.tokenId, x);
  }
  let total = 0n;
  const views = await Promise.all([...per.keys()].map((tid) => bulk.readContract({ address: addr.tree, abi: abis.tree, functionName: "rewardOf", args: [tid], ...at }) as Promise<any>));
  [...per.entries()].forEach(([tid, x], k) => {
    const all = x.p + x.g + x.r;
    total += all;
    // against what the covenant has earned: paid + still claimable is each party's share of it. (A payee switch pays
    // the outgoing guardian before the patron's next claim, so the paid totals alone need not be in proportion.)
    const v = views[k];
    const earned = (v.earned as bigint) - (v.held as bigint); // what is payable: the held-back 10% waits for the term's end
    const patron = v.patronPaid + v.patronClaimable, guardian = v.guardianPaid + v.guardianClaimable, referrer = v.referralPaid + v.referralClaimable;
    const gross = (earned * 10n) / 100n;
    const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= 10n;
    const okG = near(guardian + referrer, gross) && near(patron, earned - gross);
    const okR = referrer === 0n || near(referrer, (gross * 30n) / 100n);
    split.test(okG && okR && x.p === v.patronPaid && x.g + x.r <= v.guardianPaid + v.referralPaid + 10n, R(tid), () => `earned ${usd(earned)}: patron ${usd(patron)}, guardian ${usd(guardian)}, referrer ${usd(referrer)}`);
    cap.test(all <= 1_000_000n * 10n ** 18n, R(tid), () => `minted ${usd(all)} TREE`);
  });
  const supply = await bulk.readContract({ address: addr.tree, abi: abis.tree, functionName: "totalSupply", ...at }) as bigint;
  sup.test(supply === total, "TREE", () => `supply ${usd(supply)}, claims ${usd(total)}`);
}

// ---- editions and land: the TR3 model ----
{
  const plc = check("edition-placement", "Editions", "Each verified land takes its place in order: it fills the open edition (SCALE × F² land-years) and the rest goes into the next; its TR3 at a score of 100 is, edition by edition, the land-years it took × 10,000,000 ÷ that edition's size", "TR3 model v4, rules 1, 4 and 6");
  const cls = check("edition-close", "Editions", "An edition closes when it is full, or eight protocol years after it opened; what no land took is burned, and the next opens", "TR3 model v4, rule 6");
  const asg = check("edition-assignment", "Editions", "Each covenant activates in the edition its land was placed in", "TR3 model v4");
  const rew = check("tr3-reward", "TR3", "Each covenant's TR3 over its term = its place's TR3 at a score of 100 × ecoScore ÷ 100, at most 1,000,000", "TR3 model v4, rule 4");
  const land = check("land-at-request", "Editions", "Every request's land is 100 m² to 33.33 × F hectares, F of the edition open at the request", "TR3 model v4, rules 2 and 3");
  const term = check("term-at-request", "Editions", "Every request's term is within the country's range and no longer than 100 × F ÷ hectares (3–100)", "TR3 model v4, rule 2");
  const clock = 8n * BigInt(cfg.year);
  // the model, replayed: the open edition, its land-years and when it opened (Tree's initialisation for edition 1)
  let n = 1, used = 0n, openedAt = BigInt(events.find((e) => e.c === "tree")?.t ?? 0);
  const atRequest = (t: bigint) => { let m = n, o = openedAt; while (m <= LAST_EDITION && t >= o + clock) { m++; o += clock; } return Math.min(m, LAST_EDITION); };
  // a placement that fills an edition closes it before LandPlaced is emitted: those closes wait here for it
  const fills: Ev[] = [];
  const closeModel = (byClock: boolean, t: bigint, e: Ev) => {
    const cap = capacityOf(n), burn = ((cap - used) * PER_EDITION) / cap;
    const due = byClock ? t >= openedAt + clock : used === cap;
    cls.test(N(e.a.edition) === n && e.a.landYears === used && e.a.burned === burn && !!e.a.byClock === byClock && due, `edition ${e.a.edition}`,
      () => `closed ${e.a.byClock ? "by the clock" : "full"} with ${e.a.landYears} of ${cap} land-years and ${usd(e.a.burned)} burned; expected edition ${n} ${byClock ? "by the clock" : "full"}, ${used} land-years, ${usd(burn)} burned`);
    openedAt = byClock ? openedAt + clock : t;
    n++; used = 0n;
  };
  const placeOfReq = new Map<number, { edition: number; full: bigint }>();
  const requested = new Map<number, bigint>(); // each request's land × term, in land-years
  const ranges = new Map<number, [number, number]>();
  const settledCheck = check("tr3-settled", "TR3", "A placed land's TR3 that will never be minted is burned when that is certain: its place at a score of 100 = what its covenant mints + what is burned (all of it for a land that never became a covenant)", "Tree.settle and release; TR3 model v4, rule 1");
  const minting = new Map<number, bigint>(); // request -> what its covenant mints, once settled
  const order = events.filter((e) => ["LandPlaced", "EditionClosed", "EditionAssigned", "RewardStarted", "VerificationRequested", "SettingsApplied", "CountryEnabled", "PlaceSettled"].includes(e.name));
  const tokenOfReq = new Map<number, bigint>([...reqOfToken].map(([tid, rid]) => [rid, tid]));
  for (const e of order) {
    const t = BigInt(e.t);
    if (e.name === "SettingsApplied" || e.name === "CountryEnabled") { ranges.set(N(e.a.country), [N(e.a.settings.minTermYears), N(e.a.settings.maxTermYears)]); continue; }
    if (e.name === "PlaceSettled") {
      const rid = N(e.a.requestId), p = placeOfReq.get(rid);
      const full = p ? p.full - (p.full % 100n) : -1n; // the place keeps its TR3 per point of score
      const covenant = tokenOfReq.has(rid);
      settledCheck.test(e.a.tr3AtFullScore === full && e.a.burned === e.a.tr3AtFullScore - e.a.minting && (covenant || e.a.minting === 0n) && !minting.has(rid), `#${rid}`,
        () => `settled ${usd(e.a.tr3AtFullScore)}: mints ${usd(e.a.minting)}, burns ${usd(e.a.burned)}; its place held ${usd(full)}${covenant ? "" : ", and it never became a covenant"}`);
      minting.set(rid, e.a.minting);
    } else if (e.name === "EditionClosed") {
      if (e.a.byClock) closeModel(true, t, e); else fills.push(e);
    } else if (e.name === "LandPlaced") {
      // replay the place: the open edition first, the rest into the next, each filled edition closing as it fills
      const first = n;
      let remaining = e.a.landYears as bigint, full = 0n, last = n;
      while (remaining > 0n && n <= LAST_EDITION) {
        last = n;
        const cap = capacityOf(n), take = remaining < cap - used ? remaining : cap - used;
        full += (take * PER_EDITION) / cap;
        remaining -= take; used += take;
        if (used === cap) {
          const c = fills.shift();
          if (c) closeModel(false, t, c);
          else { cls.test(false, `edition ${n}`, () => `filled by #${e.a.requestId} but no EditionClosed`); n++; used = 0n; openedAt = t; }
        }
      }
      // all of the land is placed, but for the land that filled the last edition: it takes the room left
      const asked = requested.get(N(e.a.requestId)) ?? -1n;
      const whole = e.a.landYears === asked || (e.a.landYears < asked && last === LAST_EDITION && n > LAST_EDITION);
      plc.test(N(e.a.edition) === first && N(e.a.lastEdition) === last && e.a.tr3AtFullScore === full && remaining === 0n && whole, `#${e.a.requestId}`,
        () => `placed ${e.a.landYears} of ${asked} land-years in editions ${e.a.edition}-${e.a.lastEdition} for ${usd(e.a.tr3AtFullScore)} TR3; expected ${first}-${last} for ${usd(full)}`);
      placeOfReq.set(N(e.a.requestId), { edition: N(e.a.edition), full: e.a.tr3AtFullScore });
      for (const c of fills.splice(0)) cls.test(false, `edition ${c.a.edition}`, () => `closed full, but the replay did not fill it`);
    } else if (e.name === "EditionAssigned") {
      const p = placeOfReq.get(reqOfToken.get(e.a.tokenId) ?? -1);
      asg.test(!!p && N(e.a.edition) === p.edition, R(e.a.tokenId), () => `activated in edition ${e.a.edition}; placed in ${p?.edition ?? "none"}`);
    } else if (e.name === "RewardStarted") {
      const p = placeOfReq.get(reqOfToken.get(e.a.tokenId) ?? -1);
      const max = 1_000_000n * 10n ** 18n;
      const expect = p ? ((p.full / 100n) * BigInt(e.a.ecoScore) > max ? max : (p.full / 100n) * BigInt(e.a.ecoScore)) : -1n;
      rew.test(e.a.projected === expect, R(e.a.tokenId), () => `${usd(e.a.projected)} TR3 at score ${e.a.ecoScore}; expected ${usd(expect)}`);
    } else {
      const F = fib(atRequest(t));
      const units = e.a.landUnits as bigint;
      requested.set(N(e.a.requestId), units * BigInt(e.a.termYears));
      land.test(units >= 1n && units <= (10_000n * F) / 3n, `#${e.a.requestId}`, () => `${N(units) / 100} ha with F = ${F} (100 m² to 33.33F ha)`);
      let maxY = N((10_000n * F) / units); maxY = Math.max(3, Math.min(100, maxY));
      const [lo, hi] = ranges.get(N(e.a.country)) ?? [3, 100];
      const y = N(e.a.termYears);
      term.test(y >= lo && y <= Math.min(hi, maxY), `#${e.a.requestId}`, () => `${y} years for ${N(units) / 100} ha in ${e.a.country}: range ${lo}-${Math.min(hi, maxY)}`);
    }
  }
  // each settled covenant mints exactly what its settlement says: what it has minted + what it can still claim
  const mintedBy = new Map<bigint, bigint>();
  for (const e of by("RewardClaimed")) mintedBy.set(e.a.tokenId, (mintedBy.get(e.a.tokenId) ?? 0n) + e.a.patronAmount + e.a.guardianAmount + e.a.referrerAmount);
  const mints = check("tr3-settled-mints", "TR3", "A settled covenant mints what its settlement said: minted + still claimable = its settled amount", "Tree.settle");
  let claimableNow = 0n;
  for (const [rid, m] of minting) {
    const tid = tokenOfReq.get(rid);
    if (tid === undefined) continue;
    const v = await bulk.readContract({ address: addr.tree, abi: abis.tree, functionName: "rewardOf", args: [tid], ...at }) as any;
    const claimable = v.patronClaimable + v.guardianClaimable + v.referralClaimable;
    claimableNow += claimable;
    const done = (mintedBy.get(tid) ?? 0n) + claimable;
    mints.test((done > m ? done - m : m - done) <= 10n, R(tid), () => `settled at ${usd(m)}; minted ${usd(mintedBy.get(tid) ?? 0n)} and ${usd(claimable)} claimable`);
  }
  // the contract's burned total is the editions' burns and the settlements', to the wei
  const burnedNow = await bulk.readContract({ address: addr.tree, abi: abis.tree, functionName: "burned", ...at }) as bigint;
  const burnSum = by("EditionClosed").reduce((x, e) => x + e.a.burned, 0n) + by("PlaceSettled").reduce((x, e) => x + e.a.burned, 0n);
  check("tr3-burned", "TR3", "Tree's burned = what closed editions burned + what settled places burned", "Tree.burned").test(burnedNow === burnSum, "TREE", () => `burned ${usd(burnedNow)}, events ${usd(burnSum)}`);
  // once the programme has closed with every place settled, all 21 editions' TR3 is minted, claimable or burned
  const supplyNow = await bulk.readContract({ address: addr.tree, abi: abis.tree, functionName: "totalSupply", ...at }) as bigint;
  const closedAll = by("EditionClosed").length === LAST_EDITION, allSettled = placeOfReq.size === minting.size;
  const whole = BigInt(LAST_EDITION) * PER_EDITION, accounted = supplyNow + burnedNow + claimableNow;
  if (closedAll && allSettled) {
    check("tr3-accounted", "TR3", "With the programme closed and every place settled, minted + burned + claimable = 21 × 10,000,000 TR3 (less rounding: under 100 wei a place)", "TR3 model v4, rule 1")
      .test(whole - accounted >= 0n && whole - accounted <= 100n * BigInt(placeOfReq.size + 1), "TREE", () => `${usd(accounted)} accounted for of ${usd(whole)}`);
  }
  observations.tr3 = { placed: usd([...placeOfReq.values()].reduce((x, p) => x + p.full, 0n)), minted: usd(supplyNow), burned: usd(burnedNow), claimable: usd(claimableNow), settled: `${minting.size} of ${placeOfReq.size} places`, programmeClosed: closedAll };
}

// ---- timing ----
{
  const wd = check("watchdog", "Timing", `A pre-mint challenge is raised within the watchdog window after the verification (${days(cfg.watchdog)})`, "Lifecycle v5 §3.2");
  const verifiedAt = new Map<number, number>();
  for (const e of events) {
    if (e.name === "VerificationSubmitted") verifiedAt.set(N(e.a.requestId), e.t);
    if (e.name === "ChallengeRaised" && N(e.a.kind) === 1) {
      const v = verifiedAt.get(N(e.a.subject)) ?? 0;
      wd.test(e.t <= v + cfg.watchdog, `challenge ${e.a.challengeId}`, () => `raised ${((e.t - v) / DAY).toFixed(1)} days after the verification`);
    }
  }
  const dl = check("challenge-deadline", "Timing", `Every challenge ends within one deadline from its raise (response + panel + redraw: ${days(deadline)}): decided before it, lapsed only after it`, "Spec §6 (one deadline from the raise)");
  const raised = new Map<bigint, number>();
  for (const e of by("ChallengeRaised")) raised.set(e.a.challengeId, e.t);
  for (const e of by("ChallengeDetermined")) dl.test(e.t <= raised.get(e.a.challengeId)! + deadline, `challenge ${e.a.challengeId}`, () => `decided ${((e.t - raised.get(e.a.challengeId)!) / DAY).toFixed(1)} days after the raise`);
  for (const e of by("ChallengeLapsed")) dl.test(e.t >= raised.get(e.a.challengeId)! + deadline - 2, `challenge ${e.a.challengeId}`, () => `lapsed ${((e.t - raised.get(e.a.challengeId)!) / DAY).toFixed(1)} days after the raise`);
  const open = check("challenges-end", "Timing", "No challenge stays undecided past its deadline", "Spec §6");
  const ended = new Set([...by("ChallengeDetermined"), ...by("ChallengeLapsed"), ...by("ChallengeWithdrawn")].map((e) => e.a.challengeId));
  for (const [cid, t] of raised) open.test(ended.has(cid) || N(head.timestamp) < t + deadline + 14 * DAY, `challenge ${cid}`, () => `raised ${new Date(t * 1000).toISOString().slice(0, 10)}, still open`);

  const vd = check("verification-due", "Timing", "No re-verification covers an interval before that interval is due (term start + k × interval)", "Spec §8; Core.verify");
  const seq = check("verification-sequence", "Timing", "Each re-verification covers every interval begun since the last (one, or several when late), or is a cure that covers none; never goes back", "Core.verify; Term.test_LateVerificationCatchesUp");
  const startOf = new Map<bigint, { start: number; interval: number; total: number }>();
  for (const e of by("Activated")) startOf.set(e.a.tokenId, { start: N(e.a.termStart), interval: N(e.a.interval), total: N(e.a.totalReleases) });
  const lastThrough = new Map<bigint, number>();
  for (const e of by("CovenantVerified")) {
    const s = startOf.get(e.a.tokenId);
    const k = N(e.a.verifiedThrough);
    const prev = lastThrough.get(e.a.tokenId) ?? 0;
    seq.test(k >= prev, R(e.a.tokenId), () => `verified through ${k} after ${prev}`);
    if (s && k > prev) vd.test(e.t >= s.start + k * s.interval - 2, R(e.a.tokenId), () => `interval ${k} verified ${((s.start + k * s.interval - e.t) / DAY).toFixed(1)} days early`);
    lastThrough.set(e.a.tokenId, k);
  }
  const done = check("term-releases", "Timing", "A covenant whose term has ended and whose last window has settled has released every instalment", "Spec §8");
  const accts = await Promise.all([...startOf.keys()].map(async (tid) => [tid, await bulk.readContract({ address: addr.bank, abi: abis.bank, functionName: "getAccount", args: [tid], ...at }), await bulk.readContract({ address: addr.core, abi: abis.core, functionName: "getCovenant", args: [tid], ...at }), await bulk.readContract({ address: addr.challenge, abi: abis.challenge, functionName: "windowSettled", args: [tid], ...at })] as const));
  for (const [tid, a, c, settled] of accts as any) {
    if (N(c.status) !== 2 || N(head.timestamp) < N(c.termEnd) + 120 * DAY || !settled) continue;
    done.test(N(a.released) === N(a.totalReleases), R(tid), () => `${a.released} of ${a.totalReleases} released ${((N(head.timestamp) - N(c.termEnd)) / DAY).toFixed(0)} days after the term ended`);
  }
  const fr = check("emergency-freeze", "Governance", `An emergency freeze ends within ${days(cfg.emergency)} unless the Council ratifies it`, "Spec §2; Governance.EMERGENCY_FREEZE");
  for (const e of by("EmergencyFreeze")) {
    const end = events.find((x) => x.name === "EmergencyFreezeEnded" && x.a.holder === e.a.holder && x.t >= e.t);
    fr.test(!!end ? end.a.ratified || N(e.a.until) - e.t <= cfg.emergency : N(head.timestamp) <= N(e.a.until) + 60 * DAY, nameShort(e.a.holder), () => `frozen ${new Date(e.t * 1000).toISOString().slice(0, 10)}, until ${new Date(N(e.a.until) * 1000).toISOString().slice(0, 10)}, ${end ? "ended" : "never ended"}`);
  }
  const seat = check("seat-refilled", "Term", "A vacated seat is filled again", "Spec §9");
  for (const e of by("SeatVacated")) {
    const filled = events.find((x) => x.name === "VerifierReplaced" && x.a.tokenId === e.a.tokenId && x.t >= e.t);
    seat.test(!!filled || N(head.timestamp) < e.t + 90 * DAY, R(e.a.tokenId), () => `vacated ${new Date(e.t * 1000).toISOString().slice(0, 10)}, not refilled`);
  }
}
function nameShort(a: string) { return `${a.slice(0, 8)}…`; }

// ---- challenge consequences ----
{
  const c = check("challenge-consequences", "Challenges", "Each verdict has its consequences in the same transaction. Pre-mint: upheld score reopens the request and bars the verifier; upheld documents fails it. Term: upheld score (field) vacates the seat; upheld documents (evidence) keeps the verifier but holds the window's own interval (a cure window has none; an earlier interval may release when the decision lifts a halt); breach holds the drip. Upheld flags the defendant; a plain dismissal flags the challenger", "Spec §9; The Whole Structure (FIELD: seat moves; EVIDENCE: held pending a better record)");
  const kindOf = new Map<bigint, number>();
  const parties = new Map<bigint, { challenger: string; defendant: string }>();
  // for a term challenge: the interval its window covers, and how many instalments had been released, by the event's order
  const windowThrough = new Map<bigint, number>(), releasedAfter = new Map<string, number>();
  const through = new Map<bigint, number>(), released = new Map<bigint, number>();
  const newInterval = new Map<bigint, boolean>(); // the latest verification covered a new interval (not a cure)
  for (const e of events) {
    if (e.name === "CovenantVerified") {
      newInterval.set(e.a.tokenId, N(e.a.verifiedThrough) > (through.get(e.a.tokenId) ?? 0));
      through.set(e.a.tokenId, N(e.a.verifiedThrough));
    }
    // a cure window covers no new interval: an upheld finding on it holds nothing of its own (Infinity)
    if (e.name === "ChallengeRaised" && N(e.a.kind) === 2) windowThrough.set(e.a.challengeId, newInterval.get(e.a.subject) ? (through.get(e.a.subject) ?? 0) : Infinity);
    if (e.name === "InstalmentsReleased") { released.set(e.a.tokenId, (released.get(e.a.tokenId) ?? 0) + N(e.a.count)); releasedAfter.set(`${e.tx}:${e.a.tokenId}`, released.get(e.a.tokenId)!); }
  }
  const subjectOf = new Map<bigint, bigint>();
  for (const e of by("ChallengeRaised")) { kindOf.set(e.a.challengeId, N(e.a.kind)); subjectOf.set(e.a.challengeId, e.a.subject); parties.set(e.a.challengeId, { challenger: e.a.challenger, defendant: e.a.defendant }); }
  for (const d of by("ChallengeDetermined")) {
    const same = events.filter((e) => e.tx === d.tx);
    const has = (n: string) => same.some((e) => e.name === n);
    const flagged = (who: string) => same.some((e) => e.name === "PartyFlagged" && e.a.party.toLowerCase() === who.toLowerCase());
    const ended3 = same.some((e) => e.name === "RequestEnded" && N(e.a.reason) === 3);
    // instalments released in the same transaction must stop short of the challenged window's interval: earlier
    // intervals may release (a decision resets the unattested run, which can lift a halt), the window's own may not
    const after = releasedAfter.get(`${d.tx}:${subjectOf.get(d.a.challengeId)}`);
    const released = after !== undefined && after >= (windowThrough.get(d.a.challengeId) ?? 0);
    const kind = kindOf.get(d.a.challengeId);
    const p = parties.get(d.a.challengeId)!;
    const f = N(d.a.finding);
    const want: string[] = [], got: string[] = [];
    const need = (cond: boolean, what: string) => { want.push(what); if (!cond) got.push(`missing: ${what}`); };
    if (d.a.upheld) need(flagged(p.defendant), "defendant flagged");
    else if (!d.a.inBreach) need(flagged(p.challenger), "challenger flagged");
    if (kind === 1) {
      if (d.a.upheld && f === 1) need(has("RequestReopened"), "request reopened");
      else if (d.a.upheld && f === 2) need(ended3, "request failed");
      else need(!has("RequestReopened") && !ended3, "request unchanged");
    } else {
      if (d.a.upheld && f === 1) need(has("SeatVacated"), "seat vacated");
      if (d.a.upheld && f === 2) need(!has("SeatVacated") && !released, "seat kept, instalments held");
      if (d.a.inBreach) need(has("BreachHeld") && !released, "drip held for breach");
      if (!d.a.upheld && !d.a.inBreach) need(!has("SeatVacated") && !has("BreachHeld"), "nothing held");
    }
    c.test(got.length === 0, `challenge ${d.a.challengeId}`, () => `${kind === 1 ? "pre-mint" : "term"} verdict upheld=${d.a.upheld} finding=${f} breach=${d.a.inBreach}: ${got.join("; ")} (transaction emitted ${same.map((e) => e.name).join(", ")})`);
  }
}

// ---- observations (not rules) ----
{
  const closed = by("EditionClosed");
  observations.editions = { closed: closed.length, byClock: closed.filter((e) => e.a.byClock).length,
    burned: usd(closed.reduce((x, e) => x + e.a.burned, 0n)), spanning: by("LandPlaced").filter((e) => N(e.a.lastEdition) !== N(e.a.edition)).length };
  const heldEv = by("HolderFeeHeld"), relEv = by("HolderFeeReleased");
  observations.heldForSuccessor = { instalments: heldEv.length, held: usd(heldEv.reduce((x, e) => x + e.a.amount, 0n)), released: usd(relEv.reduce((x, e) => x + e.a.amount, 0n)) };
  observations.halts = by("WindowOpened").filter((e) => e.a.halted).length;
  observations.blocks = by("CovenantBlocked").length;
  observations.cancellations = by("CovenantCancelled").length;
  observations.lateReseats = by("VerifierReplaced").length;
}

const replacements: { tid: bigint; old: Address; nu: Address }[] = [];
// ---- the configuration, enforced ----
{
  const fees = check("upfront-fees", "Configuration", "Each request's upfront fees are the fee model's for its land and its country's fees at the time: V + V×(1+√ha) + D×(1.5+√ha), and the country's attestation and judgment fees", "Fee model; EcoFees.upfrontFee");
  const floorC = check("price-floor", "Configuration", "No auction starts below the covenant's price floor: J × acts a year × years × 100", "EcoFees.priceFloor");
  const termC = check("term-length", "Configuration", `Each term runs exactly its Stated Period: years × the protocol year (${days(cfg.year)})`, "Core.activate");
  const sched = check("instalment-schedule", "Configuration", `Each covenant releases once a year below 0.5 ha and twice a year from it: interval = year ÷ releases a year, and years × that many instalments after the first`, "EcoBank._openAccount");
  const rev = check("review-window", "Configuration", `Every review window runs exactly the configured review (${days(cfg.review)})`, "EcoChallenge.openWindow");
  const halt = check("halt-threshold", "Configuration", `A window opens halted exactly when the unattested runs reach the configured threshold (${cfg.haltAfter})`, "Spec §10; EcoChallenge");
  const auc = check("auction-length", "Configuration", `No auction is shorter than the configured minimum (${days(cfg.minAuction)})`, "EcoBank.listForAuction");
  const acc = check("acceptance", "Configuration", `A verification is submitted within the acceptance window of its claim (${days(cfg.acceptance)})`, "EcoRegistry.submitVerification");
  const wdw = check("watchdog-wait", "Configuration", `A request's flow begins only after its watchdog window has passed (${days(cfg.watchdog)})`, "EcoRegistry.enterFlow");
  const bks = check("backstop-delay", "Configuration", `A backstop attestation comes only after the configured delay from the document (${days(cfg.backstop)})`, "EcoDeeds.attest");
  const lst = check("listing-window", "Configuration", "Each request takes its country's listing window; its sale completes inside it, and it closes unsold only after it", "Lifecycle v5 §4, §5");
  const pst = check("post-sale-window", "Configuration", "Each request takes its country's post-sale window; a path B sale completes inside it, and lapses only after it", "Lifecycle v5 §4");
  const flw = check("flow-order", "Configuration", "Every request walks its country's flow, step by step, in order", "EcoCountries flows; FlowCode");
  const rst = check("reseat-rule", "Configuration", "A seat passes only to another verifier of the same Trust Admin from another organisation, and only when the seat was vacated, the verifier is late beyond the delay, or it is out of standing", "Core.nominateVerifier; the original V11 rule (3 Oct)");

  const cs = new Map<number, CountryState>();
  let defaultV = defaultV0;
  const enabled = by("DefaultFeeSet");
  if (enabled.length) defaultV = enabled[0].a.baseFee;
  const reqCountry = new Map<number, number>(), reqLand = new Map<number, bigint>(), reqTerm = new Map<number, number>(), reqState = new Map<number, CountryState>();
  const reqFlow = new Map<number, number[]>(), claimedAt = new Map<number, number>(), verifiedAtR = new Map<number, number>(), started = new Set<number>();
  const docTime = new Map<string, number>(), saleAt = new Map<number, number>(), tokenReq = new Map<bigint, number>();
  const land = new Map<bigint, bigint>(), years = new Map<bigint, bigint>(), country = new Map<bigint, number>();
  const verifiedThrough = new Map<bigint, number>(), schedule = new Map<bigint, { start: number; interval: number }>();
  const vacatedAt = new Map<bigint, number>(), outOfStanding = new Map<string, number>();
  const vOf = (st: CountryState) => (st.baseFee !== 0n ? st.baseFee : defaultV);
  for (const e of events) {
    const a = e.a;
    switch (e.name) {
      case "DefaultFeeSet": defaultV = a.baseFee; break;
      case "CountryEnabled": cs.set(N(a.country), { flowId: N(a.settings.flowId), min: N(a.settings.minTermYears), max: N(a.settings.maxTermYears), listing: N(a.settings.listingWindow), postSale: N(a.settings.postSaleWindow), baseFee: a.fees.baseFee, att: a.fees.attestationFee, jud: a.fees.judgmentFee }); break;
      case "CountryFeesSet": { const x = cs.get(N(a.country))!; cs.set(N(a.country), { ...x, baseFee: a.fees.baseFee, att: a.fees.attestationFee, jud: a.fees.judgmentFee }); break; }
      case "SettingsApplied": { const x = cs.get(N(a.country))!; cs.set(N(a.country), { ...x, flowId: N(a.settings.flowId), min: N(a.settings.minTermYears), max: N(a.settings.maxTermYears), listing: N(a.settings.listingWindow), postSale: N(a.settings.postSaleWindow) }); break; }
      case "VerificationRequested": {
        const rid = N(a.requestId), st = cs.get(N(a.country))!;
        reqCountry.set(rid, N(a.country)); reqLand.set(rid, a.landUnits); reqTerm.set(rid, N(a.termYears)); reqState.set(rid, { ...st });
        const v = vOf(st);
        fees.test(a.verificationFee === upfrontOf(a.landUnits, v) && a.attestationFee === st.att && a.judgmentFee === st.jud, `#${rid}`,
          () => `paid ${usd(a.verificationFee)} / ${usd(a.attestationFee)} / ${usd(a.judgmentFee)}; the model gives ${usd(upfrontOf(a.landUnits, v))} / ${usd(st.att)} / ${usd(st.jud)}`);
        break;
      }
      case "RequestClaimed": claimedAt.set(N(a.requestId), e.t); break;
      case "VerificationSubmitted": {
        const rid = N(a.requestId);
        acc.test(e.t <= (claimedAt.get(rid) ?? 0) + cfg.acceptance, `#${rid}`, () => `submitted ${days(e.t - (claimedAt.get(rid) ?? 0))} after the claim`);
        verifiedAtR.set(rid, e.t); started.delete(rid);
        break;
      }
      case "FlowEntered": reqFlow.set(N(a.requestId), flows.get(N(a.flowId)) ?? []); break;
      case "FlowAdvanced": {
        const rid = N(a.requestId), steps = reqFlow.get(rid) ?? flows.get(reqState.get(rid)?.flowId ?? 0) ?? [];
        // one past the last step is the flow's completion, reported as step 0 (none)
        const expected = N(a.cursor) === steps.length ? 0 : steps[N(a.cursor)];
        flw.test(expected === N(a.step), `#${rid}`, () => `step ${a.step} at cursor ${a.cursor}; the flow is ${steps.join(", ")}`);
        break;
      }
      case "PowerGranted": case "DocumentRecorded": {
        const rid = N(a.requestId);
        if (e.name === "DocumentRecorded") docTime.set(`${rid}:${a.index}`, e.t);
        if (!started.has(rid) && verifiedAtR.has(rid)) {
          started.add(rid);
          wdw.test(e.t > verifiedAtR.get(rid)! + cfg.watchdog - 2, `#${rid}`, () => `the flow began ${days(e.t - verifiedAtR.get(rid)!)} after the verification`);
        }
        break;
      }
      case "DocumentAttested":
        if (a.backstop) {
          const at0 = docTime.get(`${N(a.requestId)}:${a.index}`) ?? 0;
          bks.test(e.t >= at0 + cfg.backstop, `#${a.requestId}`, () => `a GTA attested ${days(e.t - at0)} after the document`);
        }
        break;
      case "CovenantCreated": land.set(a.tokenId, a.landUnits); years.set(a.tokenId, BigInt(a.termYears)); country.set(a.tokenId, N(a.country)); tokenReq.set(a.tokenId, N(a.requestId)); break;
      case "AuctionListed": {
        const tid = a.tokenId, rid = tokenReq.get(tid)!, st = reqState.get(rid);
        if (st) floorC.test(a.startPrice >= floorOf(land.get(tid)!, years.get(tid)!, vOf(st)), R(tid), () => `listed from ${usd(a.startPrice)}; the floor is ${usd(floorOf(land.get(tid)!, years.get(tid)!, vOf(st)))}`);
        auc.test(N(a.endsAt) - Math.max(N(a.startsAt), e.t) >= cfg.minAuction - 2, R(tid), () => `an auction of ${days(N(a.endsAt) - Math.max(N(a.startsAt), e.t))}`);
        break;
      }
      case "SaleRecorded": saleAt.set(N(a.requestId), e.t); break;
      case "SaleLapsed": {
        const rid = N(a.requestId), sold = saleAt.get(rid), post = reqState.get(rid)?.postSale ?? 0;
        if (sold) pst.test(e.t > sold + post, `#${rid}`, () => `lapsed ${days(e.t - sold)} after the sale; the window is ${days(post)}`);
        break;
      }
      case "FlowCompleted": {
        const rid = N(a.requestId), sold = saleAt.get(rid), post = reqState.get(rid)?.postSale ?? 0;
        if (sold && post > 0 && e.t > sold) pst.test(e.t <= sold + post, `#${rid}`, () => `completed ${days(e.t - sold)} after the sale; the window is ${days(post)}`);
        break;
      }
      case "CovenantActivated": {
        const tid = a.tokenId, y = Number(years.get(tid) ?? 0n);
        termC.test(N(a.termEnd) - N(a.termStart) === y * cfg.year, R(tid), () => `${days(N(a.termEnd) - N(a.termStart))} for ${y} years`);
        break;
      }
      case "Activated": {
        const tid = a.tokenId, per = (land.get(tid) ?? 0n) >= BigInt(cfg.twiceFrom) ? 2 : 1, y = Number(years.get(tid) ?? 0n);
        sched.test(N(a.interval) === Math.floor(cfg.year / per) && N(a.totalReleases) === y * per, R(tid), () => `interval ${days(N(a.interval))}, ${a.totalReleases} instalments for ${y} years at ${per} a year`);
        schedule.set(tid, { start: N(a.termStart), interval: N(a.interval) });
        break;
      }
      case "WindowOpened":
        rev.test(N(a.closesAt) - N(a.openedAt) === cfg.review, R(a.tokenId), () => `a window of ${days(N(a.closesAt) - N(a.openedAt))}`);
        halt.test(a.halted === (N(a.unattestedRuns) >= cfg.haltAfter), R(a.tokenId), () => `halted=${a.halted} at ${a.unattestedRuns} unattested runs`);
        break;
      case "CovenantVerified": verifiedThrough.set(a.tokenId, N(a.verifiedThrough)); break;
      case "SeatVacated": vacatedAt.set(a.tokenId, e.t); break;
      case "PartyFlagged": if (N(a.flagsInWindow) >= 3) outOfStanding.set(getAddress(a.party), e.t); break;
      case "VerifierDismissed": case "VerifierSuspended": outOfStanding.set(getAddress(a.verifier), e.t); break;
      case "VerifierReplaced": {
        const tid = a.tokenId;
        const s0 = schedule.get(tid);
        const due = s0 ? s0.start + ((verifiedThrough.get(tid) ?? 0) + 1) * s0.interval : 0;
        const why = vacatedAt.has(tid) ? "vacated" : outOfStanding.has(getAddress(a.oldVerifier)) ? "out of standing" : s0 && e.t > due + cfg.maxDelay ? "late" : "";
        rst.test(why !== "", R(tid), () => `${nameShort(a.newVerifier)} took the seat with nothing to allow it: due ${new Date(due * 1000).toISOString().slice(0, 10)}, replaced ${new Date(e.t * 1000).toISOString().slice(0, 10)}`);
        vacatedAt.delete(tid);
        replacements.push({ tid, old: getAddress(a.oldVerifier), nu: getAddress(a.newVerifier) });
        break;
      }
    }
  }
  // the seat's new holder: the same Trust Admin, another organisation
  const facts = await Promise.all(replacements.map(async (x) => Promise.all([rd("admin", "holderOf", [x.old]), rd("admin", "holderOf", [x.nu]), rd("admin", "orgOf", [x.old]), rd("admin", "orgOf", [x.nu])])));
  replacements.forEach((x, i) => {
    const [h0, h1, o0, o1] = facts[i];
    rst.test(getAddress(h0) === getAddress(h1) && o0 !== o1, R(x.tid), () => `from org ${o0} to org ${o1}; Trust Admins ${nameShort(h0)} and ${nameShort(h1)}`);
  });
  // the listing and post-sale windows, from each request as it now stands
  const rids = [...reqCountry.keys()];
  const reqs = await Promise.all(rids.map((rid) => rd("registry", "getRequest", [BigInt(rid)])));
  const endedAt = new Map(by("RequestEnded").map((e) => [N(e.a.requestId), { t: e.t, reason: N(e.a.reason) }]));
  const lapsedAt = new Map<number, number>();
  for (const e of by("SaleLapsed")) lapsedAt.set(N(e.a.requestId), e.t);
  const completed = new Map(by("FlowCompleted").map((e) => [N(e.a.requestId), e.t]));
  rids.forEach((rid, i) => {
    const r = reqs[i], st = reqState.get(rid)!;
    lst.test(N(r.listingWindow) === st.listing && N(r.postSaleWindow) === st.postSale, `#${rid}`, () => `took listing ${days(N(r.listingWindow))}, post-sale ${days(N(r.postSaleWindow))}; the country had ${days(st.listing)} and ${days(st.postSale)}`);
    const from = N(r.listingFrom), close = from + N(r.listingWindow);
    const sold = saleAt.get(rid);
    if (sold && from) lst.test(sold <= close, `#${rid}`, () => `sold ${days(sold - from)} after the listing window opened`);
    const end = endedAt.get(rid);
    if (end?.reason === 4) lst.test(end.t > close, `#${rid}`, () => `closed unsold ${days(close - end.t)} before its window closed`);
  });
}

// ---- the deployment against the configuration it was given (CONFIG: the scenario file) ----
if (process.env.CONFIG) {
  const j = JSON.parse(readFileSync(process.env.CONFIG, "utf8"));
  const sc = j.scenario ?? j;
  const k = sc.contracts;
  const dep = check("deployment-matches-config", "Configuration", "Every value the contracts were deployed with is the one the configuration asked for: each timing, V, the fee split, the edition scale, every country's settings and fees, and every flow", "The setup screen; src/deploy.ts");
  const want: [string, number, number][] = [
    ["protocol year", k.yearDays * DAY, cfg.year], ["verification delay", k.maxVerificationDelayDays * DAY, cfg.maxDelay],
    ["acceptance", k.acceptanceDays * DAY, cfg.acceptance], ["watchdog", k.watchdogDays * DAY, cfg.watchdog],
    ["backstop", k.backstopDays * DAY, cfg.backstop], ["shortest auction", k.minAuctionDays * DAY, cfg.minAuction],
    ["review window", k.reviewDays * DAY, cfg.review], ["response", k.responseDays * DAY, cfg.response],
    ["panel", k.panelDays * DAY, cfg.panel], ["redraw", k.redrawDays * DAY, cfg.redraw], ["halt after", k.haltAfter, cfg.haltAfter],
    ["edition scale", k.editionScale, N(editionScale)],
  ];
  for (const [what, a, b] of want) dep.test(a === b, what, () => `configured ${a}, deployed ${b}`);
  dep.test(BigInt(k.baseFee) * 10n ** 18n === defaultV0, "V", () => `configured ${k.baseFee}, deployed ${usd(defaultV0)}`);
  const first = by("FeeSplitSet")[0]?.a;
  dep.test(!!first && N(first.verifierPermille) === k.verifierPermille && N(first.taxPermille) === k.taxPermille && N(first.serverPermille) === k.serverPermille,
    "fee split", () => `configured ${k.verifierPermille}/${k.taxPermille}/${k.serverPermille}, deployed ${first?.verifierPermille}/${first?.taxPermille}/${first?.serverPermille}`);
  for (const f of sc.flows) dep.test(JSON.stringify(flows.get(f.id)) === JSON.stringify(f.steps), `flow ${f.id}`, () => `configured ${f.steps}, deployed ${flows.get(f.id)}`);
  const enabledEv = new Map(by("CountryEnabled").map((e) => [N(e.a.country), e.a]));
  const holders = new Map<number, number>();
  for (const e of by("HolderAdded")) holders.set(N(e.a.country), (holders.get(N(e.a.country)) ?? 0) + 1);
  const verifiers = new Map<number, number>();
  for (const e of by("VerifierAdded")) verifiers.set(N(e.a.country), (verifiers.get(N(e.a.country)) ?? 0) + 1);
  const cast = check("cast-matches-config", "Configuration", "Each country has the Trust Admins, organisations and verifiers the configuration asked for (and no more than the governance calendar and recruits add)", "The setup screen; the engine's cast");
  for (const c of sc.countries) {
    const e = enabledEv.get(c.code);
    dep.test(!!e && N(e.settings.flowId) === c.flowId && N(e.settings.minTermYears) === c.minTerm && N(e.settings.maxTermYears) === c.maxTerm
      && N(e.settings.listingWindow) === c.listingDays * DAY && N(e.settings.postSaleWindow) === c.postSaleDays * DAY
      && e.fees.baseFee === BigInt(c.baseFee) * 10n ** 18n && e.fees.attestationFee === BigInt(c.attestationFee) * 10n ** 18n && e.fees.judgmentFee === BigInt(c.judgmentFee) * 10n ** 18n,
      `${c.name} (${c.code})`, () => e ? `deployed ${JSON.stringify(e.settings, (_, v) => typeof v === "bigint" ? v.toString() : v)}` : "not enabled");
    const h = holders.get(c.code) ?? 0, v = verifiers.get(c.code) ?? 0;
    const wantV = c.holders * c.orgsPerHolder * c.verifiersPerOrg;
    cast.test(h >= c.holders && h <= c.holders + 1 && v >= wantV, `${c.name} (${c.code})`, () => `${h} Trust Admins and ${v} verifiers; configured ${c.holders} and ${wantV}`);
  }
}

// ---- failed transactions ----
{
  const c = check("no-unexpected-reverts", "Transactions", "Every transaction an actor sent succeeded, apart from the ones the simulation tries knowing they may fail", "The simulation's actors");
  for (const f of failed) c.test(f.expected, `block ${f.block}`, () => `${f.to}.${f.fn} from ${nameShort(f.from)} at ${new Date(f.t * 1000).toISOString().slice(0, 10)}`);
  c.ok();
}

// ---- the state now ----
{
  const c = check("balances-now", "Money", "Now: the Registry, the Bank and EcoChallenge each hold exactly what their records say", "Invariants 1–3");
  const bal = (a: string) => bulk.readContract({ address: addr.usdt, abi: abis.usdt, functionName: "balanceOf", args: [a], ...at }) as Promise<bigint>;
  const reqCount = N(await bulk.readContract({ address: addr.registry, abi: abis.registry, functionName: "nextRequestId", ...at })) - 1;
  const toks = N(await bulk.readContract({ address: addr.token, abi: abis.token, functionName: "nextTokenId", ...at })) - 1;
  let reg = 0n, bank = 0n, pool = 0n;
  const rs = await Promise.all(Array.from({ length: reqCount }, (_, i) => bulk.readContract({ address: addr.registry, abi: abis.registry, functionName: "getRequest", args: [BigInt(i + 1)], ...at }) as Promise<any>));
  for (const r of rs) reg += r.verifierShare + r.deedComponent + r.attestationFee + r.judgmentFee;
  const ts = await Promise.all(Array.from({ length: toks }, async (_, i) => {
    const tid = BigInt(i + 1);
    const [a, st, p] = await Promise.all([
      bulk.readContract({ address: addr.bank, abi: abis.bank, functionName: "getAccount", args: [tid], ...at }) as Promise<any>,
      bulk.readContract({ address: addr.bank, abi: abis.bank, functionName: "inSettlement", args: [tid], ...at }) as Promise<boolean>,
      bulk.readContract({ address: addr.challenge, abi: abis.challenge, functionName: "poolBalance", args: [tid], ...at }) as Promise<bigint>,
    ]);
    const s = st ? (await bulk.readContract({ address: addr.bank, abi: abis.bank, functionName: "getSettlement", args: [tid], ...at }) as any).price : 0n;
    return { held: a.balance + s, pool: p };
  }));
  for (const x of ts) { bank += x.held; pool += x.pool; }
  // and the Trust Admin shares held for successors
  const holders = [...new Set(by("HolderFeeHeld").map((e) => getAddress(e.a.holder)))];
  for (const h of holders) bank += await bulk.readContract({ address: addr.bank, abi: abis.bank, functionName: "heldForSuccessor", args: [h], ...at }) as bigint;
  const [b1, b2, b3] = await Promise.all([bal(addr.registry), bal(addr.bank), bal(addr.challenge)]);
  c.test(b1 === reg, "Registry", () => `holds ${usd(b1)}, records ${usd(reg)}`);
  c.test(b2 === bank, "Bank", () => `holds ${usd(b2)}, records ${usd(bank)}`);
  c.test(b3 === pool, "EcoChallenge", () => `holds ${usd(b3)}, records ${usd(pool)}`);
}

// =====================================================================================
// 3. The summary
// =====================================================================================

const count = (n: string) => by(n).length;
const summary = {
  name: NAME, head: N(last), from: events[0]?.t, to: N(head.timestamp), editionScale: N(editionScale),
  transactions: txCount, failed: failed.length, unexpectedFailed: failed.filter((f) => !f.expected).length,
  events: events.length,
  counts: Object.fromEntries(["VerificationRequested", "VerificationSubmitted", "CovenantMinted", "Activated", "CovenantVerified", "InstalmentsReleased", "ChallengeRaised", "ChallengeDetermined", "ChallengeLapsed", "ChallengeWithdrawn", "SeatVacated", "VerifierReplaced", "CovenantBlocked", "CovenantCancelled", "SaleLapsed", "Sold", "Overcharged", "RewardClaimed", "EditionAssigned", "ProposalExecuted", "EmergencyFreeze", "BreachHeld", "BreachCured"].map((n) => [n, count(n)])),
  failedBy: Object.entries(failed.reduce((m, f) => { const k = `${f.to}.${f.fn}${f.expected ? " (expected)" : ""}`; m[k] = (m[k] ?? 0) + 1; return m; }, {} as Record<string, number>)),
  observations, configuration: { ...cfg, defaultBaseFee: usd(defaultV0), editionScale: N(editionScale) },
  checks: checks.map((c) => ({ ...c, failures: c.failures.slice(0, 40), failureCount: c.failures.length })),
};
writeFileSync(new URL("audit.json", OUT), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(observations));
for (const c of checks) console.log(`${c.failures.length ? "FAIL" : "ok  "}  ${c.id.padEnd(24)} ${String(c.checked).padStart(6)} checked  ${c.failures.length} failed${c.failures.length ? `   e.g. ${c.failures[0].ref}: ${c.failures[0].detail}` : ""}`);
