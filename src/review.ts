// The setup screen's Deployment tab: what "Deploy and set up" will deploy, before it does -- each contract with what
// its initializer is given (deploy.ts's own plan), the constants compiled into its code (read from the bytecode on
// the local chain, nothing deployed), and the 21 editions the edition scale makes.
import { encodeDeployData, decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Abi, type AbiFunction, type Hex } from "viem";
import { abis, bulk, type Key } from "./chain";
import { initPlan } from "./deploy";
import type { Scenario } from "./config";
import surface from "./surface.json";
import code from "./bytecode.json";

const C = (code as any).code as Record<string, Hex>;
const LIMIT = 24_576;
const LAST_EDITION = 21;
const TR3_PER_EDITION = 10_000_000;
const INFO = new Map((surface as any).contracts.map((c: any) => [c.key, c]));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const num = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });
/** A rate to four significant figures: the last editions pay a ten-thousandth of a TR3 a hectare-year. */
const rate = (x: number) => (x >= 1 ? num(x, 4) : x.toLocaleString("en-US", { maximumSignificantDigits: 4 }));
const fib = (n: number) => { let a = 1, b = 1; for (let i = 2; i < n; i++) [a, b] = [b, a + b]; return n <= 2 ? 1 : b; };

/** The contract's own one-line title, without its name. */
const purpose = (key: Key) => String((INFO.get(key) as any)?.title ?? "").replace(/^\S+\s+--\s+/, "");

export function deploymentHtml(sc: Scenario): string {
  const plan = initPlan(sc);
  const rows = plan.map(({ key, args }) => {
    const info = INFO.get(key) as any;
    const inputs = ((abis[key] as Abi).find((x) => x.type === "function" && x.name === "initialize") as AbiFunction | undefined)?.inputs ?? [];
    const given = args.length
      ? `<dl class="given">${args.map((a, i) => `<dt>${esc(inputs[i]?.name?.replace(/_$/, "") || `arg ${i + 1}`)}</dt><dd>${esc(a.shown)}</dd>`).join("")}</dl>`
      : `<span class="muted">nothing: it is the first, and the others point to it</span>`;
    const size = info?.size ?? 0;
    return `<tr><td data-label="Contract"><b>${esc(info?.name ?? key)}</b><span class="small muted">${esc(purpose(key))}</span></td>
      <td data-label="Size" class="num">${num(size)} B<span class="small muted">${num(LIMIT - size)} free</span></td>
      <td data-label="Initialised with">${given}</td></tr>`;
  }).join("");
  const k = sc.contracts;
  const flows = sc.flows.length, countries = sc.countries.length;
  return `<fieldset><legend>What will be deployed</legend>
    <p class="note">From anvil's first account, each contract behind an ERC-1967 proxy that trusts the forwarder for gasless calls, in this order, with these values (they follow your settings). Then the Admin's directory is set and every contract syncs to it.</p>
    <div class="table deploy"><table><thead><tr><th>Contract</th><th>Size</th><th>Initialised with</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Before them: a test USDT as the settlement currency, and the forwarder. After them: EcoLens (read-only views, given the Admin's address); the server role; the Council, three GTAs seated; ${flows} flow${flows === 1 ? "" : "s"} defined; ${countries} countr${countries === 1 ? "y" : "ies"} enabled with the settings on the Countries tab; then the cast admitted.</p>
    <div class="row"><button type="button" id="browseContracts" class="ghost">Browse every function, event and error</button></div>
  </fieldset>
  <fieldset><legend>Constants in the code</legend>
    <p class="note">Fixed when the contracts were compiled; no setting changes them. Read from the bytecode on the local chain.</p>
    <div class="consts" id="constants"><p class="muted small">Reading…</p></div>
  </fieldset>
  ${editionsHtml(k.editionScale, k.yearDays)}`;
}

