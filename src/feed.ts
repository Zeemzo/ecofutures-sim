// Turns each protocol event into a sentence a person can follow.
import type { Decoded } from "./chain";
import type { Ledger } from "./ledger";
import { nameOf, money, dateOf, countryName, hectares, StepName, EndReason, ActionName, Payee } from "./model";

export type Category = "lifecycle" | "money" | "challenge" | "term" | "governance" | "alert" | "note";
export type Entry = { t: number; rid: number; cat: Category; text: string; minor?: boolean; seq: number };

const usd = (v: bigint) => `${money(v)} USDT`;
const tree = (v: bigint) => `${money(v)} TREE`;
const n = (x: unknown) => Number(x);
/** Land-years (hundredths of a hectare × years) as hectare-years. */
const ha = (v: bigint) => (Number(v) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });

type Fmt = (a: Record<string, any>, r: string, L: Ledger) => [Category, string, boolean?] | null;

const FORMATS: Record<string, Fmt> = {
  // ---- the request ----
  "registry.VerificationRequested": (a, r) => ["lifecycle",
    `${nameOf(a.guardian)} asks for verification of ${hectares(n(a.landUnits))} in ${countryName(n(a.country))} for ${n(a.termYears)} years (${r}), paying ${usd(a.verificationFee + a.attestationFee + a.judgmentFee)} into escrow.`],
  "registry.RequestClaimed": (a, r) => ["lifecycle", `${nameOf(a.verifier)} claims ${r} for ${nameOf(a.holder)}.`, true],
  "registry.VerificationSubmitted": (a, r) => ["lifecycle",
    `${nameOf(a.verifier)} verifies ${r}: EcoScore ${n(a.ecoScore)}. The 14-day watchdog window opens.`],
  "registry.VerifierPaid": (a, r) => ["money", `${nameOf(a.verifier)} is paid ${usd(a.amount)} for verifying ${r}.`, true],
  "registry.AttestationPaid": (a, r) => ["money", `${nameOf(a.attester)} is paid ${usd(a.amount)} for attesting ${r}'s deed.`, true],
  "registry.JudgmentPaid": (a, r) => ["money", `The panel on ${r} is paid ${usd(a.amount)}.`, true],
  "registry.RequestEnded": (a, r) => ["lifecycle",
    n(a.reason) === 7 ? null as any : `${r} ends: ${EndReason[n(a.reason)]}.${a.refund > 0n ? ` ${usd(a.refund)} goes back to the guardian.` : ""}`],
  "registry.RequestReopened": (a, r) => ["challenge", `${r} reopens for another verifier; ${nameOf(a.barredVerifier)} is barred from it.`],
  // the last step done reports no next step: the flow is complete and the term runs from here
  "registry.FlowAdvanced": (a, r) => ["lifecycle", n(a.step) ? `${r} moves to its next step: ${StepName[n(a.step)]}.` : `${r} has completed its flow.`, true],
  "registry.CovenantMinted": (a, r) => ["lifecycle", `${r} is minted as EFT #${a.tokenId} to ${nameOf(a.guardian)}.`],
  "registry.SaleRecorded": (a, r) => ["money", a.complete
    ? `${nameOf(a.buyer)} buys ${r} for ${usd(a.price)}.`
    : `${nameOf(a.buyer)} buys ${r} for ${usd(a.price)}. Path B: the price waits in escrow until the recording is attested.`],
  "registry.SaleLapsed": (_a, r) => ["alert", `${r}'s sale lapses: the recording was not attested within 60 days. The buyer is refunded.`],
  "registry.VerifierReassigned": (a, r) => ["governance", `${r} is reassigned from ${nameOf(a.oldVerifier)} to ${nameOf(a.newVerifier)}.`],

  // ---- documents ----
  "deeds.PowerGranted": (a, r) => ["lifecycle", `${nameOf(a.holder)} grants ${nameOf(a.verifier)} the power of attorney for ${r}.`, true],
  "deeds.PowerAnchored": (a, r) => ["lifecycle", `${nameOf(a.by)} registers the power for ${r}.`, true],
  "deeds.PowerRevoked": (a, r) => ["governance", `The power for ${r} is revoked ${a.authorised ? "with" : "without"} the Council's authority.`],
  "deeds.DocumentRecorded": (a, r) => ["lifecycle", `${nameOf(a.by)} records the ${StepName[n(a.step)]} for ${r}.`, true],
  "deeds.DocumentAttested": (a, r) => ["lifecycle",
    `${nameOf(a.attester)} attests ${r}'s document${a.backstop ? ", as the Council's backstop" : ""}.`],

  // ---- the term ----
  "core.CovenantActivated": (a, r) => ["term", `${r}'s term begins: edition ${n(a.edition)}, running to ${dateOf(n(a.termEnd))}.`],
  "core.CovenantVerified": (a, r) => ["term",
    `${nameOf(a.verifier)} re-verifies ${r} (interval ${n(a.verifiedThrough)}). A 30-day review window opens.`, true],
  "core.CovenantBlocked": (a, r) => ["alert", `${nameOf(a.verifier)} blocks ${r}: ${a.evidence}.`],
  "core.CovenantUnblocked": (a, r) => ["term", `${nameOf(a.by)} unblocks ${r}.`],
  "core.CovenantCancelled": (a, r) => ["alert", `${nameOf(a.by)} cancels ${r}. ${usd(a.balancePaid)} still held goes to the EFT's owner.`],
  "core.CovenantClosed": (_a, r) => ["term", `${r} closes.`],
  "core.HeldReleased": (_a, r) => ["term", `${r}'s held instalments are released.`],
  "core.PayeeChanged": (a, r) => ["term", `The land under ${r} changes hands: ${nameOf(a.newGuardian)} is now the payee.`],
  "core.VerifierNominated": (a, r) => ["term", `${nameOf(a.by)} nominates ${nameOf(a.nominee)} for ${r}'s seat.`, true],
  "core.VerifierReplaced": (a, r) => ["term", `${nameOf(a.newVerifier)} takes ${r}'s seat from ${nameOf(a.oldVerifier)}.`],

  // ---- the bank ----
  "bank.AuctionListed": (a, r) => ["lifecycle", `${nameOf(a.seller)} lists ${r} for auction from ${usd(a.startPrice)}, ending ${dateOf(n(a.endsAt))}.`],
  "bank.BidPlaced": (a, r) => ["money", `${nameOf(a.bidder)} bids ${usd(a.amount)} on ${r}.`, true],
  "bank.AuctionSettled": (a, r) => a.price === 0n ? ["lifecycle", `${r}'s auction ends with no bid.`] : null,
  "bank.Activated": (a, r) => ["money",
    `${r}: ${usd(a.firstInstalment)} is paid at once, ${usd(a.reviewPool)} funds the review pool, and the rest is released over ${n(a.totalReleases)} instalments.`, true],
  "bank.InstalmentsReleased": (a, r) => {
    const p = a.payout;
    const what = n(a.count) === 0 ? `${r}'s first instalment is paid` : `${r} releases ${n(a.count)} instalment${n(a.count) === 1 ? "" : "s"}`;
    return ["money", `${what}: ${nameOf(p.guardian)} ${usd(p.guardianAmount)}, ${nameOf(p.verifier)} ${usd(p.verifierFee)}, ${nameOf(p.holder)} ${usd(p.holderFee)}, the server ${usd(p.serverFee)}.`];
  },
  "bank.HolderFeeHeld": (a, r) => ["money", `${r}'s Trust Admin share, ${usd(a.amount)}, is held for ${nameOf(a.holder)}'s successor.`, true],
  "bank.HolderFeeReleased": (a) => ["money", `${nameOf(a.successor)} receives ${usd(a.amount)} held for it since ${nameOf(a.holder)} was removed.`],
  "bank.SaleRefunded": (a, r) => ["money", `${nameOf(a.buyer)} is refunded ${usd(a.price)} for ${r}.`],
  "bank.CancelledPayout": (a, r) => ["money", `${nameOf(a.owner)} receives ${usd(a.amount)} from cancelled ${r}.`],
  "bank.DripFrozen": (a, r) => ["alert", a.frozen ? `${r}'s instalments are held.` : `${r}'s instalments flow again.`],
  "bank.FeeSplitSet": (a) => ["governance", `The fee split changes: the verifier now takes ${n(a.verifierPermille) / 10}% of each instalment.`],

  // ---- challenges ----
  "challenge.ChallengeRaised": (a, r) => ["challenge",
    `${nameOf(a.challenger)} challenges ${nameOf(a.defendant)}'s verification of ${r} (${n(a.kind) === 1 ? "before the mint" : "in the term"}): challenge ${a.challengeId}.`],
  "challenge.ChallengeResponded": (a, r) => ["challenge", `${nameOf(a.defendant)} answers challenge ${a.challengeId} on ${r}.`, true],
  "challenge.PanelSeated": (a, r) => ["challenge",
    `A panel is ${a.redrawn ? "redrawn" : "drawn"} for challenge ${a.challengeId} on ${r}: ${(a.panel as string[]).map(nameOf).join(", ")}.`],
  "challenge.VoteCast": (a) => ["challenge",
    `${nameOf(a.member)} votes to ${a.upheld ? "uphold" : a.inBreach ? "find the land in breach on" : "dismiss"} challenge ${a.challengeId}.`, true],
  "challenge.ChallengeDetermined": (a, r) => ["challenge", `Challenge ${a.challengeId} on ${r} is decided: ${a.upheld
    ? `upheld, the ${n(a.finding) === 1 ? "score" : "documents"} wrong`
    : a.inBreach ? "the land is in breach" : "dismissed"}.`],
  "challenge.ChallengeLapsed": (a, r) => ["challenge", `Challenge ${a.challengeId} on ${r} lapses: the panel did not decide by the deadline.`],
  "challenge.ChallengeWithdrawn": (a, r) => ["challenge", `Challenge ${a.challengeId} on ${r} is withdrawn.`],
  "challenge.SeatVacated": (a, r) => ["alert", `${nameOf(a.verifier)} loses ${r}'s seat.`],
  "challenge.BreachHeld": (_a, r) => ["alert", `${r} is held for a breach until it is cured.`],
  "challenge.BreachCured": (_a, r) => ["term", `${r}'s breach is cured.`],
  "challenge.VerificationAttested": (a, r) => ["term", `${nameOf(a.attestor)} attests ${r}'s verification.`, true],
  "challenge.WindowOpened": (a, r) => a.halted ? ["alert", `${r}'s releases halt: three review windows in a row went unattested.`] : null,
  "challenge.ReviewFeePaid": (a, r) => ["money", `${nameOf(a.to)} is paid ${usd(a.amount)} from ${r}'s review pool (${Payee[n(a.payee)]}).`, true],

  // ---- governance ----
  "governance.ProposalCreated": (a) => ["governance", `${nameOf(a.proposer)} proposes to the Council: ${ActionName[n(a.action)]}.`, true],
  "governance.ProposalExecuted": (a) => ["governance", `The Council decides: ${ActionName[n(a.action)]}.`],
  "governance.EmergencyFreeze": (a) => ["governance", `${nameOf(a.by)} freezes ${nameOf(a.holder)} in an emergency, until ${dateOf(n(a.until))}.`],
  "governance.EmergencyFreezeEnded": (a) => ["governance",
    `${nameOf(a.holder)}'s emergency freeze ends${a.ratified ? ", ratified by the Council" : ": the Council did not ratify it"}.`],
  "governance.GTASeated": (a) => ["governance", `${nameOf(a.gta)} takes a seat on the Council.`],
  "governance.GTAUnseated": (a) => ["governance", `${nameOf(a.gta)} leaves the Council.`],
  "governance.FeeSplitProposed": (a) => ["governance", `A new fee split is proposed; it can take effect from ${dateOf(n(a.readyAt))}.`],
  "admin.HolderAdded": (a) => ["governance", `${nameOf(a.holder)} is admitted as a Trust Admin in ${countryName(n(a.country))}.`],
  "admin.HolderRemoved": (a) => ["governance", `${nameOf(a.holder)} is removed as a Trust Admin.`],
  "admin.HolderReplaced": (a) => ["governance", `${nameOf(a.successor)} succeeds ${nameOf(a.old)}.`],
  "admin.HolderFrozen": (a) => ["governance", `${nameOf(a.holder)} is ${a.frozen ? "frozen" : "unfrozen"}.`],
  "admin.VerifierAdded": (a) => ["governance", `${nameOf(a.holder)} admits ${nameOf(a.verifier)} as a verifier (organisation ${a.orgId}).`, true],
  "admin.VerifierDismissed": (a) => ["alert", `${nameOf(a.verifier)} is dismissed: ${a.finding}.`],
  "admin.VerifierSuspended": (a) => ["alert", `${nameOf(a.verifier)} is suspended.`],
  "admin.PartyFlagged": (a) => ["alert", `${nameOf(a.party)} is flagged (${n(a.flagsInWindow)} in 24 months).`],
  "countries.CountryStatusSet": (a) => ["governance", `${countryName(n(a.country))} is ${n(a.status) === 1 ? "open again" : "suspended"}.`],
  "countries.SettingsApplied": (a) => ["governance",
    `${countryName(n(a.country))}'s settings change: terms ${n(a.settings.minTermYears)} to ${n(a.settings.maxTermYears)} years, for new requests.`],

  // ---- editions ----
  "tree.LandPlaced": (a, r) => ["term", `${r}'s land takes its place: ${ha(a.landYears)} ha-yr in edition ${n(a.edition)}${n(a.lastEdition) !== n(a.edition) ? `, running on into edition ${n(a.lastEdition)}` : ""}, for ${tree(a.tr3AtFullScore)} at an EcoScore of 100.`],
  "tree.EditionClosed": (a) => ["alert", a.byClock
    ? `Edition ${n(a.edition)}'s eight years are up with ${ha(a.landYears)} ha-yr placed: the ${tree(a.burned)} no land took are burned${n(a.edition) < 21 ? `, and edition ${n(a.edition) + 1} opens` : ", and the programme closes"}.`
    : `Edition ${n(a.edition)} is full${n(a.edition) < 21 ? `: edition ${n(a.edition) + 1} opens` : ": the programme closes"}.`],

  // ---- TR3, resale ----
  "tree.RewardClaimed": (a, r) => ["money",
    `TR3 is claimed on ${r}: ${tree(a.patronAmount)} to ${nameOf(a.patron)}, ${tree(a.guardianAmount)} to ${nameOf(a.guardian)}${a.referrerAmount > 0n ? `, ${tree(a.referrerAmount)} to ${nameOf(a.referrer)}` : ""}.`, true],
  "token.Listed": (a, r) => ["money", `${nameOf(a.seller)} lists ${r} for sale at ${usd(a.price)}.`],
  "token.ListingCancelled": (_a, r) => ["money", `${r} is taken off sale.`, true],
  "token.OfferMade": (a, r) => ["money", `${nameOf(a.buyer)} offers ${usd(a.price)} for ${r}.`],
  "token.OfferWithdrawn": (a, r) => ["money", `${nameOf(a.buyer)} withdraws an offer on ${r}.`, true],
  "token.Sold": (a, r) => ["money", a.byOffer
    ? `${nameOf(a.seller)} accepts ${nameOf(a.buyer)}'s offer: ${r} sold for ${usd(a.price)}.`
    : `${nameOf(a.buyer)} buys ${r} from ${nameOf(a.seller)} at the listed ${usd(a.price)}.`],
};

export function describe(e: Decoded, L: Ledger, seq: number, t: number): Entry | null {
  const f = FORMATS[`${e.contract}.${e.name}`];
  if (!f) return null;
  const rid = L.ridOf(e);
  const out = f(e.args, rid ? `#${rid}` : "the covenant", L);
  if (!out || !out[1]) return null;
  return { t, rid, cat: out[0], text: out[1], minor: out[2], seq };
}
