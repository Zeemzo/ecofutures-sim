// Every money movement, decoded from the contracts' own events; and the census of the whole ecosystem, with the
// six invariants, read at one block.
import { getAddress, type Address } from "viem";
import { read, addr, type Decoded } from "./chain";
import { RequestStatus, CovenantStatus, Payee } from "./model";

export const MONEY = [
  "Upfront paid by guardians", "Verification fees", "Attestation fees", "Judgment fees",
  "Refunds to guardians", "Sale prices paid", "Instalments: verifier", "Instalments: Trust Admin",
  "Instalments: Foundation", "Instalments: guardian", "Review pool funded", "Pool: attestors", "Pool: panels",
  "Pool: challengers", "Pool: swept to guardians", "Sale refunds", "Paid to patrons", "Resale volume",
  "TR3: patrons", "TR3: guardians", "TR3: referrers", "Trust Admin share withheld",
  "Withheld shares paid out", "Held instalments at the End Date",
] as const;
export const OUTFLOWS = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 22, 23];

export class Ledger {
  money: bigint[] = MONEY.map(() => 0n);
  reqOfToken = new Map<bigint, number>();
  reqOfChallenge = new Map<bigint, number>();
  price = new Map<number, bigint>();
  guardianGot = new Map<number, bigint>();
  tr3 = new Map<number, bigint>();
  /** Trust Admins whose shares the Bank withholds, for a successor or until unfrozen. */
  heldFor = new Set<string>();
  /** Per role, everything paid out, by address. */
  earned = new Map<string, bigint>();
  /** Instalments released in a transaction, by token: an AccountClosed after them repeats them. */
  private releasedIn = new Set<string>();

  private add(i: number, v: bigint) { this.money[i] += v; }
  private credit(a: Address | undefined, v: bigint) {
    if (!a || v === 0n) return;
    const k = getAddress(a);
    this.earned.set(k, (this.earned.get(k) ?? 0n) + v);
  }

  ridOf(e: Decoded): number {
    const a = e.args;
    if (a.requestId !== undefined) return Number(a.requestId);
    if (a.tokenId !== undefined) return this.reqOfToken.get(a.tokenId) ?? 0;
    if (a.challengeId) return this.reqOfChallenge.get(a.challengeId) ?? 0;
    return 0;
  }

  ingest(e: Decoded) {
    const a = e.args;
    const rid = () => this.ridOf(e);
    switch (`${e.contract}.${e.name}`) {
      case "registry.CovenantMinted": this.reqOfToken.set(a.tokenId, Number(a.requestId)); break;
      case "challenge.ChallengeRaised": {
        const option = Number(a.option);
        this.reqOfChallenge.set(a.challengeId, option <= 2 ? Number(a.subject) : this.reqOfToken.get(a.subject) ?? 0);
        break;
      }
      case "registry.VerificationRequested": this.add(0, a.verificationFee + a.attestationFee + a.judgmentFee); break;
      case "registry.VerifierPaid": this.add(1, a.amount); this.credit(a.verifier, a.amount); break;
      case "registry.AttestationPaid": this.add(2, a.amount); this.credit(a.attester, a.amount); break;
      case "registry.JudgmentPaid": {
        this.add(3, a.amount);
        const voters: Address[] = a.voters ?? [];
        if (voters.length) for (const v of voters) this.credit(v, a.amount / BigInt(voters.length));
        break;
      }
      case "registry.RequestEnded": {
        this.add(4, a.refund);
        const r = rid();
        this.guardianGot.set(r, (this.guardianGot.get(r) ?? 0n) + a.refund);
        break;
      }
      case "market.AuctionSettled":
        this.add(5, a.price);
        if (a.price !== 0n) this.price.set(rid(), a.price);
        break;
      case "bank.InstalmentsReleased": {
        const p = a.payout;
        this.add(6, p.verifierFee); this.add(7, p.holderFee); this.add(8, p.foundationFee); this.add(9, p.guardianAmount);
        this.credit(p.verifier, p.verifierFee); this.credit(p.holder, p.holderFee); this.credit(p.guardian, p.guardianAmount);
        const r = rid();
        this.guardianGot.set(r, (this.guardianGot.get(r) ?? 0n) + p.guardianAmount);
        this.releasedIn.add(`${e.tx}:${a.tokenId}`);
        break;
      }
      case "bank.AccountClosed":
        // after a release in the same transaction it repeats it; otherwise (held for a breach or a Deed) it is the payout
        if (!this.releasedIn.has(`${e.tx}:${a.tokenId}`)) this.add(23, a.toGuardian + a.toPatron);
        break;
      case "bank.Activated": this.add(10, a.reviewPool); break;
      case "market.SaleRefunded": this.add(15, a.price); break;
      case "market.StaleSaleCancelled": this.add(15, a.price); break;
      case "bank.PaidToPatron": this.add(16, a.amount); this.credit(a.owner, a.amount); break;
      case "bank.HolderFeeHeld": this.add(21, a.amount); this.heldFor.add(getAddress(a.holder)); break;
      case "bank.HolderFeeReleased": this.add(22, a.amount); this.credit(a.successor, a.amount); break;
      case "challenge.ReviewFeePaid": {
        const payee = Number(a.payee);
        this.add(payee === 0 ? 11 : payee === 1 ? 12 : payee === 2 ? 13 : 14, a.amount);
        this.credit(a.to, a.amount);
        break;
      }
      case "tree.RewardClaimed": {
        this.add(18, a.patronAmount); this.add(19, a.guardianAmount); this.add(20, a.referrerAmount);
        const r = rid();
        this.tr3.set(r, (this.tr3.get(r) ?? 0n) + a.patronAmount + a.guardianAmount + a.referrerAmount);
        break;
      }
      case "token.Sold": this.add(17, a.price); break;
    }
  }

