// The setup screen: choose a scenario, adjust how the actors behave, how the contracts are configured, and which
// countries take part. Returns the scenario and seed to run.
import { SCENARIOS, FLOWS, KNOWN_COUNTRIES, PRODUCTION, LISTING_DAYS, POST_SALE_DAYS, MAX_FLOW_STEPS, cloneScenario, toProduction, validate, validateFlow, recordsAfterSale, type Scenario, type CountryConfig } from "./config";
import { Step, StepName, OutcomeName } from "./model";
import surface from "./surface.json";
import { deploymentHtml, fillConstants } from "./review";

/** Every country, ISO 3166-1: [numeric code, two letters, name]. */
const ALL_COUNTRIES = (surface as any).countries as [number, string, string][];

type Field = { path: string; label: string; unit?: string; min?: number; max?: number; step?: number; kind?: "check" };
type Group = { title: string; note?: string; fields: Field[] };

const BEHAVIOUR: Group[] = [
  { title: "The run", fields: [
    { path: "behaviour.arrivalsPerYear", label: "Landowners a year", min: 0.1, max: 2000, step: 0.5 },
    { path: "behaviour.fillLand", label: "Run until the programme closes (all 21 editions)", kind: "check" },
    { path: "behaviour.arrivalYears", label: "Otherwise, years of arrivals", unit: "years", min: 0, max: 200 },
    { path: "behaviour.maxRequests", label: "At most this many requests (0 = no limit)", min: 0, max: 100000 },
    { path: "behaviour.maxTermYears", label: "Longest term a landowner asks for", unit: "years", min: 3, max: 100 },
    { path: "behaviour.governanceCalendar", label: "The governance calendar: a new Trust Admin, a freeze, a removal and replacement, a law change, a suspension, a fee change, a Council rotation", kind: "check" },
  ] },
  { title: "Before the mint", note: "Percent of requests. The rest go through normally.", fields: [
    { path: "behaviour.cancelPct", label: "The guardian cancels before a verifier claims it", unit: "%" },
    { path: "behaviour.claimLapsePct", label: "The claiming verifier lets the claim lapse", unit: "%" },
    { path: "behaviour.abandonPct", label: "The guardian abandons after the verification", unit: "%" },
    { path: "behaviour.preMintChallengePct", label: "Challenged in the watchdog window", unit: "%" },
    { path: "behaviour.unsoldPct", label: "Nobody bids: closes unsold", unit: "%" },
    { path: "behaviour.pathBLapseNothingPct", label: "Path B: nothing is recorded after the sale", unit: "%" },
    { path: "behaviour.pathBLapseUnattestedPct", label: "Path B: the recording is never attested", unit: "%" },
  ] },
  { title: "Each review window in the term", note: "Percent of windows; in the rest nobody acts, which counts toward a halt.", fields: [
    { path: "behaviour.attestPct", label: "An independent verifier attests", unit: "%" },
    { path: "behaviour.challengePct", label: "An independent verifier challenges", unit: "%" },
  ] },
  { title: "Verifiers and the term", fields: [
    { path: "behaviour.onTimePct", label: "Re-verify on time (within 20 days of due)", unit: "%" },
    { path: "behaviour.littleLatePct", label: "A little late (20-28 days); the rest very late (40-60)", unit: "%" },
    { path: "behaviour.blockPermille", label: "A re-verification finds a breach and blocks", unit: "per 1,000", max: 1000 },
    { path: "behaviour.cancelOfBlockPct", label: "Of the blocks, end in cancellation", unit: "%" },
    { path: "behaviour.resalePct", label: "An EFT is resold, each year", unit: "%" },
    { path: "behaviour.payeeSwitchPermille", label: "The land changes hands, each year", unit: "per 1,000", max: 1000 },
  ] },
];

