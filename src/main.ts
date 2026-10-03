import "./style.css";
import {
  Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend,
} from "chart.js";
import type { Address, Hex } from "viem";
import { latestBlock, mineAt, logsBetween, snapshot, revertTo, read, prepareChain, blockNumber, RPC, bulk, addr, abis, sendHook } from "./chain";
import { deploy } from "./deploy";
import { mountSetup, type Choice } from "./setup";
import { mountExplorer } from "./explorer";
import type { Decoded } from "./chain";
import { FLOWS, type Scenario } from "./config";
import { Engine, LAST_EDITION } from "./engine";
import { Ledger, census, resetCensus, INVARIANTS, standingSale, type Census, type Row, type Stage } from "./ledger";
import { describe, type Entry, type Category } from "./feed";
import { Timeline, nextStop } from "./travel";
import {
  DAY, YEAR, COUNTRIES, StepName, EndReason, Outcome, OutcomeName, nameOf, money, dateOf, shortDate, hectares,
  countryName, toUnits, resetNames, RequestStatus, setYear, setCountries, knownActors, CovenantStatus,
} from "./model";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const SPEEDS: { label: string; v: number; title: string }[] = [
  { label: "Real time", v: 1, title: "One second of chain time per second" },
  { label: "1 h/s", v: 3600, title: "One hour of chain time per second" },
  { label: "1 day/s", v: DAY, title: "One day of chain time per second" },
  { label: "1 wk/s", v: 7 * DAY, title: "One week of chain time per second" },
  { label: "1 mo/s", v: 30 * DAY, title: "One month of chain time per second" },
  { label: "Fastest", v: Infinity, title: "As fast as the chain allows, from one day anyone acts to the next" },
];
const MAX_STEP = 7 * DAY;

type Sample = {
  t: number; paid: number[]; held: number[]; states: number[]; tr3: number; edition: number;
  /** Market cap (USDT), TR3 mint price (USDT per TR3), hectare-years to the next edition. */
  market: [number, number, number];
};

const S = {
  engine: null as unknown as Engine,
  ledger: new Ledger(),
  census: null as Census | null,
  entries: [] as Entry[],
  seq: 0,
  running: false,
  speed: DAY,
  clock: 0,
  lastLogBlock: 0n,
  block: 0n,
  invChecks: 0,
  invFails: [0, 0, 0, 0, 0, 0],
  samples: [] as Sample[],
  nextSample: 0,
  lastCensusAt: 0,
  queue: [] as (() => Promise<string>)[],
  snapshotId: "" as Hex | "",
  ready: false,
  busy: false,
  filter: "all" as "all" | Category,
  showMinor: false,
  showFinished: false,
  openRid: 0,
  seen: new Set<number>(),
  effective: [] as { real: number; chain: number }[],
  /** Land-years at which the last edition begins. */
  fullAt: 0n,
  ended: false,
  /** The empty chain, before any deployment: every run starts from here. */
  genesis: "" as Hex | "",
  scenario: null as Scenario | null,
  setupUi: null as ReturnType<typeof mountSetup> | null,
  /** Every decoded event of the run, for the explorer. */
  raw: [] as Decoded[],
  explorer: null as ReturnType<typeof mountExplorer> | null,
  /** A date the clock is travelling forward to, the actors living every day on the way; 0 when not travelling. */
  travelTarget: 0,
  /** The chain's own time: the last stop the actors acted at. The clock on screen may run ahead of it between stops. */
  chainAt: 0,
};

/** Midnight (UTC) at or before t. */
const midnight = (t: number) => Math.floor(t / DAY) * DAY;

/** What the page itself must return to with a checkpoint: the feed, the samples and the checks up to that block. */
type PageState = { seq: number; nextSample: number; invChecks: number; invFails: number[]; seen: number[]; ended: boolean };
const T = new Timeline<PageState>();

async function checkpoint() {
  await T.take(S.chainAt, S.block, S.engine, S.ledger, {
    seq: S.seq, nextSample: S.nextSample, invChecks: S.invChecks, invFails: S.invFails, seen: [...S.seen], ended: S.ended,
  });
}

// =====================================================================================
// Boot and the cast
// =====================================================================================

const GENESIS_KEY = `ecofutures-genesis-${RPC}`;

async function boot() {
  let status = "";
  try {
    await prepareChain();
    const n = await blockNumber();
    if (n === 0n) {
      S.genesis = await snapshot();
    } else {
      let stored: string | null = null;
      try { stored = localStorage.getItem(GENESIS_KEY); } catch {}
      if (stored && (await revertTo(stored as Hex).then(() => true, () => false))) S.genesis = await snapshot();
      else status = "This node already holds another session's chain, so every run here starts from it. Restart the simulator for a clean chain.";
    }
    if (S.genesis) try { localStorage.setItem(GENESIS_KEY, S.genesis); } catch {}
  } catch (e) {
    $("overlay").innerHTML = `<div class="setup-wrap"><h1>Cannot reach the local chain</h1><p class="muted">${esc(String((e as Error).message ?? e))}</p><p class="muted">Start it with ./start.sh, or open the desktop app.</p></div>`;
    return;
  }
  S.setupUi = mountSetup($("overlay"), (c) => void setupProgramme(c), status);
  // ?auto=1 sets up and plays at once; &scenario= picks one, &seed= and &speed= (an index into the speed buttons)
  const q = new URLSearchParams(location.search);
  if (q.get("auto")) {
    const { SCENARIOS, cloneScenario } = await import("./config");
    const sc = cloneScenario(SCENARIOS.find((x) => x.id === q.get("scenario")) ?? SCENARIOS[0]);
    if (q.get("rate")) sc.behaviour.arrivalsPerYear = Number(q.get("rate"));
    await setupProgramme({ scenario: sc, seed: Number(q.get("seed") ?? 20270101) });
    const i = Number(q.get("speed") ?? 4);
    ($("speeds").children[Math.min(Math.max(i, 0), SPEEDS.length - 1)] as HTMLButtonElement).click();
    $("play").click();
  }
}