  inflow() { return this.money[0] + this.money[5]; }
  outflow() { return OUTFLOWS.reduce((s, i) => s + this.money[i], 0n); }
}

export { Payee };

// =====================================================================================
// The census
// =====================================================================================

export type Stage =
  | "requested" | "claimed" | "watchdog" | "flow" | "for-sale" | "auction" | "escrow" | "active" | "blocked"
  | "ending" | "complete" | "ended";

export type Row = {
  rid: number; country: number; land: number; term: number; score: number; status: number; endReason: number;
  step: number; tokenId: bigint; stage: Stage; guardian: Address; verifier: Address;
  cstatus?: number; termStart?: number; termEnd?: number; edition?: number; released?: number; total?: number;
  verifiedThrough?: number; balance?: bigint; frozen?: boolean; halted?: boolean; pool?: bigint;
  challenged?: boolean; windowOpen?: boolean; windowAction?: number; price?: bigint; owner?: Address;
  /** TR3 over the whole term if nothing changes (the platform's "mint capacity"), and the Trust Admin it sits under. */
  projected?: bigint; holder?: Address;
};

export type Census = {
  t: number; block: bigint; rows: Row[]; edition: number; landYears: bigint; tr3Supply: bigint; gtas: number;
  registryBal: bigint; marketBal: bigint; bankBal: bigint; poolBal: bigint; registryHeld: bigint; marketHeld: bigint;
  bankHeld: bigint; poolHeld: bigint; reserve: bigint;
  inv: boolean[]; counts: Record<Stage, number>;
  /** Requests whose instalments run ahead of their verifications or past their term (invariant 4). */
  bad: string[];
  /** The platform's home-page indicators: the sale prices of the EFTs sold and still standing, how many, the TR3
   *  those lands will mint over their terms, and the land-years before the next edition begins. */
  marketCap: bigint; sold: number; soldProjected: bigint; tillNextEdition: bigint;
  /** The open edition's size in land-years, and the TR3 burned so far by editions closed with room left. */
  capacity: bigint; burned: bigint;
};

/** Sold and still standing: not blocked, not cancelled (the platform's market cap counts these). */
export const standingSale = (r: Row) => (r.price ?? 0n) > 0n && r.termStart !== undefined && r.termStart !== 0
  && (r.cstatus === CovenantStatus.ACTIVE || r.cstatus === CovenantStatus.CLOSED);

export const INVARIANTS = [
  "The Registry holds exactly the fees its requests record",
  "The Market holds exactly the prices of the sales settling; the Bank its instalment balances and withheld shares",
  "EcoChallenge holds exactly its review pools",
  "No instalment runs ahead of a verification, nor past the term",
  "TR3 supply equals what was minted to patrons, guardians and referrers",
  "Every unit paid in was paid out to someone, or is still held",
  "Every TR3 of the 210,000,000 is minted, owed, in the Reserve, committed, streaming, unplaced or burned",
];