const CONTRACTS: Group[] = [
  { title: "Time", note: "In days. Production's value is shown beside any you change; Production settings puts them all back.", fields: [
    { path: "contracts.yearDays", label: "Protocol year (365.25 for the calendar's average)", unit: "days", min: 2, step: 0.25 },
    { path: "contracts.acceptanceDays", label: "A claiming verifier submits within", unit: "days", min: 1 },
    { path: "contracts.watchdogDays", label: "Watchdog window after a verification", unit: "days", min: 1 },
    { path: "contracts.gtaAttestFromDays", label: "Days before a GTA may attest a document", unit: "days", min: 1 },
    { path: "contracts.minAuctionDays", label: "Shortest auction", unit: "days", min: 1 },
    { path: "contracts.reviewDays", label: "Review window after a re-verification", unit: "days", min: 1 },
    { path: "contracts.maxVerificationDelayDays", label: "A verifier this late can be replaced", unit: "days", min: 1 },
    { path: "contracts.responseDays", label: "Challenge: response", unit: "days", min: 1 },
    { path: "contracts.panelDays", label: "Challenge: panel", unit: "days", min: 1 },
    { path: "contracts.redrawDays", label: "Challenge: redraw", unit: "days", min: 1 },
    { path: "contracts.haltAfter", label: "Unattested windows in a row that halt releases", min: 1, max: 100 },
  ] },
  { title: "Money", fields: [
    { path: "contracts.baseFee", label: "V, the default base fee", unit: "USDT", min: 1 },
    { path: "contracts.verifierPermille", label: "Verifier's share of the sale", unit: "per 1,000", max: 999 },
    { path: "contracts.taxPermille", label: "Platform tax: server + Trust Admin + review pool", unit: "per 1,000", max: 999 },
    { path: "contracts.foundationPermille", label: "Of which the Foundation", unit: "per 1,000", max: 999 },
  ] },
  { title: "TR3 editions", note: "An edition holds this many land-years (hundredths of a hectare × years) × F², and mints 10,000,000 TR3 across them: 100,000 in production, 1,000 hectare-years in edition 1. An edition not full eight protocol years after it opened closes anyway, burning what no land took. Smaller fills the editions sooner.", fields: [
    { path: "contracts.editionScale", label: "Edition scale", min: 1 },
  ] },
];