async function setupProgramme({ scenario, seed }: Choice) {
  const ui = S.setupUi!;
  ui.setBusy(true);
  try {
    if (S.genesis) {
      await revertTo(S.genesis as Hex);
      S.genesis = await snapshot();
      try { localStorage.setItem(GENESIS_KEY, S.genesis); } catch {}
    }
    resetNames();
    resetCensus();
    T.clear();
    S.travelTarget = 0;
    S.scenario = scenario;
    setYear(scenario.contracts.yearDays);
    setCountries(scenario.countries.map((c) => ({ code: c.code, name: c.name, short: c.short, flow: FLOWS.find((f) => f.id === c.flowId)?.name ?? `flow ${c.flowId}` })));
    await deploy(scenario, (m) => ui.setStatus(`${m}…`));
    S.engine = new Engine(seed, scenario);
    S.ended = false;
    $("endBanner")?.remove();
    S.engine.onNote = (n) => pushEntry({ t: n.t, rid: n.rid, cat: n.kind === "stranded" ? "alert" : "note", text: n.text, seq: S.seq++ });
    S.ledger = new Ledger();
    S.entries = []; S.raw = []; S.seq = 0; S.samples = []; S.invChecks = 0; S.invFails = [0, 0, 0, 0, 0, 0]; S.seen.clear();
    chartedSamples = -1;
    for (const c of Object.values(charts)) c.destroy();
    for (const k of Object.keys(charts)) delete charts[k];
    $("feed").innerHTML = "";
    S.lastLogBlock = 0n;
    S.engine.now = (await latestBlock()).timestamp;
    await S.engine.setup((m) => ui.setStatus(`${m}…`));
    const b = await latestBlock();
    S.clock = b.timestamp;
    S.chainAt = b.timestamp;
    S.engine.begin(b.timestamp);
    S.nextSample = b.timestamp;
    S.fullAt = await read<bigint>("tree", "editionEndsAt", [LAST_EDITION - 1]);
    $("sScale").textContent = `${scenario.name} · production settings`;
    await ingest(b.timestamp);
    await refreshCountryStatus();
    await runCensus(true);
    await checkpoint();
    S.ready = true;
    $("overlay").hidden = true;
    for (const id of ["play", "skip", "reset", ...TRAVEL]) $<HTMLButtonElement>(id).disabled = false;
    fillSelects();
    render();
    toast(`${scenario.name}: deployed and set up on ${dateOf(b.timestamp)}. Press Play.`);
  } catch (e) {
    console.error(e);
    ui.setStatus(`Setting up failed: ${(e as Error).message ?? e}`);
  } finally {
    ui.setBusy(false);
  }
}

async function resetProgramme() {
  S.running = false;
  S.travelTarget = 0;
  updatePlay();
  while (S.busy) await sleep(50);
  S.ready = false;
  closeDrawer();
  $("endBanner")?.remove();
  $("overlay").hidden = false;
  S.setupUi?.setStatus("Choose a scenario and set up again: the chain goes back to empty first.");
}

// =====================================================================================
// The clock
// =====================================================================================

async function loop() {
  let last = performance.now();
  for (;;) {
    await sleep(S.running ? (S.speed === Infinity ? 0 : 120) : 100);
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (!S.ready) continue;
    if (S.queue.length) await runQueue();
    // the chain stops only at midnight on the days anyone acts (travel.ts), so a run is the same however it is played
    if (S.travelTarget) {
      if (S.chainAt >= S.travelTarget || S.ended) { arrive(); continue; }
      await advance(Math.min(nextStop(S.chainAt, S.engine.nextDue()), S.travelTarget));
      continue;
    }
    if (!S.running || S.ended) continue;
    if (S.speed === Infinity) {
      await advance(nextStop(S.chainAt, S.engine.nextDue()));
    } else {
      // the clock on screen runs at the chosen speed; the chain catches up a stop at a time
      S.clock += Math.min(S.speed * dt, MAX_STEP);
      for (let n = 0; n < 8 && !S.ended; n++) {
        const stop = nextStop(S.chainAt, S.engine.nextDue());
        if (stop > S.clock) break;
        await advance(stop);
      }
      renderClock();
    }
  }
}

async function advance(target: number) {
  S.busy = true;
  try {
    const before = await latestBlock();
    let t = before.timestamp;
    if (Math.floor(target) > before.timestamp) t = (await mineAt(target)).timestamp;
    await S.engine.tick(t);
    const after = await latestBlock();
    S.chainAt = after.timestamp;
    S.clock = Math.max(S.clock, after.timestamp);
    await ingest(after.timestamp);
    const real = performance.now();
    S.effective.push({ real, chain: after.timestamp });
    while (S.effective.length > 2 && real - S.effective[0].real > 3000) S.effective.shift();
    const every = S.speed === Infinity || S.travelTarget ? 2000 : 700;
    if (real - S.lastCensusAt > every || after.timestamp >= S.nextSample || S.engine.finished) await runCensus(false);
    else { renderClock(); renderStrip(); }
    if (T.due(S.chainAt)) await checkpoint();
  } catch (e) {
    console.error(e);
    toast(`The chain call failed: ${(e as Error).message ?? e}`);
    S.running = false;
    updatePlay();
  } finally {
    S.busy = false;
  }
}

async function runQueue() {
  S.busy = true;
  try {
    while (S.queue.length) {
      const job = S.queue.shift()!;
      const msg = await job();
      toast(msg);
      pushEntry({ t: S.engine.now, rid: S.openRid > 0 ? S.openRid : 0, cat: "note", text: `You stepped in: ${msg}`, seq: S.seq++ });
    }
    const b = await latestBlock();
    await ingest(b.timestamp);
    await runCensus(false);
  } finally {
    S.busy = false;
  }
}

async function ingest(t: number) {
  const b = await latestBlock();
  S.block = b.number;
  const logs = await logsBetween(S.lastLogBlock + 1n, b.number);
  S.lastLogBlock = b.number;
  for (const e of logs) {
    S.raw.push(e);
    S.ledger.ingest(e);
    const entry = describe(e, S.ledger, S.seq++, t);
    if (entry) pushEntry(entry);
  }
}

async function runCensus(force: boolean) {
  const c = await census(S.engine.requests, S.engine.done, S.ledger, S.block, S.clock);
  const prevEdition = S.census?.edition ?? c.edition;
  S.census = c;
  S.lastCensusAt = performance.now();
  S.invChecks++;
  c.inv.forEach((ok, i) => { if (!ok) S.invFails[i]++; });
  if (c.edition > prevEdition) {
    pushEntry({ t: c.t, rid: 0, cat: "alert", text: `Edition ${c.edition} begins. New covenants earn TR3 at the new edition's rate, and the land limits move.`, seq: S.seq++ });
  }
  if (S.engine.finished && !S.ended) programmeOver();
  while (force || c.t >= S.nextSample) {
    force = false;
    S.samples.push(sample(c));
    S.nextSample += 30 * DAY;
  }
  render();
}

function sample(c: Census): Sample {
  const m = S.ledger.money.map(toUnits);
  const k = c.counts;
  return {
    t: c.t,
    paid: [m[9] + m[4] + m[14], m[1] + m[6], m[7] + m[22], m[8], m[2] + m[3] + m[11] + m[12] + m[13], m[15] + m[16]],
    held: [toUnits(c.bankBal), toUnits(c.poolBal), toUnits(c.registryBal)],
    states: [
      (k.requested ?? 0) + (k.claimed ?? 0) + (k.watchdog ?? 0) + (k.flow ?? 0),
      (k["for-sale"] ?? 0) + (k.auction ?? 0) + (k.escrow ?? 0),
      k.active ?? 0, k.blocked ?? 0, (k.ending ?? 0),
    ],
    tr3: toUnits(c.tr3Supply),
    edition: c.edition,
    market: [toUnits(c.marketCap), mintPrice(c), Number(c.tillNextEdition) / 100],
  };
}

