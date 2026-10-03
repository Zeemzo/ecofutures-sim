// Every money movement, decoded from the contracts' own events; and the census of the whole ecosystem, with the
// six invariants, read at one block.
import { getAddress, type Address } from "viem";
import { read, addr, type Decoded } from "./chain";
import { RequestStatus, CovenantStatus, Payee } from "./model";

export const MONEY = [
  "Upfront paid by guardians", "Verifier fee (upfront)", "Attester fees", "Pre-mint panel (judgment)",
  "Refunds to guardians", "Sale prices paid", "Instalments: verifier", "Instalments: Trust Admin",
  "Instalments: server", "Instalments: guardian", "Review pool funded", "Pool: attestors", "Pool: panels",
  "Pool: challengers", "Pool: swept to guardians", "Sale refunds (path B)", "Cancellation payouts", "Resale volume",
  "TR3: patrons", "TR3: guardians", "TR3: referrers", "Trust Admin share held for a successor",
  "Held shares paid to successors",
] as const;
export const OUTFLOWS = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 22];

export class Ledger {
  money: bigint[] = MONEY.map(() => 0n);
  reqOfToken = new Map<bigint, number>();
  reqOfChallenge = new Map<bigint, number>();
  price = new Map<number, bigint>();
  guardianGot = new Map<number, bigint>();
  tr3 = new Map<number, bigint>();
  /** Removed Trust Admins whose shares the Bank holds for a successor. */
  heldFor = new Set<string>();
  /** Per role, everything paid out, by address. */
  earned = new Map<string, bigint>();

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
    if (a.targetTokenId !== undefined) return this.reqOfToken.get(a.targetTokenId) ?? 0;
    if (a.challengeId) return this.reqOfChallenge.get(a.challengeId) ?? 0;
    return 0;
  }

  ingest(e: Decoded) {
    const a = e.args;
    const rid = () => this.ridOf(e);
    switch (`${e.contract}.${e.name}`) {
      case "registry.CovenantMinted": this.reqOfToken.set(a.tokenId, Number(a.requestId)); break;
      case "challenge.ChallengeRaised":
        this.reqOfChallenge.set(a.challengeId, Number(a.kind) === 1 ? Number(a.subject) : this.reqOfToken.get(a.subject) ?? 0);
        break;
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
      case "bank.AuctionSettled":
        this.add(5, a.price);
        if (a.price !== 0n) this.price.set(rid(), a.price);
        break;
      case "bank.InstalmentsReleased": {
        const p = a.payout;
        this.add(6, p.verifierFee); this.add(7, p.holderFee); this.add(8, p.serverFee); this.add(9, p.guardianAmount);
        this.credit(p.verifier, p.verifierFee); this.credit(p.holder, p.holderFee); this.credit(p.guardian, p.guardianAmount);
        const r = rid();
        this.guardianGot.set(r, (this.guardianGot.get(r) ?? 0n) + p.guardianAmount);
        break;
      }
      case "bank.Activated": this.add(10, a.reviewPool); break;
      case "bank.SaleRefunded": this.add(15, a.price); break;
      case "bank.CancelledPayout": this.add(16, a.amount); this.credit(a.owner, a.amount); break;
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
  registryBal: bigint; bankBal: bigint; poolBal: bigint; registryHeld: bigint; bankHeld: bigint; poolHeld: bigint;
  inv: boolean[]; counts: Record<Stage, number>;
  /** The platform's home-page indicators: the sale prices of the EFTs sold and still standing, how many, the TR3
   *  those lands will mint over their terms, and the land-years before the next edition begins. */
  marketCap: bigint; sold: number; soldProjected: bigint; tillNextEdition: bigint;
};

/** Sold and still standing: not blocked, not cancelled (the platform's market cap counts these). */
export const standingSale = (r: Row) => (r.price ?? 0n) > 0n && r.termStart !== undefined && r.termStart !== 0
  && (r.cstatus === CovenantStatus.ACTIVE || r.cstatus === CovenantStatus.CLOSED);

export const INVARIANTS = [
  "The Registry holds exactly the escrow its requests record",
  "The Bank holds exactly its instalment balances, sale escrows and shares held for successors",
  "EcoChallenge holds exactly its review pools",
  "No instalment runs ahead of a verification, nor past the term",
  "TREE supply equals what was minted to patrons, guardians and referrers",
  "Every unit paid in was paid out to someone, or is still held",
];

type Part = { row: Row; registry: bigint; bank: bigint; pool: bigint; ok: boolean; token: boolean };
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
  const part: Part = { row, registry: r.verifierShare + r.deedComponent + r.attestationFee + r.judgmentFee, bank: 0n, pool: 0n, ok: true, token: false };
  if (r.tokenId === 0n) return part;
  const tid = r.tokenId;
  const [c, a, settling, pool, auction, w, undecided, owner, reward, holder] = await Promise.all([
    at("core", "getCovenant", [tid]), at("bank", "getAccount", [tid]), at("bank", "inSettlement", [tid]),
    at("challenge", "poolBalance", [tid]), at("bank", "hasAuction", [tid]), at("challenge", "getWindow", [tid]),
    at("challenge", "hasUndecidedChallenge", [tid]), at("token", "ownerOf", [tid]).catch(() => null),
    at("tree", "rewardOf", [tid]).catch(() => null), at("core", "holderOf", [tid]).catch(() => null),
  ]);
  const [settlement, halted] = await Promise.all([
    settling ? at("bank", "getSettlement", [tid]) : null,
    Number(c.termStart) !== 0 ? at("challenge", "releasesHalted", [tid]) : false,
  ]);
  part.token = true;
  part.bank = a.balance + (settlement ? settlement.price : 0n);
  part.pool = pool;
  part.ok = !(a.released > c.verifiedThrough || c.verifiedThrough > a.totalReleases);
  Object.assign(row, {
    cstatus: Number(c.status), termStart: Number(c.termStart), termEnd: Number(c.termEnd), edition: Number(c.edition),
    released: Number(a.released), total: Number(a.totalReleases), verifiedThrough: Number(c.verifiedThrough),
    balance: a.balance, frozen: a.frozen, halted, pool, verifier: c.verifier, guardian: c.guardian,
    windowOpen: Number(w.openedAt) !== 0 && !w.settled, windowAction: Number(w.action),
    challenged: row.challenged || undecided, price: a.price || settlement?.price || ledger.price.get(rid), owner: owner ?? undefined,
    projected: reward?.projected, holder: holder ?? undefined,
  });
  const cs = Number(c.status);
  if (row.status !== RequestStatus.ENDED || row.endReason === 7) {
    if (cs === CovenantStatus.BLOCKED) row.stage = "blocked";
    else if (settling) row.stage = "escrow";
    else if (cs === CovenantStatus.MINTED) row.stage = auction ? "auction" : "for-sale";
    else if (cs === CovenantStatus.ACTIVE && row.stage !== "complete") row.stage = t >= Number(c.termEnd) ? "ending" : "active";
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
  const [registryBal, bankBal, poolBal, supply, mp, mg, mr, info, gtas, nextToken] = await Promise.all([
    at("usdt", "balanceOf", [addr.registry]), at("usdt", "balanceOf", [addr.bank]), at("usdt", "balanceOf", [addr.challenge]),
    at("tree", "totalSupply"), at("tree", "mintedToPatrons"), at("tree", "mintedToGuardians"), at("tree", "mintedToReferrers"),
    at("tree", "editionInfo"), at("governance", "getGTAs"), at("token", "nextTokenId"),
  ]);
  const held = await Promise.all([...ledger.heldFor].map((h) => at("bank", "heldForSuccessor", [h])));
  let registryHeld = 0n, bankHeld = held.reduce((x: bigint, y: bigint) => x + y, 0n), poolHeld = 0n, ok3 = true, tokens = 0;
  for (const p of parts) {
    registryHeld += p.registry; bankHeld += p.bank; poolHeld += p.pool;
    if (!p.ok) ok3 = false;
    if (p.token) tokens++;
  }
  const rows = parts.map((p) => p.row);
  const inv = [
    registryBal === registryHeld,
    bankBal === bankHeld,
    poolBal === poolHeld,
    ok3 && Number(nextToken) - 1 === tokens,
    supply === mp + mg + mr,
    ledger.inflow() === ledger.outflow() + registryBal + bankBal + poolBal,
  ];
  const counts = {} as Record<Stage, number>;
  for (const r of rows) counts[r.stage] = (counts[r.stage] ?? 0) + 1;
  let marketCap = 0n, sold = 0, soldProjected = 0n;
  for (const r of rows) if (standingSale(r)) { marketCap += r.price!; sold++; soldProjected += r.projected ?? 0n; }
  const endsAt: bigint = info[3], landYears: bigint = info[2];
  return {
    t, block, rows, edition: Number(info[0]), landYears, tr3Supply: supply, gtas: gtas.length,
    registryBal, bankBal, poolBal, registryHeld, bankHeld, poolHeld, inv, counts,
    marketCap, sold, soldProjected, tillNextEdition: endsAt > landYears ? endsAt - landYears : 0n,
  };
}