/** The 21 editions of the TR3 model at an edition scale (land-years, hundredths of a hectare × years, per F²). */
function editionsHtml(scale: number, yearDays: number): string {
  let totalHa = 0;
  const rows = Array.from({ length: LAST_EDITION }, (_, i) => {
    const n = i + 1, F = fib(n);
    const ha = (scale * F * F) / 100; // the edition's size in hectare-years
    totalHa += ha;
    return `<tr><td class="num">${n}</td><td class="num">${num(F)}</td><td class="num">${num(ha, 2)}</td><td class="num">${rate(TR3_PER_EDITION / ha)}</td>
      <td class="num">${num(Math.floor((10_000 * F) / 3) / 100, 2)} ha</td><td class="num">${num(100 * F)}</td><td class="num">${num((scale * F) / 10_000, 2)}</td></tr>`;
  }).join("");
  const production = scale === 100_000;
  return `<fieldset><legend>The 21 editions</legend>
    <p class="note">At an edition scale of ${num(scale)}${production ? " (production)" : `, ${num(scale / 100_000, 4)} × production`}. Each edition mints 10,000,000 TR3 across its land-years. Lands are placed at verification, in order; a land that does not fit runs on into the next edition, and the one that fills edition 21 takes the room left. An edition not full eight protocol years (8 × ${num(yearDays, 2)} days) after it opened closes anyway, and what no land took is burned. TR3 at a score of 100; a covenant earns at most 1,000,000.</p>
    <div class="table editions"><table><thead><tr><th>Edition</th><th>F</th><th>Holds (ha·yr)</th><th>TR3 per ha·yr</th><th>Largest plot</th><th>ha × years per title, at most</th><th>Full-size titles to fill</th></tr></thead>
      <tbody>${rows}<tr class="total"><td colspan="2">All 21</td><td class="num">${num(totalHa, 2)}</td><td colspan="4">${num(TR3_PER_EDITION * LAST_EDITION)} TR3 in all</td></tr></tbody></table></div>
  </fieldset>`;
}

// ---- the constants, read from the bytecode ----

const ADDRESS = "0x00000000000000000000000000000000000ec0f1" as const;
const cache = new Map<Key, { name: string; shown: string }[]>();

async function constantsOf(key: Key): Promise<{ name: string; shown: string }[]> {
  if (cache.has(key)) return cache.get(key)!;
  const abi = abis[key] as Abi;
  const ctor = abi.find((x) => x.type === "constructor") as { inputs: { type: string }[] } | undefined;
  // a call that runs the creation code returns the runtime code; a call to it there reads a constant
  const data = encodeDeployData({ abi, bytecode: C[key], args: (ctor?.inputs ?? []).map(() => ADDRESS) } as any);
  const runtime = (await bulk.call({ data })).data as Hex;
  const fns = abi.filter((x): x is AbiFunction => x.type === "function" && /^[A-Z][A-Z0-9_]*$/.test(x.name) && x.inputs.length === 0 && x.outputs.length === 1);
  const out = await Promise.all(fns.map(async (f) => {
    const r = await bulk.call({ to: ADDRESS, data: encodeFunctionData({ abi: [f], functionName: f.name }), stateOverride: [{ address: ADDRESS, code: runtime }] });
    const v = decodeFunctionResult({ abi: [f], functionName: f.name, data: r.data! }) as unknown;
    return { name: f.name, shown: show(f.name, f.outputs[0].type, v) };
  }));
  cache.set(key, out);
  return out;
}

function show(name: string, type: string, v: unknown): string {
  if (type === "bytes32") return /^0x0+$/.test(String(v)) ? "0x00 (the admin role)" : v === keccak256(toBytes(name)) ? `keccak256("${name}")` : `${String(v).slice(0, 10)}…`;
  if (typeof v !== "bigint") return String(v);
  if (/WINDOW|DELAY|PERIOD|FREEZE|DURATION|TIMEOUT|_TIME|INTERVAL/.test(name) && v >= 3600n && v % 3600n === 0n) {
    const d = Number(v) / 86_400;
    return `${num(d, 2)} day${d === 1 ? "" : "s"}`;
  }
  if (v >= 10n ** 15n && v % 10n ** 12n === 0n) return `${num(Number(v / 10n ** 12n) / 1e6, 6)} (×10¹⁸)`;
  return num(Number(v));
}

/** Fills the Constants section; the bytecode does not change during a session, so each contract is read once. */
export async function fillConstants(root: HTMLElement, sc: Scenario) {
  const box = root.querySelector<HTMLElement>("#constants");
  if (!box) return;
  try {
    const keys = initPlan(sc).map((p) => p.key);
    const all = await Promise.all(keys.map(async (key) => [key, await constantsOf(key)] as const));
    if (!box.isConnected) return;
    box.innerHTML = all.filter(([, cs]) => cs.length).map(([key, cs]) => `<details><summary><b>${esc((INFO.get(key) as any)?.name ?? key)}</b> <span class="muted small">${cs.length} constant${cs.length === 1 ? "" : "s"}</span></summary>
      <dl class="given">${cs.map((c) => `<dt><code>${esc(c.name)}</code></dt><dd>${esc(c.shown)}</dd>`).join("")}</dl></details>`).join("");
  } catch (e) {
    box.innerHTML = `<p class="muted small">Could not read the bytecode: ${esc(String((e as Error).message ?? e).slice(0, 200))}</p>`;
  }
}
