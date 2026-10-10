// What the app knows about the protocol: its timings, enums, countries, and the names of everyone in it.
import { getAddress, keccak256, toBytes, type Address } from "viem";

export const DAY = 86_400;
/** The protocol year in seconds, as the run's contracts are configured: a programme year on screen. */
export let YEAR = 365 * DAY;
export function setYear(days: number) { YEAR = days * DAY; }
export const START = 1_798_761_600; // 1 Jan 2027, anvil's genesis

/** The countries of the current run, as its scenario configures them. */
export const COUNTRIES: { code: number; name: string; short: string; flow: string }[] = [];
export function setCountries(list: { code: number; name: string; short: string; flow: string }[]) {
  COUNTRIES.splice(0, COUNTRIES.length, ...list);
}
export const countryName = (c: number) => COUNTRIES.find((x) => x.code === c)?.name ?? `country ${c}`;

export const RequestStatus = { NONE: 0, OPEN: 1, CLAIMED: 2, VERIFIED: 3, IN_FLOW: 4, ENDED: 5 } as const;
export const EndReason = ["", "cancelled", "abandoned", "failed", "unsold", "lapsed", "blocked", "completed", "refused", "not anchored", "attestation failed"];
export const COMPLETED = 7;
export const Step = { NONE: 0, POWER: 1, POWER_ANCHOR: 2, AGREEMENT: 3, DEED: 4, RECORDING: 5, ATTEST: 6, MINT: 7, SALE: 8 } as const;
export const StepName = ["", "power of attorney", "registering the power", "agreement", "deed", "recording", "attestation", "mint", "sale"];
export const CovenantStatus = { NONE: 0, MINTED: 1, ACTIVE: 2, BLOCKED: 3, CANCELLED: 4, CLOSED: 5, ENDED: 6 } as const;
export const BlockReason = { NONE: 0, BREACH: 1, DEED: 2, PARTITION: 3 } as const;
export const SubjectKind = { NONE: 0, REQUEST: 1, COVENANT: 2 } as const;
export const ChallengeState = { NONE: 0, OPEN: 1, RESPONDED: 2, SEATED: 3, DETERMINED: 4, LAPSED: 5, WITHDRAWN: 6 } as const;
/** The challenge menu (Flow Map v25, p15-17): the challenger picks the option at the raise. */
export const Option = { NONE: 0, W1A: 1, W1B: 2, T3A: 3, T3B: 4, T3C: 5, T3D: 6, T3E: 7 } as const;
export const OptionName = ["", "1A: the score", "1B: the documents", "3A: the Deed off the register", "3B: the score, or a missed breach",
  "3C: natural damage", "3D: the landowner's breach", "3E: a wrong block"];
/** Why instalments are held (Bank Account.holds bits). */
export const Holds = { BREACH: 1, VACANCY: 2, DEED: 4, HALT: 8, ACCESSION: 16, COUNCIL: 32 } as const;
export const Payee = ["attestor", "panel", "challenger", "guardian"];
export const Action = {
  NONE: 0, ADD_GTA: 1, REMOVE_GTA: 2, ADMIT_HOLDER: 3, FREEZE_HOLDER: 4, UNFREEZE_HOLDER: 5, RATIFY_FREEZE: 6,
  SET_COUNTRY_STATUS: 7, REVOKE_POWER: 8, SWITCH_PAYEE: 9, REASSIGN_VERIFIER: 10, CLEAR_PARCEL: 11,
  UNBLOCK_COVENANT: 12, CANCEL_COVENANT: 13, NOMINATE_VERIFIER: 14, FREEZE_DRIP: 15, SUSPEND_VERIFIER: 16,
  DISMISS_VERIFIER: 17, END_REWARD: 18, EXTEND_CLOCK: 19, ACQUISITION: 20, CANCEL_ROOT: 21, RECORD_DOCUMENT: 22,
} as const;
/** What a country vote decides: the GTAs and the country's own Trust Admins, more than half of them. */
export const Matter = { REPLACE_HOLDER: 0, SET_FEES: 1, APPLY_SETTINGS: 2 } as const;
export const ActionName = Object.fromEntries(Object.entries(Action).map(([k, v]) => [v, k.toLowerCase().replaceAll("_", " ")]));
/** The digital agreements (EcoTypes.Agreements), by the kind an account accepts. */
export const Agreement = {
  GRANTOR: keccak256(toBytes("GRANTOR_AGREEMENT")), PATRON: keccak256(toBytes("PATRON_SUBSCRIPTION")),
};

/** What a challenge will come to, as the simulation plans it. */
export const Outcome = { DISMISS: 0, UPHOLD: 1, LAPSE: 2, WITHDRAW: 3 } as const;
export const OutcomeName = ["dismissed", "upheld", "lapsed", "withdrawn"];

// ---- names ----

const names = new Map<string, { name: string; role: string }>();

export function register(a: Address, name: string, role: string): Address {
  const k = getAddress(a);
  names.set(k.toLowerCase(), { name, role });
  return k;
}

export function nameOf(a: string | undefined | null): string {
  if (!a) return "nobody";
  if (/^0x0{40}$/i.test(a)) return "nobody";
  return names.get(a.toLowerCase())?.name ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function roleOf(a: string): string {
  return names.get(a.toLowerCase())?.role ?? "";
}

export function resetNames() {
  names.clear();
}

/** Everyone the run has named, for the explorer's "send as". */
export function knownActors(): { address: Address; name: string; role: string }[] {
  return [...names.entries()].map(([a, v]) => ({ address: getAddress(a), name: v.name, role: v.role }))
    .sort((x, y) => x.role.localeCompare(y.role) || x.name.localeCompare(y.name, "en", { numeric: true }));
}

// ---- formatting ----

export const toUnits = (wei: bigint) => Number(wei / 10n ** 12n) / 1e6;

export function money(wei: bigint, digits = 0): string {
  return toUnits(wei).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function dateOf(t: number): string {
  return new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function shortDate(t: number): string {
  return new Date(t * 1000).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function hectares(landUnits: number): string {
  return `${(landUnits / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} ha`;
}

export function span(seconds: number): string {
  const d = Math.round(seconds / DAY);
  if (Math.abs(d) >= 730) return `${(d / 365).toFixed(1)} years`;
  if (Math.abs(d) >= 60) return `${Math.round(d / 30)} months`;
  return `${d} days`;
}