/** The platform's TR3 mint price: the market cap over the TR3 the sold lands will mint across their terms. */
function mintPrice(c: Census): number {
  const tr3 = toUnits(c.soldProjected);
  return tr3 > 0 ? toUnits(c.marketCap) / tr3 : 0;
}

// =====================================================================================
// Rendering
// =====================================================================================

const STAGES: { s: Stage; label: string }[] = [
  { s: "requested", label: "Waiting for a verifier" }, { s: "claimed", label: "Being verified" },
  { s: "watchdog", label: "Watchdog window" }, { s: "flow", label: "Deeds and attestation" },
  { s: "for-sale", label: "Minted, for sale" }, { s: "auction", label: "At auction" }, { s: "escrow", label: "Sold, in escrow" },
  { s: "active", label: "In its term" }, { s: "blocked", label: "Blocked" }, { s: "ending", label: "Term over, settling" },
  { s: "complete", label: "Complete" }, { s: "ended", label: "Ended early" },
];
const stageLabel = (s: Stage) => STAGES.find((x) => x.s === s)!.label;

function render() {
  if (!S.census) return;
  renderClock();
  renderStrip();
  renderTicker();
  renderKpis();
  renderBoard();
  renderCharts();
  void renderWallets(false);
  if (S.openRid) void renderDrawer(S.openRid, false);
}

function renderClock() {
  const t = S.clock;
  const d = new Date(t * 1000);
  $("clockDate").textContent = `${d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })} ${d.toISOString().slice(11, 19)}`;
  const elapsed = Math.max(0, t - S.engine.start);
  const year = Math.floor(elapsed / YEAR) + 1;
  const day = Math.floor((elapsed % YEAR) / DAY) + 1;
  $("clockSub").textContent = S.ended ? "The programme is over"
    : S.travelTarget ? `Travelling to ${dateOf(S.travelTarget)}: every day lived on the way`
    : `Programme year ${year}, day ${day}`;
  const d0 = new Date(t * 1000).toISOString().slice(0, 10);
  const input = $<HTMLInputElement>("tDate");
  if (document.activeElement !== input) input.value = d0;
}

function renderStrip() {
  $("sBlock").textContent = S.block.toLocaleString("en-US");
  $("sActions").textContent = S.engine.actions.toLocaleString("en-US");
  const e = S.effective;
  if (S.running && e.length >= 2) {
    const rate = (e[e.length - 1].chain - e[0].chain) / ((e[e.length - 1].real - e[0].real) / 1000);
    $("sEffective").textContent = `running at ${rate >= DAY ? `${(rate / DAY).toFixed(1)} days` : rate >= 3600 ? `${(rate / 3600).toFixed(1)} hours` : `${rate.toFixed(0)} s`} per second`;
  } else $("sEffective").textContent = S.running ? "" : "paused";
  const fails = S.invFails.reduce((a, b) => a + b, 0);
  $("sInvariants").innerHTML = `${S.invFails.map((f, i) => `<i class="${f ? "fail" : ""}" title="${esc(INVARIANTS[i])}${f ? `: failed ${f} times` : ""}"></i>`).join("")} <span>${fails ? `${fails} invariant failures` : "6 of 6 invariants held"} · ${S.invChecks.toLocaleString("en-US")} checks</span>`;
  if (S.census && S.fullAt > 0n) {
    const pct = Math.min(100, Number((S.census.landYears * 10000n) / S.fullAt) / 100);
    $("sLandBar").style.width = `${pct}%`;
    $("sLandText").textContent = `${pct < 0.1 && pct > 0 ? "<0.1" : pct.toFixed(1)}% of the land to the last edition · edition ${S.census.edition} of ${LAST_EDITION}`;
  }
  const n = S.engine.anomalies.length;
  const a = $("sAnomalies");
  a.textContent = `${n} unexpected revert${n === 1 ? "" : "s"}`;
  a.classList.toggle("bad", n > 0);
}

/** The platform's home-page bar (eco-frontend, pages/EcoBank): market cap, TR3 mint price and its change, total
 *  transactions, EFTs sold, TR3 minted, and the land left before the next edition (the platform's "Ha till halving"). */
function renderTicker() {
  const c = S.census!;
  const price = mintPrice(c);
  const prev = S.samples.length >= 2 ? S.samples[S.samples.length - 2].market[1] : 0;
  const change = prev > 0 ? ((price - prev) / prev) * 100 : 0;
  const delta = prev > 0 && Math.abs(change) >= 0.005
    ? `<small class="${change > 0 ? "up" : "down"}">${change > 0 ? "▲" : "▼"} ${Math.abs(change).toFixed(2)}% on the month</small>` : "";
  const item = (label: string, value: string, title: string) => `<div title="${esc(title)}"><span>${label}</span><b>${value}</b></div>`;
  $("ticker").innerHTML = [
    item("Market cap", `${money(c.marketCap)} USDT`, "Sale prices of the EFTs sold and still standing (not blocked or cancelled)"),
    item("TR3 mint price", `${price.toFixed(4)} USDT${delta}`, "Market cap over the TR3 those lands will mint across their terms; the change is against the last monthly sample"),
    item("Transactions", S.engine.actions.toLocaleString("en-US"), "Every transaction the actors have sent"),
    item("EFTs sold", c.sold.toLocaleString("en-US"), "EFTs sold and still standing"),
    item("TR3 minted", money(c.tr3Supply, 2), "TREE supply"),
    item("Till next edition", `${hectareYears(c.tillNextEdition)} ha-yr`, "Hectare-years of land under covenant before the next edition begins"),
  ].join("");
}

