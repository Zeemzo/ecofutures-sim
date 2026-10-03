// The setup screen: choose a scenario, adjust how the actors behave, how the contracts are configured, and which
// countries take part. Returns the scenario and seed to run.
import { SCENARIOS, FLOWS, KNOWN_COUNTRIES, PRODUCTION, LISTING_DAYS, POST_SALE_DAYS, cloneScenario, toProduction, validate, type Scenario, type CountryConfig } from "./config";
import { Step, StepName, OutcomeName } from "./model";
import surface from "./surface.json";

/** Every country, ISO 3166-1: [numeric code, two letters, name]. */
const ALL_COUNTRIES = (surface as any).countries as [number, string, string][];

type Field = { path: string; label: string; unit?: string; min?: number; max?: number; step?: number; kind?: "check" };
type Group = { title: string; note?: string; fields: Field[] };

const BEHAVIOUR: Group[] = [
  { title: "The run", fields: [
    { path: "behaviour.arrivalsPerYear", label: "Landowners a year", min: 0.1, max: 2000, step: 0.5 },
    { path: "behaviour.fillLand", label: "Run until the land is full (the last edition begins)", kind: "check" },
    { path: "behaviour.arrivalYears", label: "Otherwise, years of arrivals", unit: "years", min: 0, max: 200 },
    { path: "behaviour.maxRequests", label: "At most this many requests (0 = no limit)", min: 0, max: 100000 },
    { path: "behaviour.maxTermYears", label: "Longest term a landowner asks for", unit: "years", min: 3, max: 100 },
    { path: "behaviour.governanceCalendar", label: "The governance calendar: a new Trust Admin, a freeze, a removal and replacement, a law change, a suspension, a fee change, a Council rotation", kind: "check" },
    { path: "behaviour.overcharge", label: "Patrons overcharge with expired EFTs", kind: "check" },
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
    { path: "contracts.yearDays", label: "Protocol year", unit: "days", min: 2, step: 1 },
    { path: "contracts.acceptanceDays", label: "A claiming verifier submits within", unit: "days", min: 1 },
    { path: "contracts.watchdogDays", label: "Watchdog window after a verification", unit: "days", min: 1 },
    { path: "contracts.backstopDays", label: "Backstop delay before a GTA may attest", unit: "days", min: 1 },
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
    { path: "contracts.serverPermille", label: "Of which the server", unit: "per 1,000", max: 999 },
  ] },
  { title: "TR3 editions", note: "Land-years per F² in each edition's threshold: 1,000,000 in production, where the land needs tens of millions of covenants to reach the last edition. Smaller moves the editions sooner.", fields: [
    { path: "contracts.editionScale", label: "Edition scale", min: 1 },
  ] },
];

