// What the app knows about the protocol: its timings, enums, countries, and the names of everyone in it.
import { getAddress, type Address } from "viem";

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
export const EndReason = ["", "cancelled", "abandoned", "failed", "unsold", "lapsed", "blocked", "completed"];
export const Step = { NONE: 0, POWER: 1, POWER_ANCHOR: 2, AGREEMENT: 3, DEED: 4, RECORDING: 5, ATTEST: 6, MINT: 7, SALE: 8 } as const;
export const StepName = ["", "power of attorney", "registering the power", "agreement", "deed", "recording", "attestation", "mint", "sale"];
export const CovenantStatus = { NONE: 0, MINTED: 1, ACTIVE: 2, BLOCKED: 3, CANCELLED: 4, CLOSED: 5 } as const;
export const SubjectKind = { NONE: 0, REQUEST: 1, COVENANT: 2 } as const;
export const ChallengeState = { NONE: 0, OPEN: 1, RESPONDED: 2, SEATED: 3, DETERMINED: 4, LAPSED: 5, WITHDRAWN: 6 } as const;
export const Finding = { NONE: 0, SCORE: 1, DOCUMENTS: 2 } as const;
export const WindowAction = { NONE: 0, ATTESTED: 1, CHALLENGED: 2, LAPSED: 3 } as const;
export const Payee = ["attestor", "panel", "challenger", "guardian"];
export const Action = {
  NONE: 0, ADD_GTA: 1, REMOVE_GTA: 2, ADMIT_HOLDER: 3, REMOVE_HOLDER: 4, REPLACE_HOLDER: 5, FREEZE_HOLDER: 6,
  UNFREEZE_HOLDER: 7, RATIFY_FREEZE: 8, APPLY_SETTINGS: 9, SET_COUNTRY_STATUS: 10, REVOKE_POWER: 11,
  SWITCH_PAYEE: 12, REASSIGN_VERIFIER: 13, CLEAR_PARCEL: 14, UNBLOCK_COVENANT: 15, CANCEL_COVENANT: 16,
  NOMINATE_VERIFIER: 17, FREEZE_DRIP: 18, SUSPEND_VERIFIER: 19, DISMISS_VERIFIER: 20,
} as const;
export const ActionName = Object.fromEntries(Object.entries(Action).map(([k, v]) => [v, k.toLowerCase().replaceAll("_", " ")]));

/** What a challenge will come to, as the simulation plans it. */
export const Outcome = { DISMISS: 0, SCORE: 1, DOCUMENTS: 2, BREACH: 3, LAPSE: 4, WITHDRAW: 5 } as const;
export const OutcomeName = ["dismissed", "upheld: score", "upheld: documents", "land in breach", "lapsed", "withdrawn"];

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