function renderKpis() {
  const c = S.census!;
  const m = S.ledger.money;
  const k = c.counts;
  const items: [string, string][] = [
    [money(m[9] + m[4] + m[14]), "USDT paid to guardians"],
    [money(m[1] + m[6]), "USDT paid to verifiers"],
    [money(m[7] + m[22] + m[8]), "USDT to Trust Admins and the server"],
    [money(m[2] + m[3] + m[11] + m[12] + m[13]), "USDT to attesters, panels, challengers"],
    [money(c.registryBal + c.bankBal + c.poolBal), "USDT held by the protocol now"],
    [`${((k.active ?? 0) + (k.blocked ?? 0) + (k.ending ?? 0)).toLocaleString("en-US")}`, "covenants in their term"],
    [money(c.tr3Supply), "TREE minted"],
    [`${c.edition}`, `edition · ${hectareYears(c.landYears)} hectare-years taken`],
  ];
  $("kpis").innerHTML = items.map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`).join("");
}

function tileState(r: Row): string {
  switch (r.stage) {
    case "ending": return "Settling";
    case "flow": return StepName[r.step] ? StepName[r.step][0].toUpperCase() + StepName[r.step].slice(1) : "In flow";
    case "active": return `Term ${r.released ?? 0}/${r.total ?? 0}`;
    case "ended": return `Ended: ${EndReason[r.endReason] || "cancelled"}`;
    default: return stageLabel(r.stage);
  }
}

const laneStatus = new Map<number, number>();
async function refreshCountryStatus() {
  for (const co of COUNTRIES) laneStatus.set(co.code, Number((await read("countries", "getCountry", [co.code])).status));
}

function renderBoard() {
  const c = S.census!;
  $("lanes").innerHTML = COUNTRIES.map((co) => {
    const rows = c.rows.filter((r) => r.country === co.code);
    const live = rows.filter((r) => r.stage !== "complete" && r.stage !== "ended");
    const fin = rows.filter((r) => r.stage === "complete" || r.stage === "ended");
    const shown = S.showFinished ? rows : live;
    const tiles = shown.map((r) => {
      const pct = r.total ? Math.round(((r.released ?? 0) / r.total) * 100) : r.stage === "complete" ? 100 : 0;
      const fresh = !S.seen.has(r.rid);
      S.seen.add(r.rid);
      const flag = r.challenged ? `<span class="flag" title="A challenge is open"></span>` : r.frozen || r.halted ? `<span class="flag held" title="Instalments held"></span>` : "";
      return `<button type="button" class="tile s-${r.stage}${fresh ? " fresh" : ""}" data-rid="${r.rid}" title="Request ${r.rid}: ${esc(tileState(r))}">${flag}<span class="id">#${r.rid}</span><span class="st">${esc(tileState(r))}</span><span class="pb"><i style="width:${pct}%"></i></span></button>`;
    }).join("");
    const done = fin.filter((r) => r.stage === "complete").length;
    const compact = shown.length > 36;
    return `<div class="lane"><div class="lane-head"><b>${co.name}</b><span>${co.flow}${laneStatus.get(co.code) === 2 ? ` · <span class="suspended">suspended</span>` : ""}</span><span>${live.length} live · ${done} complete · ${fin.length - done} ended early</span></div><div class="tiles${compact ? " compact" : ""}">${tiles || `<div class="empty">No live requests.</div>`}</div></div>`;
  }).join("");
}

const charts: Record<string, Chart> = {};
function css(v: string) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

function lineChart(id: string, labels: string[], sets: { label: string; data: number[]; color: string; fill?: boolean; axis?: string; stepped?: boolean }[], stacked: boolean, extraAxis: false | { max?: number; step?: number } = false) {
  const ink = css("--muted"), grid = css("--line");
  const datasets = sets.map((s) => ({
    label: s.label, data: s.data, borderColor: s.color, backgroundColor: `${s.color}33`, fill: s.fill ?? stacked,
    pointRadius: 0, borderWidth: 1.6, tension: 0.2, yAxisID: s.axis ?? "y", stepped: s.stepped ?? false,
  }));
  if (charts[id]) {
    charts[id].data.labels = labels;
    charts[id].data.datasets.forEach((d, i) => { d.data = datasets[i].data; });
    charts[id].update("none");
    return;
  }
  const scales: any = {
    x: { ticks: { color: ink, maxTicksLimit: 6, maxRotation: 0, autoSkip: true, autoSkipPadding: 14, font: { family: css("--mono"), size: 10 } }, grid: { color: grid } },
    y: { stacked, beginAtZero: true, ticks: { color: ink, font: { family: css("--mono"), size: 10 } }, grid: { color: grid } },
  };
  if (extraAxis) scales.y1 = { position: "right", min: 0, max: extraAxis.max, ticks: { color: ink, stepSize: extraAxis.step, font: { family: css("--mono"), size: 10 } }, grid: { display: false } };
  charts[id] = new Chart($<HTMLCanvasElement>(id), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: ink, boxWidth: 10, font: { family: css("--body"), size: 11 } } } },
      scales,
    },
  });
}

let chartedSamples = -1;
function renderCharts() {
  if (S.samples.length === chartedSamples) return;
  chartedSamples = S.samples.length;
  // a long programme has hundreds of months: chart at most ~400 points
  const every = Math.max(1, Math.ceil(S.samples.length / 400));
  const s = S.samples.filter((_, i) => i % every === 0 || i === S.samples.length - 1);
  const labels = s.map((x) => shortDate(x.t));
  const col = (i: number) => s.map((x) => x.paid[i]);
  lineChart("cPaid", labels, [
    { label: "Guardians", data: col(0), color: css("--moss") },
    { label: "Verifiers", data: col(1), color: css("--flow") },
    { label: "Trust Admins", data: col(2), color: css("--slate") },
    { label: "Server", data: col(3), color: css("--faint") },
    { label: "Attesters, panels", data: col(4), color: css("--amber") },
    { label: "Refunds", data: col(5), color: css("--rust") },
  ], true);
  lineChart("cHeld", labels, [
    { label: "Bank: instalments, escrow", data: s.map((x) => x.held[0]), color: css("--moss"), fill: true },
    { label: "Review pools", data: s.map((x) => x.held[1]), color: css("--amber"), fill: true },
    { label: "Registry: upfront escrow", data: s.map((x) => x.held[2]), color: css("--slate"), fill: true },
  ], false);
  lineChart("cStates", labels, [
    { label: "Before the mint", data: s.map((x) => x.states[0]), color: css("--flow") },
    { label: "For sale or in escrow", data: s.map((x) => x.states[1]), color: css("--amber") },
    { label: "In the term", data: s.map((x) => x.states[2]), color: css("--moss") },
    { label: "Blocked", data: s.map((x) => x.states[3]), color: css("--rust") },
    { label: "Settling", data: s.map((x) => x.states[4]), color: css("--faint") },
  ], true);
  lineChart("cTree", labels, [
    { label: "TREE supply", data: s.map((x) => x.tr3), color: css("--moss"), fill: true },
    { label: "Edition", data: s.map((x) => x.edition), color: css("--rust"), axis: "y1", stepped: true, fill: false },
  ], false, { max: 12, step: 2 });
  lineChart("cMarket", labels, [
    { label: "Market cap (USDT)", data: s.map((x) => x.market?.[0] ?? 0), color: css("--slate"), fill: true },
    { label: "TR3 mint price (USDT)", data: s.map((x) => x.market?.[1] ?? 0), color: css("--amber"), axis: "y1", fill: false },
  ], false, {});
  lineChart("cTill", labels, [
    { label: "Hectare-years to the next edition", data: s.map((x) => x.market?.[2] ?? 0), color: css("--moss"), fill: true, stepped: false },
  ], false);
}

// ---- wallets: the platform's dashboard figures, for every actor ----