const COUNTRY_COLS: { key: keyof CountryConfig; label: string; w?: string; min?: number; max?: number }[] = [
  { key: "code", label: "ISO", w: "64px", min: 1, max: 999 }, { key: "name", label: "Name", w: "120px" }, { key: "short", label: "Code", w: "48px" },
  { key: "flowId", label: "Flow", w: "170px" }, { key: "minTerm", label: "Min term", min: 3, max: 100 }, { key: "maxTerm", label: "Max term", min: 3, max: 100 },
  { key: "listingDays", label: "Listing days", min: 1 }, { key: "postSaleDays", label: "Post-sale days", min: 0 },
  { key: "baseFee", label: "V (0 = default)", min: 0 }, { key: "deskRate", label: "D (0 = V × 4/50)", min: 0 },
  { key: "allowanceFixed", label: "Allowance, fixed", min: 0 }, { key: "allowancePerHa", label: "Allowance per ha", min: 0 },
  { key: "holders", label: "Trust Admins", min: 1, max: 9 }, { key: "orgsPerHolder", label: "Orgs each", min: 1, max: 9 },
  { key: "verifiersPerOrg", label: "Verifiers per org", min: 1, max: 4 }, { key: "weight", label: "Share of arrivals", min: 0 },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const get = (o: any, path: string) => path.split(".").reduce((x, k) => x?.[k], o);
const set = (o: any, path: string, v: unknown) => {
  const ks = path.split(".");
  const last = ks.pop()!;
  ks.reduce((x, k) => x[k], o)[last] = v;
};
const STORE = "ecofutures-setup-v1";

export type Choice = { scenario: Scenario; seed: number };

export function mountSetup(root: HTMLElement, onStart: (c: Choice) => void, status: string, onBrowse: () => void = () => {}) {
  let saved: { scenario: Scenario; seed: number } | null = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) ?? "null"); } catch {}
  let sc: Scenario = saved?.scenario ? saved.scenario : cloneScenario(SCENARIOS[0]);
  if (saved?.scenario) sc = cloneScenario(sc); // settings saved by an earlier version take defaults for what is new
  let notice = "";
  let seed = saved?.seed ?? 20270101;
  let tab = "behaviour";

  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify({ scenario: sc, seed })); } catch {} };

  function fieldHtml(f: Field): string {
    const v = get(sc, f.path);
    const base = f.path.startsWith("contracts.") ? get({ contracts: PRODUCTION }, f.path) : undefined;
    if (f.kind === "check") {
      return `<label class="f check-f"><input type="checkbox" data-path="${f.path}" ${v ? "checked" : ""}><span>${esc(f.label)}</span></label>`;
    }
    return `<label class="f"><span>${esc(f.label)}</span><span class="in"><input type="number" data-path="${f.path}" value="${v}" ${f.min !== undefined ? `min="${f.min}"` : `min="0"`} ${f.max !== undefined ? `max="${f.max}"` : ""} step="${f.step ?? "any"}"><small>${f.unit ? esc(f.unit) : ""}</small>${base !== undefined && base !== v ? `<small class="prod">${base.toLocaleString("en-US")}</small>` : ""}</span></label>`;
  }

  function groups(gs: Group[]) {
    return gs.map((g) => `<fieldset><legend>${esc(g.title)}</legend>${g.note ? `<p class="note">${esc(g.note)}</p>` : ""}${g.fields.map(fieldHtml).join("")}</fieldset>`).join("");
  }

  function outcomes() {
    const row = (path: string, labels: string[], skip?: number) => `<div class="weights">${labels.map((l, i) => i === skip ? "" : `<label class="w"><span>${esc(l)}</span><input type="number" min="0" step="any" data-path="${path}.${i}" value="${get(sc, `${path}.${i}`)}"></label>`).join("")}</div>`;
    return `<fieldset><legend>What panels find</legend><p class="note">Relative weights: 2 and 1 means twice as often.</p>
      <h4>Before the mint</h4>${row("behaviour.preMintOutcomes", OutcomeName, 3)}<h4>In the term</h4>${row("behaviour.termOutcomes", OutcomeName)}</fieldset>`;
  }

  function countries() {
    const flowOpts = (sel: number) => sc.flows.map((f) => `<option value="${f.id}" ${f.id === sel ? "selected" : ""}>${f.id}. ${esc(f.name)}</option>`).join("");
    // each cell carries its column's label, so a narrow screen shows a country as a card of labelled fields
    const rows = sc.countries.map((c, i) => `<tr>${COUNTRY_COLS.map((col) => {
      const v = c[col.key];
      const td = (inner: string, cls = "") => `<td data-label="${esc(col.label)}"${cls ? ` class="${cls}"` : ""}>${inner}</td>`;
      if (col.key === "flowId") return td(`<select data-country="${i}" data-key="flowId" aria-label="${esc(c.name)}: flow">${flowOpts(c.flowId)}</select>`, "wide");
      if (col.key === "name" || col.key === "short") return td(`<input type="text" data-country="${i}" data-key="${col.key}" value="${esc(String(v))}" style="width:${col.w}" aria-label="${esc(c.name)}: ${esc(col.label)}">`, col.key === "name" ? "wide" : "");
      return td(`<input type="number" data-country="${i}" data-key="${col.key}" value="${v}" min="${col.min ?? 0}" ${col.max ? `max="${col.max}"` : ""} style="width:${col.w ?? "72px"}" aria-label="${esc(c.name)}: ${esc(col.label)}">`);
    }).join("")}<td class="act"><button type="button" class="ghost" data-remove="${i}" aria-label="Remove ${esc(c.name)}">Remove</button></td></tr>`).join("");
    // the flows: each a sequence of steps, edited here and checked against the contracts' own rules
    const stepOpts = (sel: number) => StepName.map((n, k) => (k === 0 ? "" : `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(n[0].toUpperCase() + n.slice(1))}</option>`)).join("");
    const flows = sc.flows.map((f, i) => {
      const used = sc.countries.filter((c) => c.flowId === f.id).map((c) => c.name);
      const errs = validateFlow(f.steps);
      const steps = f.steps.map((st, j) => `<li><select data-flow="${i}" data-step="${j}" aria-label="Flow ${f.id}, step ${j + 1}">${stepOpts(st)}</select>
        <button type="button" class="ghost icon" data-step-up="${i}:${j}" ${j === 0 ? "disabled" : ""} aria-label="Move step ${j + 1} earlier">↑</button>
        <button type="button" class="ghost icon" data-step-del="${i}:${j}" aria-label="Remove step ${j + 1}">×</button></li>`).join("");
      return `<div class="flow-ed${errs.length ? " bad" : ""}">
        <div class="flow-head"><b>${f.id}.</b><input type="text" data-flow-name="${i}" value="${esc(f.name)}" aria-label="Flow ${f.id}: name">
          <button type="button" class="ghost" data-flow-del="${i}" ${used.length ? `disabled title="Used by ${esc(used.join(", "))}"` : ""}>Remove</button></div>
        <ol class="steps">${steps}</ol>
        <div class="row"><button type="button" class="ghost" data-step-add="${i}" ${f.steps.length >= MAX_FLOW_STEPS ? "disabled" : ""}>Add a step</button>
          <span class="small muted">${used.length ? `Used by ${esc(used.join(", "))}` : "Not used by any country"}${recordsAfterSale(sc.flows, f.id) ? " · steps after the sale: the price waits in escrow" : ""}</span></div>
        ${errs.length ? `<ul class="errs">${errs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      </div>`;
    }).join("");
    return `<fieldset><legend>Countries</legend><p class="note">Each country's legal settings, its fees, and its cast: Trust Admins, their organisations, and verifiers in each. The contracts allow at most 10 Trust Admins a country and 5 verifiers an organisation; the limits here leave room for the governance calendar and for recruits.</p>
      <div class="table countries"><table><thead><tr>${COUNTRY_COLS.map((c) => `<th>${esc(c.label)}</th>`).join("")}<th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="add"><label for="newCode">Add a country</label><select id="newCode"><option value="">Choose from all ${ALL_COUNTRIES.length} countries…</option>${ALL_COUNTRIES
        .filter(([n]) => !sc.countries.some((c) => c.code === n))
        .map(([n, a2, name]) => `<option value="${n}">${esc(name)} (${a2}, ${String(n).padStart(3, "0")})</option>`).join("")}</select><button type="button" id="addCountry">Add</button></div>
      <h4>Flows</h4><p class="note">The steps a request goes through between the verification and the term. The contracts check every flow when it is defined: a document (agreement, deed or recording) is followed by its attestation, the mint by the sale, an agreement comes before the mint and a recording after the sale, and a power is registered before anything it signs.</p>
      <div class="flows-ed">${flows}</div>
      <div class="add"><button type="button" id="addFlow">Add a flow</button></div></fieldset>`;
  }

  function render() {
    const errs = validate(sc);
    const cards = SCENARIOS.map((s) => `<button type="button" class="card-s ${s.id === sc.id ? "on" : ""}" data-scenario="${s.id}"><b>${esc(s.name)}</b><span>${esc(s.summary)}</span></button>`).join("");
    const body = tab === "behaviour" ? groups(BEHAVIOUR) + outcomes() : tab === "contracts" ? groups(CONTRACTS) : tab === "deploy" ? deploymentHtml(sc) : countries();
    root.innerHTML = `<div class="setup-wrap">
      <header class="setup-head"><span class="eyebrow">EcoFutures V11 · simulator</span><h1>Set up a run</h1>
        <p class="muted">The real contracts on a local chain. Choose what to investigate and adjust anything: the actors, the contracts' settings (production unless you change them) and the countries. The app deploys V11 with your configuration, admits the cast, and runs it. ${esc(status)}</p>${notice ? `<p class="notice">${esc(notice)}</p>` : ""}</header>
      <div class="setup-grid">
        <nav class="scenarios" aria-label="Scenarios">${cards}</nav>
        <section class="config">
          <div class="tabs" role="tablist">${[["behaviour", "Behaviour"], ["contracts", "Contracts"], ["countries", `Countries (${sc.countries.length})`], ["deploy", "Deployment"]].map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join("")}</div>
          <div class="panel-c">${body}</div>
        </section>
      </div>
      <footer class="setup-foot">
        ${errs.length ? `<ul class="errs">${errs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : `<span class="ok-msg">The configuration is valid.</span>`}
        <div class="row"><label for="seed">Seed</label><input id="seed" type="number" value="${seed}">
          <button type="button" id="resetScenario" class="ghost">Restore this scenario's defaults</button>
          <button type="button" id="toProduction" class="ghost" title="Every timing, the edition scale and each country's listing (${LISTING_DAYS} days) and post-sale (${POST_SALE_DAYS} days on path B) windows at production">Production settings</button>
          <button type="button" id="exportCfg" class="ghost">Save settings</button>
          <label class="ghost file">Load settings<input type="file" id="importCfg" accept="application/json" hidden></label>
          <button type="button" id="start" class="primary" ${errs.length ? "disabled" : ""}>Deploy and set up</button></div>
        <p class="muted small" id="overlayStatus"></p>
      </footer></div>`;
    if (tab === "deploy") void fillConstants(root, sc);
  }

  root.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const card = el.closest<HTMLElement>("[data-scenario]");
    if (card) { sc = cloneScenario(SCENARIOS.find((s) => s.id === card.dataset.scenario)!); persist(); render(); return; }
    const t = el.closest<HTMLElement>("[data-tab]");
    if (t) { tab = t.dataset.tab!; render(); return; }
    const rm = el.closest<HTMLElement>("[data-remove]");
    if (rm) { sc.countries.splice(Number(rm.dataset.remove), 1); persist(); render(); return; }
    if (el.id === "addCountry") {
      const code = Number((root.querySelector("#newCode") as HTMLSelectElement).value);
      if (!code) return;
      const iso = ALL_COUNTRIES.find(([n]) => n === code);
      const [name, short] = KNOWN_COUNTRIES[code] ?? (iso ? [iso[2], iso[1]] : [`Country ${code}`, `C${code}`.slice(0, 3)]);
      sc.countries.push({ code, name, short, flowId: 2, minTerm: 3, maxTerm: 100, listingDays: 358, postSaleDays: 0, baseFee: 0,
        deskRate: 0, allowanceFixed: 30, allowancePerHa: 2, holders: 2, orgsPerHolder: 1, verifiersPerOrg: 2, weight: 20 });
      persist(); render();
      return;
    }
    const flowAt = (attr: string) => { const v = el.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr); return v === null || v === undefined ? null : v.split(":").map(Number); };
    let fa: number[] | null;
    if ((fa = flowAt("data-step-up"))) { const [i, j] = fa; const st = sc.flows[i].steps; [st[j - 1], st[j]] = [st[j], st[j - 1]]; persist(); render(); return; }
    if ((fa = flowAt("data-step-del"))) { const [i, j] = fa; sc.flows[i].steps.splice(j, 1); persist(); render(); return; }
    if ((fa = flowAt("data-step-add"))) { sc.flows[fa[0]].steps.push(Step.ATTEST); persist(); render(); return; }
    if ((fa = flowAt("data-flow-del"))) { sc.flows.splice(fa[0], 1); persist(); render(); return; }
    if (el.id === "addFlow") {
      const id = Math.max(0, ...sc.flows.map((f) => f.id)) + 1;
      sc.flows.push({ id, name: `Flow ${id}`, steps: [Step.DEED, Step.ATTEST, Step.MINT, Step.SALE] });
      persist(); render();
      return;
    }
    if (el.id === "toProduction") {
      const changed = toProduction(sc);
      notice = changed.length ? `Back at production: ${changed.join("; ")}.` : "Every setting is already at production.";
      persist(); render();
      return;
    }
    if (el.id === "browseContracts") { onBrowse(); return; }
    if (el.id === "resetScenario") { sc = cloneScenario(SCENARIOS.find((s) => s.id === sc.id) ?? SCENARIOS[0]); persist(); render(); return; }
    if (el.id === "exportCfg") {
      const blob = new Blob([JSON.stringify({ scenario: sc, seed }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ecofutures-${sc.id}.json`;
      a.click();
      return;
    }
    if (el.id === "start") {
      seed = Number((root.querySelector("#seed") as HTMLInputElement).value) || 1;
      persist();
      onStart({ scenario: cloneScenario(sc), seed });
    }
  });

  root.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el.id === "importCfg") {
      const f = (el as HTMLInputElement).files?.[0];
      if (!f) return;
      f.text().then((txt) => {
        try {
          const j = JSON.parse(txt);
          if (j.scenario?.contracts && j.scenario?.behaviour && j.scenario?.countries) {
            sc = cloneScenario(j.scenario); seed = j.seed ?? seed;
            notice = "";
            persist(); render();
          }
        } catch {}
      });
      return;
    }
    if (el.id === "seed") { seed = Number(el.value) || 1; persist(); return; }
    if (el.dataset.flowName !== undefined) { sc.flows[Number(el.dataset.flowName)].name = el.value; persist(); render(); return; }
    if (el.dataset.flow !== undefined && el.dataset.step !== undefined) {
      sc.flows[Number(el.dataset.flow)].steps[Number(el.dataset.step)] = Number(el.value);
      persist(); render(); return;
    }
    if (el.dataset.path) {
      const isCheck = (el as HTMLInputElement).type === "checkbox";
      set(sc, el.dataset.path, isCheck ? (el as HTMLInputElement).checked : Number(el.value));
    } else if (el.dataset.country !== undefined) {
      const c = sc.countries[Number(el.dataset.country)] as any;
      const k = el.dataset.key!;
      c[k] = k === "name" || k === "short" ? el.value : Number(el.value);
      // a flow that records after the sale needs a post-sale window: give it production's when it has none
      if (k === "flowId") {
        if (recordsAfterSale(sc.flows, c.flowId) && !(c.postSaleDays > 0)) c.postSaleDays = POST_SALE_DAYS;
        persist(); render(); return;
      }
    } else return;
    persist();
    // re-render without losing focus: only the footer's validation changes
    const errs = validate(sc);
    const foot = root.querySelector(".setup-foot")!;
    const list = errs.length ? `<ul class="errs">${errs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<span class="ok-msg">The configuration is valid.</span>`;
    foot.firstElementChild!.outerHTML = list;
    (root.querySelector("#start") as HTMLButtonElement).disabled = errs.length > 0;
  });

  render();
  return {
    setStatus(msg: string) { const s = root.querySelector("#overlayStatus"); if (s) s.textContent = msg; },
    setBusy(busy: boolean) { const b = root.querySelector("#start") as HTMLButtonElement | null; if (b) b.disabled = busy || validate(sc).length > 0; },
  };
}

export { FLOWS };