type Part = { row: Row; registry: bigint; market: bigint; bank: bigint; pool: bigint; ok: boolean; token: boolean; why?: string };
/** A finished request's last reading: once done, nothing about it changes, so it is not read again. */
const finalParts = new Map<number, Part>();
export function resetCensus() { finalParts.clear(); }

async function readOne(rid: number, done: boolean, at: (c: any, fn: string, args?: unknown[]) => Promise<any>, ledger: Ledger, t: number): Promise<Part> {
  const r = await at("registry", "getRequest", [BigInt(rid)]);
  const status = Number(r.status);
  const step = status === RequestStatus.IN_FLOW ? Number((await at("registry", "stepContext", [BigInt(rid)])).step) : 0;
  let stage: Stage = status === RequestStatus.OPEN ? "requested" : status === RequestStatus.CLAIMED ? "claimed"
    : status === RequestStatus.VERIFIED ? "watchdog" : status === RequestStatus.IN_FLOW ? "flow" : "ended";
  if (status === RequestStatus.ENDED && Number(r.endReason) === 7) stage = done ? "complete" : "active";
  const row: Row = {
    rid, country: Number(r.country), land: Number(r.landUnits), term: Number(r.termYears), score: Number(r.ecoScore),
    status, endReason: Number(r.endReason), step, tokenId: r.tokenId, stage, guardian: r.guardian, verifier: r.verifier,
    challenged: r.challengeId !== 0n,
  };
  const part: Part = { row, registry: r.verifierShare + r.attestationFee + r.judgmentFee, market: 0n, bank: 0n, pool: 0n, ok: true, token: false };
  if (r.tokenId === 0n) return part;
  const tid = r.tokenId;
  const [c, a, settling, pool, auction, w, undecided, owner, reward, holder] = await Promise.all([
    at("core", "getCovenant", [tid]), at("bank", "getAccount", [tid]), at("market", "inSettlement", [tid]),
    at("challenge", "poolBalance", [tid]), at("market", "hasAuction", [tid]), at("challenge", "getWindow", [tid]),
    at("challenge", "hasUndecidedChallenge", [tid]), at("token", "ownerOf", [tid]).catch(() => null),
    at("tree", "rewardOf", [tid]).catch(() => null), at("core", "holderOf", [tid]).catch(() => null),
  ]);
  const [settlement, halted] = await Promise.all([
    settling ? at("market", "getSettlement", [tid]) : null,
    Number(c.termStart) !== 0 ? at("challenge", "releasesHalted", [tid]) : false,
  ]);
  part.token = true;
  part.bank = a.balance;
  part.market = settlement ? settlement.price : 0n;
  part.pool = pool;
  // the End Date releases what is left, verified or not (closeTerm after the grace): only an ended term may be ahead
  const ended = Number(c.status) === CovenantStatus.ENDED;
  part.ok = !((a.released > c.verifiedThrough && !ended) || c.verifiedThrough > a.totalReleases || a.released > a.totalReleases);
  if (!part.ok) part.why = `#${rid}: released ${a.released}, verified through ${c.verifiedThrough}, of ${a.totalReleases}, status ${Number(c.status)}`;
  Object.assign(row, {
    cstatus: Number(c.status), termStart: Number(c.termStart), termEnd: Number(c.termEnd), edition: Number(c.edition),
    released: Number(a.released), total: Number(a.totalReleases), verifiedThrough: Number(c.verifiedThrough),
    balance: a.balance, frozen: Number(a.holds) !== 0, halted, pool, verifier: c.verifier, guardian: c.guardian,
    windowOpen: Number(w.openedAt) !== 0 && !w.settled, windowAction: Number(w.action),
    challenged: row.challenged || undecided, price: a.price || settlement?.price || ledger.price.get(rid), owner: owner ?? undefined,
    projected: reward?.allocation === undefined ? undefined : (reward.allocation * BigInt(c.ecoScore)) / 100n, holder: holder ?? undefined,
  });
  const cs = Number(c.status);
  if (row.status !== RequestStatus.ENDED || row.endReason === 7) {
    if (cs === CovenantStatus.BLOCKED) row.stage = "blocked";
    else if (settling) row.stage = "escrow";
    else if (cs === CovenantStatus.MINTED) row.stage = auction ? "auction" : "for-sale";
    else if (cs === CovenantStatus.ACTIVE && row.stage !== "complete") row.stage = t >= Number(c.termEnd) ? "ending" : "active";
    else if (cs === CovenantStatus.ENDED) row.stage = done ? "complete" : "ending";
    else if (cs === CovenantStatus.CANCELLED || cs === CovenantStatus.CLOSED) row.stage = done ? "ended" : "ending";
  }
  if (row.status === RequestStatus.ENDED && row.endReason !== 7 && cs === CovenantStatus.BLOCKED) row.stage = "blocked";
  return part;
}