type WalletRole = "patron" | "guardian" | "verifier" | "holder";
const WALLET_ROLES: { k: WalletRole; label: string }[] = [
  { k: "patron", label: "Patrons" }, { k: "guardian", label: "Guardians" }, { k: "verifier", label: "Verifiers" }, { k: "holder", label: "Trust Admins" },
];
let walletRole: WalletRole = "patron";
let walletsAt = 0;
let walletsBusy = false;
let walletsAgain = false;

/** The platform's per-wallet figures (eco-frontend, pages/Profile/Dashboard): TR3 balance and its value, transactions,
 *  portfolio, assets, lands verified, portfolio value, and what each has been paid. */
async function renderWallets(force: boolean) {
  if (walletsBusy) { walletsAgain ||= force; return; }
  if (!S.census || (!force && performance.now() - walletsAt < 5000)) return;
  walletsBusy = true;
  walletsAt = performance.now();
  try {
    const c = S.census;
    const price = mintPrice(c);
    const actors = knownActors().filter((a) => walletRole === "holder" ? a.role.startsWith("Trust Admin") : a.role === walletRole);
    const txs = (a: Address) => S.engine.txBy.get(a.toLowerCase()) ?? 0;
    const earned = (a: Address) => S.ledger.earned.get(a) ?? 0n;
    const live = (r: Row) => r.tokenId !== 0n && r.cstatus !== CovenantStatus.CANCELLED;
    const n = (v: string) => `<td class="n">${v}</td>`;
    let head = "", rows: { key: number; html: string }[] = [];
    if (walletRole === "patron" || walletRole === "guardian") {
      const bal = await Promise.all(actors.map((a) => bulk.readContract({ address: addr.tree, abi: abis.tree, functionName: "balanceOf", args: [a.address] }) as Promise<bigint>));
      if (walletRole === "patron") {
        head = `<tr><th>Patron</th><th class="n">TR3</th><th class="n">TR3 value (USDT)</th><th class="n">Portfolio</th><th class="n">Transactions</th><th class="n">USDT received</th></tr>`;
        rows = actors.map((a, i) => {
          const owned = c.rows.filter((r) => r.owner && r.owner.toLowerCase() === a.address.toLowerCase() && live(r)).length;
          return { key: Number(bal[i] / 10n ** 15n), html: `<tr><td>${esc(a.name)}</td>${n(money(bal[i], 2))}${n(money(BigInt(Math.round(toUnits(bal[i]) * price * 1e6)) * 10n ** 12n, 2))}${n(String(owned))}${n(txs(a.address).toLocaleString("en-US"))}${n(money(earned(a.address), 2))}</tr>` };
        });
      } else {
        head = `<tr><th>Guardian</th><th>Country</th><th class="n">Assets</th><th class="n">TR3</th><th class="n">Transactions</th><th class="n">USDT received</th></tr>`;
        rows = actors.map((a, i) => {
          const lands = c.rows.filter((r) => r.guardian.toLowerCase() === a.address.toLowerCase());
          const assets = lands.filter(live).length;
          return { key: Number(bal[i] / 10n ** 15n), html: `<tr><td>${esc(a.name)}</td><td>${lands[0] ? esc(countryName(lands[0].country)) : ""}</td>${n(String(assets))}${n(money(bal[i], 2))}${n(txs(a.address).toLocaleString("en-US"))}${n(money(earned(a.address), 2))}</tr>` };
        });
      }
    } else if (walletRole === "verifier") {
      head = `<tr><th>Verifier</th><th>Country</th><th class="n">Lands verified</th><th class="n">Portfolio value (USDT)</th><th class="n">Transactions</th><th class="n">USDT earned</th></tr>`;
      const countryOf = new Map<string, number>();
      for (const [code, vs] of S.engine.countryVerifiers) for (const v of vs) countryOf.set(v.toLowerCase(), code);
      rows = actors.map((a) => {
        const mine = c.rows.filter((r) => r.verifier.toLowerCase() === a.address.toLowerCase() && live(r));
        const value = mine.filter(standingSale).reduce((x, r) => x + r.price!, 0n);
        const code = countryOf.get(a.address.toLowerCase());
        return { key: mine.length, html: `<tr><td>${esc(a.name)}</td><td>${code ? esc(countryName(code)) : ""}</td>${n(String(mine.length))}${n(money(value))}${n(txs(a.address).toLocaleString("en-US"))}${n(money(earned(a.address), 2))}</tr>` };
      });
    } else {
      head = `<tr><th>Trust Admin</th><th>Country</th><th class="n">Verifiers admitted</th><th class="n">Lands</th><th class="n">Portfolio value (USDT)</th><th class="n">Transactions</th><th class="n">USDT earned</th></tr>`;
      const verifiers = knownActors().filter((a) => a.role === "verifier");
      const holderOf = await Promise.all(verifiers.map((v) => (bulk.readContract({ address: addr.admin, abi: abis.admin, functionName: "holderOf", args: [v.address] }) as Promise<Address>).catch(() => null)));
      rows = actors.map((a) => {
        const me = a.address.toLowerCase();
        const admitted = holderOf.filter((h) => h && h.toLowerCase() === me).length;
        const mine = c.rows.filter((r) => r.holder && r.holder.toLowerCase() === me && live(r));
        const value = mine.filter(standingSale).reduce((x, r) => x + r.price!, 0n);
        return { key: Number(value / 10n ** 18n), html: `<tr><td>${esc(a.name)}</td><td>${esc(a.role.replace("Trust Admin, ", ""))}</td>${n(String(admitted))}${n(String(mine.length))}${n(money(value))}${n(txs(a.address).toLocaleString("en-US"))}${n(money(earned(a.address), 2))}</tr>` };
      });
    }
    rows.sort((x, y) => y.key - x.key);
    const shown = rows.slice(0, 100);
    $("walletHead").innerHTML = head;
    $("walletBody").innerHTML = shown.map((r) => r.html).join("") || `<tr><td colspan="7" class="muted">Nobody yet.</td></tr>`;
    $("walletNote").textContent = `${actors.length.toLocaleString("en-US")} ${WALLET_ROLES.find((r) => r.k === walletRole)!.label.toLowerCase()}${rows.length > shown.length ? `, the first ${shown.length} shown` : ""}. As the platform's dashboard shows them, read from the chain at block ${S.block.toLocaleString("en-US")}.`;
  } catch (e) {
    console.error(e);
  } finally {
    walletsBusy = false;
    if (walletsAgain) { walletsAgain = false; void renderWallets(true); }
  }
}

// ---- the feed ----

const CHIPS: { k: "all" | Category; label: string }[] = [
  { k: "all", label: "All" }, { k: "lifecycle", label: "Requests" }, { k: "money", label: "Money" },
  { k: "term", label: "Terms" }, { k: "challenge", label: "Challenges" }, { k: "governance", label: "Governance" },
  { k: "alert", label: "Alerts" },
];

