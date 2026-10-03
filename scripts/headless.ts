// Runs a scenario without the browser on a fresh anvil node: deploys V11 with the scenario's configuration (the
// app's own deployer, no Foundry), then stops at midnight on each day anyone acts (at most a week apart; STEP=week for
// a week at a time), checking the invariants every month.
//
//   anvil --auto-impersonate --timestamp 1798761600 --port 8546 --gas-limit 100000000 --prune-history 64
//   RPC=http://127.0.0.1:8546 SCENARIO=fill SEED=1 YEARS=60 npx tsx scripts/headless.ts
//
// SCENARIO is a scenario id from src/config.ts; RATE overrides its arrivals a year. The contracts run at production
// settings: a CONFIG file with any other timing or edition scale is refused.
import { latestBlock, mineAt, logsBetween, prepareChain, timing } from "../src/chain";
import { deploy } from "../src/deploy";
import { Engine } from "../src/engine";
import { Ledger, census, INVARIANTS } from "../src/ledger";
import { DAY, setYear, setCountries, YEAR } from "../src/model";
import { SCENARIOS, cloneScenario, validate, toProduction, FLOWS, type Scenario } from "../src/config";
import { nextStop } from "../src/travel";

// CONFIG: a scenario file (the setup screen's "Save settings" writes one); else SCENARIO, a scenario id
const fs = await import("node:fs");
const given: Scenario = process.env.CONFIG
  ? (((j) => j.scenario ?? j)(JSON.parse(fs.readFileSync(process.env.CONFIG, "utf8"))))
  : SCENARIOS.find((s) => s.id === (process.env.SCENARIO ?? "fifteen")) ?? SCENARIOS[0];
const atProduction = toProduction(structuredClone(given));
if (atProduction.length) { console.error(`The contracts run at production settings only; this configuration changes ${atProduction.join(", ")}.`); process.exit(1); }
const sc = cloneScenario(given);
if (process.env.RATE) sc.behaviour.arrivalsPerYear = Number(process.env.RATE);
const problems = validate(sc);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
const years = Number(process.env.YEARS ?? 60);
const seed = Number(process.env.SEED ?? 20270101);

await prepareChain();
const t0 = performance.now();
await deploy(sc, (m) => console.log(`  ${m}`));
setYear(sc.contracts.yearDays);
setCountries(sc.countries.map((c) => ({ code: c.code, name: c.name, short: c.short, flow: FLOWS.find((f) => f.id === c.flowId)?.name ?? "" })));
const e = new Engine(seed, sc);
const L = new Ledger();
await e.setup((m) => console.log(`  ${m}`));
let b = await latestBlock();
e.begin(b.timestamp);
console.log(`${sc.name}: deployed and cast in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
let lastLog = 0n, checks = 0, nextMonth = b.timestamp;
const fails = [0, 0, 0, 0, 0, 0];
const end = b.timestamp + years * YEAR;
const prof = { tick: 0, ingest: 0, census: 0, mine: 0 };
const stamp = () => performance.now();
// STEP=week steps a week at a time; the default stops at midnight on the next day anyone acts, at most a week on
const weekly = process.env.STEP === "week";
const stepFrom = (t: number) => weekly ? t + 7 * DAY : nextStop(t, e.nextDue(), 7 * DAY);
for (let t = stepFrom(b.timestamp); t <= end && !e.finished; t = stepFrom(t)) {
  let s0 = stamp();
  const m = await mineAt(t);
  prof.mine += stamp() - s0; s0 = stamp();
  await e.tick(m.timestamp);
  prof.tick += stamp() - s0; s0 = stamp();
  b = await latestBlock();
  for (const log of await logsBetween(lastLog + 1n, b.number)) L.ingest(log);
  lastLog = b.number;
  prof.ingest += stamp() - s0;
  if (b.timestamp >= nextMonth) {
    nextMonth += 30 * DAY;
    const s1 = stamp();
    const c = await census(e.requests, e.done, L, b.number, b.timestamp);
    prof.census += stamp() - s1;
    checks++;
    c.inv.forEach((ok, i) => { if (!ok) { fails[i]++; console.log(`  invariant ${i + 1} failed at ${new Date(b.timestamp * 1000).toISOString().slice(0, 10)}: ${INVARIANTS[i]}`); } });
    if (checks % 12 === 0) {
      console.log(`${new Date(b.timestamp * 1000).toISOString().slice(0, 10)}  requests ${e.requests.length}  done ${e.done.size}  actions ${e.actions}  anomalies ${e.anomalies.length}  edition ${c.edition}  ${Math.round((performance.now() - t0) / 1000)}s`);
    }
  }
}
console.log(`\n${sc.name}, seed ${seed}: ${e.requests.length} requests, ${e.done.size} finished, finished=${e.finished}, ${e.actions} actions, ${checks} checks, ${new Date(b.timestamp * 1000).toISOString().slice(0, 10)}`);
console.log(`invariant failures: ${fails.join(", ")}`);
console.log(`anomalies: ${e.anomalies.length}`);
const by: Record<string, number> = {};
for (const a of e.anomalies) by[`${a.label}: ${a.error}`] = (by[`${a.label}: ${a.error}`] ?? 0) + 1;
if (e.anomalies.length) console.log(by);
console.log(JSON.stringify(e.kinds));
console.log("time (s)", Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, (v / 1000).toFixed(1)])), "sends", timing.sends);
