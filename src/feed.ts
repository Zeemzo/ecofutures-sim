// Turns each protocol event into a sentence a person can follow.
import type { Decoded } from "./chain";
import type { Ledger } from "./ledger";
import { nameOf, money, dateOf, countryName, hectares, StepName, EndReason, ActionName, Payee, OptionName, BlockReason } from "./model";

export type Category = "lifecycle" | "money" | "challenge" | "term" | "governance" | "alert" | "note";
export type Entry = { t: number; rid: number; cat: Category; text: string; minor?: boolean; seq: number };

const usd = (v: bigint) => `${money(v)} USDT`;
const tree = (v: bigint) => `${money(v)} TR3`;
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
    `${nameOf(a.verifier)} verifies ${r}: EcoScore ${n(a.ecoScore)}. The 21-day watchdog window opens.`],
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
  "registry.SaleLapsed": (a, r) => ["alert", `${r}'s sale lapses: the Deed was not recorded and attested within 30 days of the sale. The buyer is refunded${a.relistable ? "; the EFT may be listed again" : ", and the EFT lapses"}.`],
  "registry.VerifierReassigned": (a, r) => ["governance", `${r} is reassigned from ${nameOf(a.oldVerifier)} to ${nameOf(a.newVerifier)}.`],

  // ---- documents ----
  "deeds.PowerGranted": (a, r) => ["lifecycle", `${nameOf(a.holder)} grants ${nameOf(a.verifier)} the power of attorney for ${r}.`, true],
  "deeds.PowerAnchored": (a, r) => ["lifecycle", `${nameOf(a.by)} registers the power for ${r}.`, true],
  "deeds.PowerReplaced": (a, r) => ["term", `${nameOf(a.verifier)}'s new power for ${r} is recorded.`, true],
  "deeds.PowerRevoked": (a, r) => ["governance", `The power for ${r} is revoked ${a.authorised ? "with" : "without"} the Council's authority.`],
  "deeds.DocumentRecorded": (a, r) => ["lifecycle", `${nameOf(a.by)} records the ${StepName[n(a.step)]} for ${r}.`, true],
  "deeds.DocumentAttested": (a, r) => ["lifecycle", `${nameOf(a.attester)} attests ${r}'s document.`],
  "deeds.ExtensionAsked": (a, r) => ["lifecycle", `${nameOf(a.by)} asks for 14 more days on ${r}.`],
  "deeds.ExtensionDecided": (a, r) => ["lifecycle", `${nameOf(a.by)} ${a.granted ? "grants" : "refuses"} the extension on ${r}.`, true],
  "deeds.RefusalRecorded": (a, r) => ["alert", `The landowner of ${r} refuses to sign; ${nameOf(a.verifier)} keeps its verification fee.`],
  "deeds.RequestLapsed": (_a, r) => ["alert", `${r}'s paper clock runs out: the request lapses.`],
  "deeds.RestorationRecorded": (a, r) => ["term", `${nameOf(a.by)} records a fresh grant to put ${r}'s Deed back on the register.`],
  "deeds.RestorationAttested": (a, r) => ["term", `${nameOf(a.attester)} attests ${r}'s restored Deed.`],

  // ---- the term ----
  "core.CovenantActivated": (a, r) => ["term", `${r}'s term begins: edition ${n(a.edition)}, running to ${dateOf(n(a.termEnd))}.`],
  "core.CovenantVerified": (a, r) => ["term",
    `${nameOf(a.verifier)} re-verifies ${r} (interval ${n(a.verifiedThrough)}). A 30-day review window opens.`, true],
  "core.CovenantBlocked": (a, r) => ["alert", n(a.reason) === BlockReason.DEED
    ? `${r} is blocked: its Deed is off the register. The Holder has 60 days to restore it.`
    : n(a.reason) === BlockReason.PARTITION ? `${r} is blocked pending a partition action.` : `${nameOf(a.by)} blocks ${r}: ${a.evidence || "a breach"}.`],
  "core.CovenantUnblocked": (a, r) => ["term", `${nameOf(a.by)} lifts ${r}'s block.`],
  "core.CovenantCancelled": (a, r) => ["alert", `${nameOf(a.by)} cancels ${r} before its sale.`],
  "core.CovenantClosed": (_a, r) => ["term", `${r} closes.`],
  "core.CovenantClosedEarly": (a, r) => ["alert", `${r} closes early: ${usd(a.paidToPatron)} of unreleased escrow goes to the patron.`],
  "core.CovenantEnded": (_a, r) => ["term", `${r} reaches its End Date.`],
  "core.DeedRestored": (_a, r) => ["term", `${r}'s Deed is restored: the block lifts.`],
  "core.ReverificationDue": (a, r) => ["term", `${r} must be re-verified by ${dateOf(n(a.by))}: natural damage was found.`],
  "core.RewardEndedByCouncil": (_a, r) => ["alert", `The Council ends ${r}'s TR3 for deliberate fraud.`],
  "core.VerdictApplied": (a, r) => ["challenge", `${r}: the upheld option ${OptionName[n(a.option)]} takes effect.`, true],
  "core.PayeeChanged": (a, r) => ["term", `${r}'s payee changes to ${nameOf(a.newGuardian)}.`],
  "core.VerifierReplaced": (a, r) => ["term", `${nameOf(a.newVerifier)} takes ${r}'s seat from ${nameOf(a.oldVerifier)}.`],
  "parties.SeatVacated": (a, r) => ["alert", `${nameOf(a.verifier)} loses ${r}'s seat.`],
  "parties.VerifierNominated": (a, r) => ["term", `${nameOf(a.by)} nominates ${nameOf(a.nominee)} for ${r}'s seat.`, true],
  "parties.LandSaleProposed": (a, r) => ["term", `${nameOf(a.seller)} sells the land under ${r} to ${nameOf(a.buyer)}.`],
  "parties.LandSaleApproved": (a, r) => ["term", `${nameOf(a.verifier)} approves the land sale on ${r}${a.accessionDue ? `; payments wait for ${nameOf(a.buyer)} to accede` : ""}.`, true],
  "parties.Acceded": (a, r) => ["term", `${nameOf(a.buyer)} accedes to ${r}'s Grantor Agreement.`],
  "parties.AccessionLapsed": (a, r) => ["alert", `${nameOf(a.buyer)} did not accede to ${r}: the landowner's share goes to the patron.`],
  "parties.Acquired": (a, r) => ["alert", `${n(a.permille) / 10}% of ${r}'s land is compulsorily acquired: ${usd(a.paidToPatron)} to the patron.`],

  // ---- the market and the bank ----
  "market.AuctionListed": (a, r) => ["lifecycle", `${nameOf(a.seller)} lists ${r} for auction from ${usd(a.startPrice)}, ending ${dateOf(n(a.endsAt))}.`],
  "market.BidPlaced": (a, r) => ["money", `${nameOf(a.bidder)} bids ${usd(a.amount)} on ${r}.`, true],
  "market.AuctionSettled": (a, r) => a.price === 0n ? ["lifecycle", `${r}'s auction ends with no bid.`]
    : a.kycPending ? ["money", `${nameOf(a.buyer)} wins ${r} for ${usd(a.price)}; the sale waits for its identity check.`] : null,
  "market.SaleCompleted": (a, r) => ["money", a.active ? `${nameOf(a.buyer)} buys ${r} for ${usd(a.price)}.`
    : `${nameOf(a.buyer)} buys ${r} for ${usd(a.price)}. Path B: the price waits in escrow until the Deed is recorded and attested.`],
  "market.SaleRefunded": (a, r) => ["money", `${nameOf(a.buyer)} is refunded ${usd(a.price)} for ${r}.`],
  "market.StaleSaleCancelled": (a, r) => ["alert", `${r}'s sale is called off: ${nameOf(a.buyer)} ${a.failedCheck ? "failed" : "did not complete"} the identity check, and is refunded ${usd(a.price)}.`],
  "bank.Activated": (a, r) => ["money",
    `${r}: ${usd(a.firstInstalment)} is paid at once, ${usd(a.reviewPool)} funds the review pool, and the rest is released over ${n(a.totalReleases)} instalments, every ${Math.round(n(a.interval) / 2_629_800)} months.`, true],
  "bank.InstalmentsReleased": (a, r) => {
    const p = a.payout;
    const what = n(a.count) === 0 ? `${r}'s first instalment is paid` : `${r} releases ${n(a.count)} instalment${n(a.count) === 1 ? "" : "s"}`;
    return ["money", `${what}: ${nameOf(p.guardian)} ${usd(p.guardianAmount)}${p.consideration > 0n ? ` (of which ${usd(p.consideration)} the annual consideration)` : ""}, ${nameOf(p.verifier)} ${usd(p.verifierFee)}, ${nameOf(p.holder)} ${usd(p.holderFee)}, the Foundation ${usd(p.foundationFee)}.`];
  },
  "bank.HoldSet": (a, r) => ["alert", `${r}'s instalments are ${n(a.holds) === 0 ? "released from every hold" : "held"}.`, true],
  "bank.AccountClosed": (a, r) => a.toPatron > 0n ? ["money", `${r}'s held instalments go to the patron at the End Date: ${usd(a.toPatron)}.`] : null,
  "bank.PaidToPatron": (a, r) => ["money", `${nameOf(a.owner)} receives ${usd(a.amount)} of ${r}'s unreleased escrow.`],
  "bank.HolderFeeHeld": (a, r) => ["money", `${r}'s Trust Admin share, ${usd(a.amount)}, is withheld from ${nameOf(a.holder)}.`, true],
  "bank.HolderFeeReleased": (a) => ["money", `${nameOf(a.successor)} receives ${usd(a.amount)} withheld from ${nameOf(a.holder)}.`],
  "bank.FeeSplitSet": (a) => ["governance", `The fee split changes: the verifier now takes ${n(a.verifierPermille) / 10}% of each instalment.`],

  // ---- challenges ----
  "challenge.ChallengeRaised": (a, r) => ["challenge",
    `${nameOf(a.challenger)} challenges ${r} against ${nameOf(a.defendant)}, option ${OptionName[n(a.option)]}: challenge ${a.challengeId}.`],
  "challenge.ChallengeResponded": (a, r) => ["challenge", `${nameOf(a.defendant)} answers challenge ${a.challengeId} on ${r}.`, true],
  "challenge.PanelSeated": (a, r) => ["challenge",
    `Judges are ${a.redrawn ? "redrawn" : "drawn"} for challenge ${a.challengeId} on ${r}: ${(a.panel as string[]).map(nameOf).join(", ")}.`],
  "challenge.VoteCast": (a) => ["challenge", `${nameOf(a.member)} votes to ${a.upheld ? "uphold" : "dismiss"} challenge ${a.challengeId}.`, true],
  "challenge.ChallengeDetermined": (a, r) => ["challenge", `Challenge ${a.challengeId} on ${r} (${OptionName[n(a.option)]}) is ${a.upheld ? "upheld" : "dismissed"}.`],
  "challenge.ChallengeLapsed": (a, r) => ["challenge", `Challenge ${a.challengeId} on ${r} lapses: the judges did not decide by the deadline.`],
  "challenge.ChallengeWithdrawn": (a, r) => ["challenge", `Challenge ${a.challengeId} on ${r} is withdrawn.`],
  "challenge.VerificationAttested": (a, r) => ["term", `${nameOf(a.attestor)} attests ${r}'s re-verification.`, true],
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
  "governance.ReplacementProposed": (a) => ["governance", `${nameOf(a.by)} proposes that ${nameOf(a.successor)} replace ${nameOf(a.holder)}: the Council and the country's other Trust Admins vote.`],
  "governance.ReplacementExecuted": (a) => ["governance", `${nameOf(a.successor)} replaces ${nameOf(a.holder)}, by a majority of the Council and the country's Trust Admins.`],
  "governance.DocumentRecorded": (a) => ["governance", `The Council records a document on chain (${a.uri}).`],
  "governance.FeeSplitProposed": (a) => ["governance", `A new fee split is proposed; it can take effect from ${dateOf(n(a.readyAt))}.`],
  "admin.HolderAdded": (a) => ["governance", `${nameOf(a.holder)} is admitted as a Trust Admin in ${countryName(n(a.country))}.`],
  "admin.HolderRemoved": (a) => ["governance", `${nameOf(a.holder)} is removed as a Trust Admin.`, true],
  "admin.VerifierRetired": (a) => ["governance", `${nameOf(a.verifier)} moves organisation: its old wallet takes no new work.`],
  "admin.HolderReplaced": (a) => ["governance", `${nameOf(a.successor)} succeeds ${nameOf(a.old)}.`],
  "admin.HolderFrozen": (a) => ["governance", `${nameOf(a.holder)} is ${a.frozen ? "frozen" : "unfrozen"}.`],
  "admin.VerifierAdded": (a) => ["governance", `${nameOf(a.inviter)} invites ${nameOf(a.verifier)} as a verifier (organisation ${a.orgId}, under ${nameOf(a.holder)}).`, true],
  "admin.VerifierDismissed": (a) => ["alert", `${nameOf(a.verifier)} is dismissed: ${a.finding}.`],
  "admin.VerifierSuspended": (a) => ["alert", `${nameOf(a.verifier)} is suspended.`],
  "admin.PartyFlagged": (a) => ["alert", `${nameOf(a.party)} is flagged (${n(a.flagsInWindow)} in 24 months).`],
  "countries.CountryStatusSet": (a) => ["governance", `${countryName(n(a.country))} is ${n(a.status) === 1 ? "open again" : "suspended"}.`],
  "countries.SettingsApplied": (a) => ["governance",
    `${countryName(n(a.country))}'s settings change: terms ${n(a.settings.minTermYears)} to ${n(a.settings.maxTermYears)} years, for new requests.`],

  // ---- editions, the Reserve and Relics ----
  "tree.LandPlaced": (a, r) => ["term", `${r}'s land takes its place at the mint: ${ha(a.landYears)} ha-yr in edition ${n(a.edition)}, for ${tree(a.tr3AtFullScore)} at an EcoScore of 100.`],
  "tree.PlaceReleased": (a, r) => ["money", a.roomReopened ? `${r}'s land never became a covenant: its room in edition ${n(a.edition)} reopens.`
    : `${r}'s land never became a covenant: the ${tree(a.burned)} its place held are burned.`, true],
  "tree.EditionClosed": (a) => ["alert", a.byClock
    ? `Edition ${n(a.edition)}'s eight years are up with ${ha(a.landYears)} ha-yr placed: the ${tree(a.burned)} no land took are burned${n(a.edition) < 21 ? `, and edition ${n(a.edition) + 1} opens` : ", and the programme closes"}.`
    : `Edition ${n(a.edition)} closes${a.burned > 0n ? `, its last ${tree(a.burned)} of room burned: the next land did not fit` : " full"}${n(a.edition) < 21 ? `; edition ${n(a.edition) + 1} opens` : "; the programme closes"}.`],
  "tree.StreamReleased": (a, r) => ["money", `${r} releases ${tree(a.amount)} at an EcoScore of ${n(a.score)}.`, true],
  "tree.ReserveCredited": (a, r) => ["money", `${tree(a.amount)} of ${r}'s allocation goes to the Overcharge Reserve (${["the score's shortfall", "days blocked", "a breach", "an early end", "an unpaid boost"][n(a.source)]}).`, true],
  "tree.BoostPaid": (a, r) => ["money", `${r} is boosted ${tree(a.amount)} from its overcharge.`, true],
  "tree.BoostReturned": (a, r) => ["money", `${tree(a.amount)} of ${r}'s boost went unpaid and returns to the Reserve.`, true],
  "tree.ReserveFinalized": (a) => ["alert", `The Overcharge Reserve is finalised: ${tree(a.amount)} are burned.`],
  "overcharge.RelicMinted": (a, r) => ["term", `${r}'s EFT becomes a Relic of edition ${n(a.edition)} for ${nameOf(a.owner)}, with a cap of ${tree(a.cap)}.`],
  "overcharge.OverchargeCommitted": (a, r) => ["money", `A Relic overcharges ${r}: M = ${(Number(a.mE6) / 1e6).toFixed(2)}, ${tree(a.commit)} committed from the Reserve.`],
  "overcharge.Transmuted": (a) => ["money", `Two Relics are transmuted into one of edition ${n(a.edition)}, with a cap of ${tree(a.cap)}.`],

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