function visible(e: Entry): boolean {
  if (e.minor && !S.showMinor) return false;
  if (S.filter === "all") return true;
  if (S.filter === "alert") return e.cat === "alert";
  return e.cat === S.filter || (S.filter === "governance" && e.cat === "note" && e.rid === 0);
}

function entryHtml(e: Entry): string {
  const text = esc(e.text).replace(/#(\d+)/g, (m, r) => (Number(r) > 0 ? `<a data-rid="${r}">${m}</a>` : m));
  return `<li class="c-${e.cat}${e.minor ? " minor" : ""}"><time>${shortDate(e.t)}</time><span class="txt">${text}</span></li>`;
}

let feedPending: Entry[] = [];
let feedScheduled = false;
function pushEntry(e: Entry) {
  S.entries.push(e);
  if (S.entries.length > 60_000) S.entries.splice(0, 10_000);
  if (S.raw.length > 120_000) S.raw.splice(0, 20_000);
  if (!visible(e)) return;
  feedPending.push(e);
  if (!feedScheduled) {
    feedScheduled = true;
    requestAnimationFrame(flushFeed);
  }
}

function flushFeed() {
  feedScheduled = false;
  const feed = $("feed");
  const html = feedPending.slice(-150).reverse().map(entryHtml).join("");
  feedPending = [];
  feed.insertAdjacentHTML("afterbegin", html);
  while (feed.children.length > 300) feed.lastElementChild!.remove();
}

function redrawFeed() {
  const items = S.entries.filter(visible).slice(-300).reverse();
  $("feed").innerHTML = items.length ? items.map(entryHtml).join("") : `<li class="feed-empty">Nothing yet.</li>`;
}

// ---- the drawer ----

function openDrawer(rid: number) {
  S.openRid = rid;
  $("drawer").hidden = false;
  $("scrim").hidden = false;
  void renderDrawer(rid, true);
}

function closeDrawer() {
  S.openRid = 0;
  $("drawer").hidden = true;
  $("scrim").hidden = true;
}

let drawerAt = 0;
async function renderDrawer(rid: number, force: boolean) {
  if (!force && performance.now() - drawerAt < 1500) return;
  drawerAt = performance.now();
  if (rid === -1) return renderAnomalies();
  if (rid === -2) return renderInvariants();
  const row = S.census?.rows.find((r) => r.rid === rid);
  if (!row) return;
  const L = S.ledger;
  let reward: any = null, w: any = null, ch: any = null;
  if (row.tokenId) {
    [reward, w] = await Promise.all([read("tree", "rewardOf", [row.tokenId]), read("challenge", "getWindow", [row.tokenId])]);
    if (row.challenged && w.challengeId) ch = await read("challenge", "getChallenge", [w.challengeId]);
  }
  if (S.openRid !== rid) return;
  $("dEyebrow").textContent = `${countryName(row.country)} · ${stageLabel(row.stage)}`;
  $("dTitle").textContent = `Request #${rid}${row.tokenId ? ` · EFT #${row.tokenId}` : ""}`;
  const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const facts = [
    fact("Land", hectares(row.land)), fact("Stated period", `${row.term} years`),
    fact("EcoScore", row.score ? String(row.score) : "not yet"), fact("Edition", row.edition ? String(row.edition) : "at activation"),
    fact("Guardian", esc(nameOf(row.guardian))), fact("Verifier", esc(nameOf(row.verifier))),
    fact("Owner of the EFT", row.owner ? esc(nameOf(row.owner)) : "not minted"),
    fact("Sale price", row.price ? `${money(row.price)} USDT` : "not sold"),
    fact("Paid to the guardian", `${money(L.guardianGot.get(rid) ?? 0n)} USDT`),
    fact("TR3 minted", `${money(L.tr3.get(rid) ?? 0n)} TREE`),
  ];
  if (row.termStart) facts.push(fact("Term", `${dateOf(row.termStart)} to ${dateOf(row.termEnd!)}`));
  if (reward) facts.push(fact("TR3 multiplier", `×${reward.multiplier}`));
  let progress = "";
  if (row.total) {
    const pct = Math.round(((row.released ?? 0) / row.total) * 100);
    progress = `<div class="progress"><h3>Instalments</h3><div class="track"><i style="width:${pct}%"></i></div><span class="small muted">${row.released} of ${row.total} released · verified through interval ${row.verifiedThrough} · ${money(row.balance ?? 0n)} USDT still held · review pool ${money(row.pool ?? 0n)} USDT${row.frozen ? " · <b>instalments held</b>" : ""}${row.halted ? " · <b>releases halted</b>" : ""}</span></div>`;
  }
  let windowInfo = "";
  if (w && Number(w.openedAt) !== 0) {
    windowInfo = `<p class="small">${w.settled ? "The last review window has settled." : `A review window is open until ${dateOf(Number(w.closesAt))}${Number(w.action) === 1 ? `, attested by ${esc(nameOf(w.attestor))}` : Number(w.action) === 2 ? ", challenged" : ""}.`}</p>`;
  }
  if (ch) windowInfo += `<p class="small">Challenge ${w.challengeId}: ${esc(nameOf(ch.challenger))} against ${esc(nameOf(ch.defendant))}. Panel: ${(ch.panel as string[]).filter((p) => !/^0x0+$/.test(p)).map((p) => esc(nameOf(p))).join(", ") || "not yet drawn"}.</p>`;
  const premint = row.status === RequestStatus.VERIFIED;
  const canChallenge = premint || (row.tokenId && w && Number(w.openedAt) !== 0 && !w.settled && Number(w.action) === 0 && S.clock <= Number(w.closesAt));
  const isTerm = row.stage === "active" || row.stage === "ending";
  const acts = `<div class="acts"><h3>Step in</h3>
    <div class="row"><select id="dOutcome">${OutcomeName.map((o, i) => (premint && i === Outcome.BREACH ? "" : `<option value="${i}">Panel finds: ${o}</option>`)).join("")}</select>
    <button type="button" id="dChallenge" ${canChallenge ? "" : "disabled"}>Raise a challenge</button></div>
    ${canChallenge ? "" : `<span class="small muted">${row.tokenId ? "A challenge needs an open review window: one opens with each re-verification." : "A challenge is possible in the watchdog window after the verification."}</span>`}
    <div class="row"><button type="button" id="dBlock" ${isTerm || row.stage === "for-sale" ? "" : "disabled"}>The verifier blocks it</button>
    <button type="button" id="dFreeze" ${isTerm ? "" : "disabled"}>${row.frozen ? "Council releases the instalments" : "Council holds the instalments"}</button></div></div>`;
  const hist = S.entries.filter((e) => e.rid === rid).slice(-200).reverse();
  $("dBody").innerHTML = `<dl class="facts">${facts.join("")}</dl>${progress}${windowInfo}${acts}
    <section><h3>History</h3><ol class="history">${hist.map((e) => `<li><time>${dateOf(e.t)}</time><span>${esc(e.text)}</span></li>`).join("") || "<li>Nothing yet.</li>"}</ol></section>`;
  $("dChallenge").onclick = () => enqueue(() => S.engine.userChallenge(rid, Number(($("dOutcome") as HTMLSelectElement).value)));
  $("dBlock").onclick = () => enqueue(() => S.engine.userBlock(rid));
  $("dFreeze").onclick = () => enqueue(() => S.engine.userFreezeDrip(rid, !row.frozen));
}

function renderAnomalies() {
  $("dEyebrow").textContent = "Calls the simulation expected to succeed";
  $("dTitle").textContent = "Unexpected reverts";
  const a = S.engine.anomalies;
  $("dBody").innerHTML = a.length
    ? `<ol class="anom-list">${a.slice(-200).reverse().map((x) => `<li><b>${esc(x.label)}</b>${x.rid ? ` on #${x.rid}` : ""}, ${dateOf(x.t)}: <span class="mono">${esc(x.error)}</span></li>`).join("")}</ol>`
    : `<p>None. Every call an actor made, the contracts accepted.</p>`;
}

function renderInvariants() {
  $("dEyebrow").textContent = `Checked ${S.invChecks.toLocaleString("en-US")} times, at a single block each time`;
  $("dTitle").textContent = "The six invariants";
  const c = S.census!;
  $("dBody").innerHTML = `<ol class="inv-list">${INVARIANTS.map((txt, i) => `<li><i class="${S.invFails[i] ? "fail" : ""}"></i><span>${esc(txt)}</span><span class="mono small">${S.invFails[i] ? `${S.invFails[i]} failed` : "held"}</span></li>`).join("")}</ol>
    <p class="small muted">Now: the Registry holds ${money(c.registryBal, 2)} USDT and its requests record ${money(c.registryHeld, 2)}; the Bank holds ${money(c.bankBal, 2)} and records ${money(c.bankHeld, 2)}; EcoChallenge holds ${money(c.poolBal, 2)} and records ${money(c.poolHeld, 2)}.<br>
    Paid in ${money(S.ledger.inflow(), 2)} = paid out ${money(S.ledger.outflow(), 2)} + held ${money(c.registryBal + c.bankBal + c.poolBal, 2)}.</p>`;
}

function hectareYears(landYears: bigint): string {
  return (Number(landYears) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Arrivals have stopped and every covenant has run out: the end of the programme. */
function programmeOver() {
  S.ended = true;
  S.running = false;
  updatePlay();
  const c = S.census!, m = S.ledger.money, e = S.engine;
  const rows = c.rows;
  const completed = rows.filter((r) => r.stage === "complete").length;
  const land = rows.filter((r) => r.termStart).reduce((a, r) => a + r.land, 0);
  const years = ((c.t - e.start) / YEAR).toFixed(1);
  const item = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const fails = S.invFails.reduce((a, b) => a + b, 0);
  const html = `<section class="banner" id="endBanner"><span class="eyebrow">The end of the programme · ${dateOf(c.t)}</span>
    <h2>The last term ended ${years} years after the first request</h2>
    <p>${fails ? `<b>${fails} invariant checks failed.</b>` : `Every invariant held at all ${S.invChecks.toLocaleString("en-US")} checks.`} ${e.anomalies.length ? `${e.anomalies.length} calls reverted unexpectedly.` : "No call an actor expected to succeed reverted."} Nothing is left in the protocol but ${money(c.registryBal + c.bankBal + c.poolBal, 2)} USDT.</p>
    <dl class="summary">
      ${item("Requests", rows.length.toLocaleString("en-US"))}${item("Terms completed", completed.toLocaleString("en-US"))}
      ${item("Ended early", (rows.length - completed).toLocaleString("en-US"))}${item("Land under covenant", hectares(land))}
      ${item("Hectare-years", hectareYears(c.landYears))}${item("Paid to guardians", `${money(m[9] + m[4] + m[14])} USDT`)}
      ${item("Paid to verifiers", `${money(m[1] + m[6])} USDT`)}${item("TREE minted", money(c.tr3Supply))}
      ${item("Sales", `${money(m[5])} USDT`)}${item("Resales", `${money(m[17])} USDT`)}
      ${item("Transactions", e.actions.toLocaleString("en-US"))}${item("Edition reached", `${c.edition} of ${LAST_EDITION}`)}
    </dl></section>`;
  document.querySelector(".left")!.insertAdjacentHTML("afterbegin", html);
  pushEntry({ t: c.t, rid: 0, cat: "alert", text: "The programme is over: every covenant has run its course.", seq: S.seq++ });
  toast("The programme is over. Its summary is at the top.");
}

// =====================================================================================
// Controls
// =====================================================================================

// ---- travel in time ----

const TRAVEL = ["tBackY", "tBackM", "tDate", "tGo", "tFwdM", "tFwdY"];

/** t moved by whole calendar months (negative goes back). */
function addMonths(t: number, n: number): number {
  const d = new Date(t * 1000);
  d.setUTCMonth(d.getUTCMonth() + n);
  return Math.floor(d.getTime() / 1000);
}

/** To an earlier date: the chain and the actors return to the last checkpoint before it, then live the days up to
 *  it again. To a later date: the actors live every day up to it. */
async function travelTo(target: number) {
  if (!S.ready) return;
  S.running = false;
  S.travelTarget = 0;
  updatePlay();
  while (S.busy) await sleep(30);
  target = Math.max(S.engine.start, midnight(target));
  if (target < S.chainAt) {
    S.busy = true;
    try {
      const cp = await T.restore(T.before(target), S.engine, S.ledger);
      const x = cp.extra;
      S.entries = S.entries.filter((e) => e.seq < x.seq);
      S.seq = x.seq;
      S.raw = S.raw.filter((e) => e.block <= cp.block);
      S.samples = S.samples.filter((m) => m.t <= cp.t);
      S.nextSample = x.nextSample;
      S.invChecks = x.invChecks;
      S.invFails = [...x.invFails];
      S.seen = new Set(x.seen);
      S.ended = x.ended;
      if (!S.ended) $("endBanner")?.remove();
      S.clock = cp.t;
      S.chainAt = cp.t;
      S.lastLogBlock = cp.block;
      S.block = cp.block;
      S.effective = [];
      resetCensus();
      chartedSamples = -1;
      closeDrawer();
      S.census = await census(S.engine.requests, S.engine.done, S.ledger, S.block, S.clock);
      await refreshCountryStatus();
      redrawFeed();
      render();
      S.explorer?.refresh();
    } catch (e) {
      console.error(e);
      toast(`Going back failed: ${(e as Error).message ?? e}`);
      return;
    } finally {
      S.busy = false;
    }
  }
  if (target > S.chainAt) {
    S.travelTarget = target;
    renderClock();
    toast(`Travelling to ${dateOf(target)}. Press Pause to stop on the way.`);
  } else toast(`Back at ${dateOf(S.clock)}.`);
}

function arrive() {
  S.travelTarget = 0;
  updatePlay();
  renderClock();
  toast(`Arrived at ${dateOf(S.clock)}.`);
}

function enqueue(job: () => Promise<string>) {
  S.queue.push(job);
  toast("Sending…");
}

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => (t.hidden = true), 4200);
}

function updatePlay() {
  $("play").textContent = S.running || S.travelTarget ? "Pause" : "Play";
  if (S.census) renderStrip();
}

function fillSelects() {
  const opts = COUNTRIES.map((c) => `<option value="${c.code}">${c.name}</option>`).join("");
  $("reqCountry").innerHTML = opts;
  $("statusCountry").innerHTML = opts;
  $("freezeHolder").innerHTML = Object.values(S.engine.holders).map((h) => `<option value="${h}">${esc(nameOf(h))}</option>`).join("");
}

function wire() {
  $("speeds").innerHTML = SPEEDS.map((s, i) => `<button type="button" role="radio" aria-checked="${s.v === S.speed}" data-i="${i}" title="${s.title}">${s.label}</button>`).join("");
  $("speeds").onclick = (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    S.speed = SPEEDS[Number(b.dataset.i)].v;
    S.effective = [];
    for (const x of $("speeds").children) x.setAttribute("aria-checked", String(x === b));
  };
  $("play").onclick = () => {
    if (S.travelTarget) { S.travelTarget = 0; updatePlay(); renderClock(); toast(`Stopped at ${dateOf(S.clock)}.`); return; }
    if (S.ended) { toast("The programme is over. Go back in time, or Reset to run another."); return; }
    S.running = !S.running; S.effective = []; updatePlay();
  };
  $("skip").onclick = async () => {
    if (S.busy || !S.ready || S.ended) return;
    await advance(nextStop(S.chainAt, S.engine.nextDue()));
    toast(`Moved to ${dateOf(S.clock)}.`);
  };
  $("reset").onclick = () => void resetProgramme();
  $("walletRoles").innerHTML = WALLET_ROLES.map((r) => `<button type="button" aria-pressed="${r.k === walletRole}" data-k="${r.k}">${r.label}</button>`).join("");
  $("walletRoles").onclick = (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    walletRole = b.dataset.k as WalletRole;
    for (const x of $("walletRoles").children) x.setAttribute("aria-pressed", String(x === b));
    void renderWallets(true);
  };
  // the platform counts each wallet's transactions; the actors' record of them travels with a checkpoint
  sendHook.fn = (from) => { if (S.engine) { const k = from.toLowerCase(); S.engine.txBy.set(k, (S.engine.txBy.get(k) ?? 0) + 1); } };
  $("tBackY").onclick = () => void travelTo(addMonths(S.clock, -12));
  $("tBackM").onclick = () => void travelTo(addMonths(S.clock, -1));
  $("tFwdM").onclick = () => void travelTo(addMonths(S.clock, 1));
  $("tFwdY").onclick = () => void travelTo(addMonths(S.clock, 12));
  $("tGo").onclick = () => {
    const v = $<HTMLInputElement>("tDate").value;
    if (v) void travelTo(Date.parse(`${v}T00:00:00Z`) / 1000);
  };
  $("chips").innerHTML = CHIPS.map((c) => `<button type="button" aria-pressed="${c.k === S.filter}" data-k="${c.k}">${c.label}</button>`).join("");
  $("chips").onclick = (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    S.filter = b.dataset.k as any;
    for (const x of $("chips").children) x.setAttribute("aria-pressed", String(x === b));
    redrawFeed();
  };
  $<HTMLInputElement>("showMinor").onchange = (e) => { S.showMinor = (e.target as HTMLInputElement).checked; redrawFeed(); };
  $<HTMLInputElement>("showFinished").onchange = (e) => { S.showFinished = (e.target as HTMLInputElement).checked; renderBoard(); };
  $("lanes").onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".tile");
    if (t) openDrawer(Number(t.dataset.rid));
  };
  $("feed").onclick = (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-rid]");
    if (a) openDrawer(Number(a.dataset.rid));
  };
  $("dClose").onclick = closeDrawer;
  $("scrim").onclick = closeDrawer;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
    if (e.key === " " && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement) && S.ready) {
      e.preventDefault();
      $("play").click();
    }
  });
  $("sAnomalies").onclick = () => { if (!S.engine) return; S.openRid = -1; $("drawer").hidden = false; $("scrim").hidden = false; renderAnomalies(); };
  $("sInvariants").onclick = () => { if (!S.census) return; S.openRid = -2; $("drawer").hidden = false; $("scrim").hidden = false; renderInvariants(); };
  $("doRequest").onclick = () => enqueue(() => S.engine.userRequest(Number(($("reqCountry") as HTMLSelectElement).value)));
  $("doFreeze").onclick = () => enqueue(() => S.engine.userEmergencyFreeze(($("freezeHolder") as HTMLSelectElement).value as Address));
  $("doSuspend").onclick = () => enqueue(async () => { const m = await S.engine.userCountryStatus(Number(($("statusCountry") as HTMLSelectElement).value), false); await refreshCountryStatus(); return m; });
  $("doResume").onclick = () => enqueue(async () => { const m = await S.engine.userCountryStatus(Number(($("statusCountry") as HTMLSelectElement).value), true); await refreshCountryStatus(); return m; });
  $("legend").innerHTML = [["s-watchdog", "Verification"], ["s-flow", "Deeds"], ["s-auction", "Sale"], ["s-active", "Term"], ["s-blocked", "Blocked"]]
    .map(([c, l]) => `<span><i class="${c}" style="background:currentColor"></i>${l}</span>`).join("");
  redrawFeed();
}

// keep the country lanes' suspended marker current
setInterval(() => { if (S.ready && !S.busy) void refreshCountryStatus(); }, 5000);

function setView(v: "sim" | "explorer") {
  for (const b of document.querySelectorAll<HTMLElement>("[data-view]")) b.setAttribute("aria-selected", String(b.dataset.view === v));
  $("simView").hidden = v !== "sim";
  $("strip").hidden = v !== "sim";
  $("explorer").hidden = v !== "explorer";
  if (v === "explorer") {
    if (!S.explorer) S.explorer = mountExplorer($("explorer"), { ready: () => S.ready, events: () => S.raw, enqueue });
    else S.explorer.refresh();
  }
}
document.querySelector(".views")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
  if (b) setView(b.dataset.view as "sim" | "explorer");
});

(window as any).sim = S; // for the smoke test and the console
wire();
updatePlay();
void boot();
void loop();
