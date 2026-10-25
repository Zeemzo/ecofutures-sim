// What every contract parameter is, and how a person types and reads it. The kinds come from the contracts' own
// integration kit (contracts/docs/integration/fields.json and enums.json, copied here by scripts/abis.mjs as
// units.json), so the simulator reads and shows values exactly as the platform guides tell the frontend to.
//
//   usdt, tr3      18 decimals: typed and shown in whole tokens ("1000", "192.5"; "1000 wei" for base units)
//   time           unix seconds: typed "2027-03-01", "2027-03-01 12:00", "now", "now+7d", or seconds
//   duration       seconds: typed "30d", "12h", "1y" (365 days), "1d12h", or seconds
//   landUnits      square metres (TR3 Model 4 §2.8): typed "10000", "10000 m2" or "1 ha"
//   landYears      square-metre-years
//   score 1-100, band 1-8, permille (70 = 7%), multiplierE18 (a stone's M x 1e18: typed "x5" or "5x"), holds (bits)
//   enum:<Name>    a uint8 shown and chosen by name
import { formatUnits } from "viem";
import units from "./units.json";

export type Kind = string;
type Units = { fields: Record<string, Record<string, Record<string, string>>>; enums: Record<string, Record<string, number>> };
const U = units as unknown as Units;

/** Chain time, for "now": the app sets it to the clock it shows. */
let chainNow = () => Math.floor(Date.now() / 1000);
export function setChainNow(f: () => number) { chainNow = f; }

const MONEY = /^(amount|addedValue|subtractedValue|value|baseFee|defaultBaseFee_|powerFee|agreementFee|registrationFixed|registrationPerHa|registrationFee|registrationFees|cap|maxTotal|minCommit|minimum|perHectare|price|startPrice)$/;

/** The kind of a parameter of `fn` on contract `c`, by its path ("name", or "struct.field"; outputs "returns.name"). */
export function kindOf(c: string, fn: string, path: string, type = ""): Kind | undefined {
  const k = U.fields[c]?.[fn]?.[path];
  if (k) return k;
  // the test currency (and anything the kit does not list): its amounts are whole tokens too
  const name = path.split(".").pop() ?? "";
  if (/^uint/.test(type) && MONEY.test(name)) return c === "tree" || c === "overcharge" ? "tr3" : "usdt";
  return undefined;
}

export const enumOf = (k?: Kind) => (k?.startsWith("enum:") && !k.endsWith("[]") ? k.slice(5) : undefined);
export const enumNames = (name: string): [string, number][] => Object.entries(U.enums[name] ?? {});
export function enumLabel(name: string, v: number | bigint): string {
  const n = Number(v);
  const hit = enumNames(name).find(([, x]) => x === n);
  return hit ? `${hit[0]} (${n})` : String(n);
}

const UNIT: Record<string, string> = { usdt: "USDT", tr3: "TR3" };
const SPAN: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 7 * 86_400, y: 365 * 86_400 };

function decimal(v: string, exp: number): bigint {
  const m = v.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`"${v}" is not a number`);
  const frac = m[3] ?? "";
  if (frac.length > exp) throw new Error(`"${v}" has more decimals than the units allow`);
  return BigInt(m[1] + m[2] + frac.padEnd(exp, "0"));
}

function duration(t: string): number {
  if (/^\d+$/.test(t)) return Number(t);
  const parts = [...t.matchAll(/(\d+(?:\.\d+)?)\s*([smhdwy])/gi)];
  if (!parts.length || parts.map((p) => p[0]).join("").replace(/\s/g, "") !== t.replace(/\s/g, "")) {
    throw new Error(`"${t}" is not a duration (try 30d, 12h, 1d12h or seconds)`);
  }
  return Math.round(parts.reduce((a, p) => a + Number(p[1]) * SPAN[p[2].toLowerCase()], 0));
}

