// Taking over: the person at the screen plays any part of the run. What they take over -- an actor, a request, a
// whole role or a country -- the simulated actors stop doing; each step they would have taken there becomes a move
// on the screen, with the values they would have used, for the person to make (changed if they like) or skip.
import { getAddress, type Address } from "viem";
import { nameOf, knownActors } from "./model";
import type { Key } from "./chain";

/** A step a simulated actor would have taken, waiting for the person instead. */
export type Move = {
  id: string; t: number; who: Address; c: Key; fn: string; args: unknown[]; label: string; rid: number;
};

/** The roles as the cast is registered ("Trust Admin, Sri Lanka" is the Trust Admin role). */
export const ROLES = ["guardian", "verifier", "patron", "Trust Admin", "GTA", "server", "foundation"] as const;
/** How a role reads when it is taken over whole. */
export const ROLE_LABEL: Record<string, string> = {
  guardian: "Every guardian", verifier: "Every verifier", patron: "Every patron", "Trust Admin": "Every Trust Admin",
  GTA: "Every GTA (the Council)", server: "The server", foundation: "The Foundation",
};
export type Role = (typeof ROLES)[number];
export const roleOf = (who: Address): string => {
  const r = knownActors().find((a) => a.address === getAddress(who))?.role ?? "";
  return r.startsWith("Trust Admin") ? "Trust Admin" : r;
};

/** What each role does in a run: the calls the simulated actors make in it, for acting freely as one. */
export const ROLE_CALLS: Record<string, [Key, string][]> = {
  guardian: [["registry", "requestVerification"], ["registry", "cancelRequest"], ["registry", "abandonRequest"], ["registry", "mint"],
    ["bank", "listForAuction"], ["core", "proposePayee"], ["core", "acceptPayee"], ["token", "list"], ["token", "acceptOffer"], ["tree", "claim"]],
  verifier: [["registry", "claim"], ["registry", "submitVerification"], ["deeds", "anchorPower"], ["deeds", "recordDocument"], ["deeds", "attest"],
    ["core", "verify"], ["core", "blockCovenant"], ["core", "acceptSeat"], ["challenge", "attestVerification"], ["challenge", "raise"],
    ["challenge", "respond"], ["challenge", "vote"], ["challenge", "withdraw"]],
  patron: [["usdt", "mint"], ["usdt", "approve"], ["bank", "bid"], ["bank", "settleAuction"], ["token", "list"], ["token", "buy"], ["token", "makeOffer"],
    ["token", "acceptOffer"], ["tree", "claim"], ["tree", "settle"]],
  "Trust Admin": [["admin", "addVerifier"], ["deeds", "grantPower"], ["deeds", "recordDocument"], ["core", "nominateVerifier"], ["registry", "lapseSale"],
    ["countries", "proposeSettings"], ["challenge", "vote"]],
  GTA: [["governance", "propose"], ["governance", "approve"], ["governance", "execute"], ["deeds", "attest"], ["challenge", "vote"]],
  server: [["admin", "setKyc"], ["governance", "emergencyFreeze"], ["tree", "closeEditionIfDue"]],
  foundation: [["governance", "proposeFeeSplit"], ["governance", "executeFeeSplit"], ["governance", "endExpiredFreeze"], ["bank", "releaseHeldHolderFees"]],
};

/** Calls that only keep the run moving: what anyone may call to move the protocol on (the simulation makes them from
 *  the first patron's wallet), and the test USDT a new actor is given and approves. They stay automatic unless the
 *  person asks for them too. */
export const HOUSEKEEPING = new Set(["challenge.seatPanel", "challenge.lapse", "challenge.closeWindow", "bank.settleAuction",
  "challenge.sweepReviewPool", "registry.closeUnsold", "tree.closeEditionIfDue", "tree.settle", "governance.execute",
  "usdt.mint", "usdt.approve"]);

export class Control {
  actors = new Set<Address>();
  requests = new Set<number>();
  roles = new Set<string>();
  countries = new Set<number>();
  /** Hand the housekeeping calls to the person as well. */
  housekeeping = false;
  /** Stop the clock when a move appears that is the person's. */
  pauseOnMove = true;
  /** Moves waiting, by actor, call and request: the latest values the simulated actor would have used. */
  moves = new Map<string, Move>();
  /** Called when a move appears that was not waiting before (the screen may pause the clock). */
  onNewMove: (m: Move) => void = () => {};
  countryOf: (rid: number) => number = () => 0;

  get active() { return this.actors.size + this.requests.size + this.roles.size + this.countries.size > 0; }

  /** Whether a step by `who` on request `rid` is the person's to make. */
  mine(who: Address, rid: number, call = ""): boolean {
    if (!this.active) return false;
    if (HOUSEKEEPING.has(call) && !this.housekeeping) return false;
    if (this.actors.has(getAddress(who))) return true;
    if (rid && this.requests.has(rid)) return true;
    if (this.roles.size && this.roles.has(roleOf(who))) return true;
    if (rid && this.countries.size && this.countries.has(this.countryOf(rid))) return true;
    return false;
  }

  /** The simulated actor would take this step: it waits for the person instead. */
  propose(t: number, who: Address, c: Key, fn: string, args: readonly unknown[], label: string, rid: number) {
    const id = `${getAddress(who)}|${c}.${fn}|${rid}`;
    const fresh = !this.moves.has(id);
    const m: Move = { id, t, who: getAddress(who), c, fn, args: [...args], label, rid };
    this.moves.set(id, m);
    if (fresh) this.onNewMove(m);
  }

  /** Moves the simulated actors stopped proposing a while ago are stale: what prompted them has passed. */
  prune(now: number) {
    for (const [id, m] of this.moves) if (now - m.t > 10 * 86_400) this.moves.delete(id);
  }

  describe(): string[] {
    return [
      ...[...this.actors].map((a) => `${nameOf(a)}`),
      ...[...this.requests].map((r) => `request #${r}`),
      ...[...this.roles].map((r) => ROLE_LABEL[r] ?? r),
      ...[...this.countries].map((c) => `country ${c}`),
    ];
  }

  clear() {
    this.actors.clear(); this.requests.clear(); this.roles.clear(); this.countries.clear(); this.moves.clear();
  }
}