export async function census(requests: number[], done: Set<number>, ledger: Ledger, block: bigint, t: number): Promise<Census> {
  const at = (c: any, fn: string, args: unknown[] = []) => read(c, fn, args, block);
  const parts = await Promise.all(requests.map(async (rid) => {
    const cached = finalParts.get(rid);
    if (cached) return cached;
    const p = await readOne(rid, done.has(rid), at, ledger, t);
    if (done.has(rid)) finalParts.set(rid, p);
    return p;
  }));
  const [registryBal, marketBal, bankBal, poolBal, supply, mp, mg, mr, info, gtas, nextToken, placed, sb, maxSupply] = await Promise.all([
    at("usdt", "balanceOf", [addr.registry]), at("usdt", "balanceOf", [addr.market]), at("usdt", "balanceOf", [addr.bank]),
    at("usdt", "balanceOf", [addr.challenge]),
    at("tree", "totalSupply"), at("tree", "mintedToPatrons"), at("tree", "mintedToGuardians"), at("tree", "mintedToReferrers"),
    at("tree", "editionInfo"), at("governance", "getGTAs"), at("token", "nextTokenId"),
    at("tree", "placedLandYears"), at("tree", "supplyBreakdown"), at("tree", "MAX_SUPPLY"),
  ]);
  const burned: bigint = sb.burned;
  const held = await Promise.all([...ledger.heldFor].map((h) => at("bank", "heldForSuccessor", [h])));
  const bad: string[] = [];
  let registryHeld = 0n, marketHeld = 0n, bankHeld = held.reduce((x: bigint, y: bigint) => x + y, 0n), poolHeld = 0n, ok3 = true, tokens = 0;
  for (const p of parts) {
    registryHeld += p.registry; marketHeld += p.market; bankHeld += p.bank; poolHeld += p.pool;
    if (!p.ok) { ok3 = false; if (p.why) bad.push(p.why); }
    if (p.token) tokens++;
  }
  const rows = parts.map((p) => p.row);
  // the unallocated remainder matches the capacity left to within rounding dust, kept (addendum, point 6)
  const unplaced: bigint = await at("tree", "unplacedCapacity");
  const parts7 = sb.minted + sb.owed + sb.reserve + sb.committed + sb.unstreamed + sb.unallocated + sb.burned;
  const dust = sb.unallocated > unplaced ? sb.unallocated - unplaced : unplaced - sb.unallocated;
  const inv = [
    registryBal === registryHeld,
    marketBal === marketHeld && bankBal === bankHeld,
    poolBal === poolHeld,
    ok3 && Number(nextToken) - 1 === tokens,
    supply === mp + mg + mr,
    ledger.inflow() === ledger.outflow() + registryBal + marketBal + bankBal + poolBal,
    parts7 === maxSupply && dust < 10n ** 12n,
  ];
  const counts = {} as Record<Stage, number>;
  for (const r of rows) counts[r.stage] = (counts[r.stage] ?? 0) + 1;
  let marketCap = 0n, sold = 0, soldProjected = 0n;
  for (const r of rows) if (standingSale(r)) { marketCap += r.price!; sold++; soldProjected += r.projected ?? 0n; }
  // editionInfo: (edition, F, land-years placed in it, its size, opened at, closes by)
  const used: bigint = info[2], capacity: bigint = info[3];
  return {
    t, block, rows, edition: Number(info[0]), landYears: placed, tr3Supply: supply, gtas: gtas.length, capacity, burned,
    registryBal, marketBal, bankBal, poolBal, registryHeld, marketHeld, bankHeld, poolHeld, reserve: sb.reserve, inv, counts, bad,
    marketCap, sold, soldProjected, tillNextEdition: capacity > used ? capacity - used : 0n,
  };
}