/** A typed value for a parameter of this kind, as the contract takes it. Throws a readable error. */
export function parseTyped(kind: Kind, raw: string): bigint | number {
  const v = raw.trim().replace(/[_,]/g, "");
  if (kind === "usdt" || kind === "tr3") {
    const m = v.replace(/\s/g, "").match(/^(-?\d+(?:\.\d+)?)(?:e(\d+)|(ether|usdt|tr3|tree)|(wei))?$/i);
    if (!m) throw new Error(`"${raw}" is not an amount (try 1000, 0.5 or 1000 wei)`);
    if (m[4]) return decimal(m[1], 0);
    if (m[2] !== undefined) return decimal(m[1], Number(m[2]));
    return decimal(m[1], 18);
  }
  if (kind === "time") {
    if (/^\d+$/.test(v)) return Number(v);
    const rel = v.replace(/\s/g, "").toLowerCase().match(/^(now)?(?:([+-])(.+))?$/);
    if (rel && (rel[1] || rel[2])) return chainNow() + (rel[2] ? (rel[2] === "-" ? -1 : 1) * duration(rel[3]) : 0);
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : /Z|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v.replace(" ", "T")}Z`);
    if (Number.isNaN(t)) throw new Error(`"${raw}" is not a date (try 2027-03-01, 2027-03-01 12:00, now+7d or seconds)`);
    return Math.floor(t / 1000);
  }
  if (kind === "duration") return duration(v);
  if (kind === "landUnits" || kind === "landYears") {
    const ha = v.match(/^(\d+(?:\.\d+)?)\s*ha$/i);
    if (ha) return Number(decimal(ha[1], 4));
    const m2 = v.match(/^(\d+)\s*(?:m2|m²|sq\s*m)$/i);
    if (m2) return Number(m2[1]);
    if (!/^\d+$/.test(v)) throw new Error(`"${raw}" is not a land size (try 10000 or 10000 m2 for 1 ha, or 1.5 ha)`);
    return Number(v);
  }
  if (kind === "multiplierE18") {
    // a stone's M (TR3 Model 4 §7), x 1e18
    const x = v.match(/^x\s*(\d+(?:\.\d+)?)$/i) ?? v.match(/^(\d+(?:\.\d+)?)\s*x$/i);
    if (x) return decimal(x[1], 18);
    if (!/^\d+$/.test(v)) throw new Error(`"${raw}" is not a multiplier (try x5, 5x, or the raw value)`);
    return BigInt(v);
  }
  const en = enumOf(kind);
  if (en) {
    const hit = enumNames(en).find(([n]) => n.toLowerCase() === v.toLowerCase());
    if (hit) return hit[1];
    if (!/^\d+$/.test(v)) throw new Error(`"${raw}" is not a ${en} (${enumNames(en).map(([n]) => n).join(", ")})`);
  }
  if (/^\d+$/.test(v)) return Number(v);
  throw new Error(`"${raw}" is not a whole number`);
}

/** A contract value of this kind for people. */
export function formatValue(kind: Kind | undefined, v: unknown): string {
  if (kind === undefined || (typeof v !== "bigint" && typeof v !== "number")) return String(v);
  const n = BigInt(v);
  if (kind === "usdt" || kind === "tr3") {
    const s = formatUnits(n, 18);
    const [w, f = ""] = s.split(".");
    return `${BigInt(w).toLocaleString("en-US")}${f && f !== "0" ? "." + f.slice(0, 6).replace(/0+$/, "") : ""} ${UNIT[kind]}`;
  }
  if (kind === "time") return n === 0n ? "— (0)" : `${new Date(Number(n) * 1000).toISOString().replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC")} (${n})`;
  if (kind === "duration") {
    const s = Number(n);
    const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
    const txt = [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ") || `${s}s`;
    return `${txt} (${s.toLocaleString("en-US")} s)`;
  }
  if (kind === "landUnits") return `${(Number(n) / 10_000).toLocaleString("en-US", { maximumFractionDigits: 4 })} ha (${Number(n).toLocaleString("en-US")} m²)`;
  if (kind === "landYears") return `${(Number(n) / 10_000).toLocaleString("en-US", { maximumFractionDigits: 4 })} ha·yr (${Number(n).toLocaleString("en-US")} m²·yr)`;
  if (kind === "permille") return `${Number(n) / 10}% (${n}‰)`;
  if (kind === "multiplierE18") return n === 0n ? "none (0)" : `x${(Number(n) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 })} (${n})`;
  if (kind === "holds") {
    const names = enumNames("Holds").filter(([, b]) => (Number(n) & b) !== 0).map(([k]) => k);
    return `${names.join(" | ") || "none"} (${n})`;
  }
  const e = enumOf(kind);
  if (e) return enumLabel(e, n);
  return n.toString();
}

/** A contract value as a person would type it back in (the moves the simulation proposes, pre-filled). */
export function toInputText(kind: Kind | undefined, v: unknown): string | undefined {
  if (kind === undefined || (typeof v !== "bigint" && typeof v !== "number")) return undefined;
  const n = BigInt(v);
  if (kind === "usdt" || kind === "tr3") return formatUnits(n, 18);
  if (kind === "time") return n === 0n ? "0" : new Date(Number(n) * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  return n.toString();
}

/** The hint under a field, and what the typed value will be sent as. */
export function hintFor(kind: Kind | undefined): string | undefined {
  switch (kind) {
    case "usdt": return "USDT: 1000 = 1,000 USDT (1000 wei for base units)";
    case "tr3": return "TR3: 1000 = 1,000 TR3 (1000 wei for base units)";
    case "time": return "a date: 2027-03-01, 2027-03-01 12:00, now, now+7d (UTC), or unix seconds";
    case "duration": return "30d, 12h, 1d12h, 1y, or seconds";
    case "landUnits": return "square metres: 10000 = 1 ha (or type 1 ha); the smallest plot is 100 m²";
    case "landYears": return "square-metre-years: 10000 = 1 ha·yr";
    case "score": return "EcoScore 1–100";
    case "band": return "IUCN band 1–8";
    case "permille": return "per thousand: 70 = 7%";
    case "multiplierE18": return "x5 (or the raw value x 1e18)";
    default: return undefined;
  }
}

export function preview(kind: Kind | undefined, raw: string): string {
  if (!kind || !raw.trim() || enumOf(kind)) return "";
  try { return `→ ${formatValue(kind, parseTyped(kind, raw))}`; } catch (e) { return `⚠ ${(e as Error).message}`; }
}