const COUNTRY_COLS: { key: keyof CountryConfig; label: string; w?: string; min?: number; max?: number }[] = [
  { key: "code", label: "ISO", w: "64px", min: 1, max: 999 }, { key: "name", label: "Name", w: "120px" }, { key: "short", label: "Code", w: "48px" },
  { key: "flowId", label: "Flow", w: "170px" }, { key: "minTerm", label: "Min term", min: 3, max: 100 }, { key: "maxTerm", label: "Max term", min: 3, max: 100 },
  { key: "listingDays", label: "Listing days", min: 1 }, { key: "postSaleDays", label: "Post-sale days", min: 0 },
  { key: "baseFee", label: "V (0 = default)", min: 0 }, { key: "attestationFee", label: "Attestation fee", min: 0 }, { key: "judgmentFee", label: "Judgment fee", min: 0 },
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

export function mountSetup(root: HTMLElement, onStart: (c: Choice) => void, status: string) {
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
    return `<label class="f"><span>${esc(f.label)}</span><span class="in"><input type="number" data-path="${f.path}" value="${v}" ${f.min !== undefined ? `min="${f.min}"` : `min="0"`} ${f.max !== undefined ? `max="${f.max}"` : ""} step="${f.step ?? "any"}">${f.unit ? `<small>${esc(f.unit)}</small>` : ""}${base !== undefined && base !== v ? `<small class="prod">${base.toLocaleString("en-US")}</small>` : ""}</span></label>`;
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
    const rows = sc.countries.map((c, i) => `<tr>${COUNTRY_COLS.map((col) => {
      const v = c[col.key];
      if (col.key === "flowId") return `<td><select data-country="${i}" data-key="flowId">${flowOpts(c.flowId)}</select></td>`;
      if (col.key === "name" || col.key === "short") return `<td><input type="text" data-country="${i}" data-key="${col.key}" value="${esc(String(v))}" style="width:${col.w}"></td>`;
      return `<td><input type="number" data-country="${i}" data-key="${col.key}" value="${v}" min="${col.min ?? 0}" ${col.max ? `max="${col.max}"` : ""} style="width:${col.w ?? "72px"}"></td>`;
    }).join("")}<td><button type="button" class="ghost" data-remove="${i}" aria-label="Remove ${esc(c.name)}">Remove</button></td></tr>`).join("");
    const flows = sc.flows.map((f) => `<li><b>${f.id}. ${esc(f.name)}</b>: ${f.steps.map((s) => esc(StepName[s])).join(" → ")}</li>`).join("");
    return `<fieldset><legend>Countries</legend><p class="note">Each country's legal settings, its fees, and its cast: Trust Admins, their organisations, and verifiers in each. The contracts allow at most 10 Trust Admins a country and 5 verifiers an organisation; the limits here leave room for the governance calendar and for recruits.</p>
      <div class="table"><table><thead><tr>${COUNTRY_COLS.map((c) => `<th>${esc(c.label)}</th>`).join("")}<th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="add"><label for="newCode">Add a country</label><select id="newCode"><option value="">Choose from all ${ALL_COUNTRIES.length} countries…</option>${ALL_COUNTRIES
        .filter(([n]) => !sc.countries.some((c) => c.code === n))
        .map(([n, a2, name]) => `<option value="${n}">${esc(name)} (${a2}, ${String(n).padStart(3, "0")})</option>`).join("")}</select><button type="button" id="addCountry">Add</button></div>
      <h4>Flows</h4><ul class="flows">${flows}</ul></fieldset>`;
  }

  function render() {
    const errs = validate(sc);
    const cards = SCENARIOS.map((s) => `<button type="button" class="card-s ${s.id === sc.id ? "on" : ""}" data-scenario="${s.id}"><b>${esc(s.name)}</b><span>${esc(s.summary)}</span></button>`).join("");
    const body = tab === "behaviour" ? groups(BEHAVIOUR) + outcomes() : tab === "contracts" ? groups(CONTRACTS) : countries();
    root.innerHTML = `<div class="setup-wrap">
      <header class="setup-head"><span class="eyebrow">EcoFutures V11 · simulator</span><h1>Set up a run</h1>
        <p class="muted">The real contracts on a local chain. Choose what to investigate and adjust anything: the actors, the contracts' settings (production unless you change them) and the countries. The app deploys V11 with your configuration, admits the cast, and runs it. ${esc(status)}</p>${notice ? `<p class="notice">${esc(notice)}</p>` : ""}</header>
      <div class="setup-grid">
        <nav class="scenarios" aria-label="Scenarios">${cards}</nav>
        <section class="config">
          <div class="tabs" role="tablist">${[["behaviour", "Behaviour"], ["contracts", "Contracts"], ["countries", `Countries (${sc.countries.length})`]].map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join("")}</div>
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
      sc.countries.push({ code, name, short, flowId: 2, minTerm: 3, maxTerm: 100, listingDays: 330, postSaleDays: 0, baseFee: 0,
        attestationFee: 5, judgmentFee: 9, holders: 2, orgsPerHolder: 1, verifiersPerOrg: 2, weight: 20 });
      persist(); render();
      return;
    }
    if (el.id === "toProduction") {
      const changed = toProduction(sc);
      notice = changed.length ? `Back at production: ${changed.join("; ")}.` : "Every setting is already at production.";
      persist(); render();
      return;
    }
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
    if (el.dataset.path) {
      const isCheck = (el as HTMLInputElement).type === "checkbox";
      set(sc, el.dataset.path, isCheck ? (el as HTMLInputElement).checked : Number(el.value));
    } else if (el.dataset.country !== undefined) {
      const c = sc.countries[Number(el.dataset.country)] as any;
      const k = el.dataset.key!;
      c[k] = k === "name" || k === "short" ? el.value : Number(el.value);
      // a flow that records after the sale needs a post-sale window: give it production's when it has none
      if (k === "flowId") {
        const f = sc.flows.find((x) => x.id === c.flowId);
        if (f && f.steps.includes(Step.RECORDING) && !(c.postSaleDays > 0)) c.postSaleDays = POST_SALE_DAYS;
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
