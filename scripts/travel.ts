// Tests travel in time: runs a scenario with a checkpoint every month, goes back to an earlier checkpoint, lives the
// same days again, and checks the chain and the actors arrive exactly where they were the first time.
//
//   anvil --auto-impersonate --timestamp 1798761600 --port 8611 --gas-limit 100000000 --prune-history 64
//   RPC=http://127.0.0.1:8611 SCENARIO=fifteen YEARS=3 BACK_TO=1 ANVIL_PID=<pid> npx tsx scripts/travel.ts
import { execSync } from "node:child_process";
import { latestBlock, mineAt, logsBetween, prepareChain, read, sendHook } from "../src/chain";
import { deploy } from "../src/deploy";
import { Engine } from "../src/engine";
import { Ledger, census, resetCensus } from "../src/ledger";
import { DAY, setYear, setCountries, YEAR } from "../src/model";
import { SCENARIOS, cloneScenario, FLOWS } from "../src/config";
import { Timeline, nextStop } from "../src/travel";

const sc = cloneScenario(SCENARIOS.find((s) => s.id === (process.env.SCENARIO ?? "fifteen"))!);
const years = Number(process.env.YEARS ?? 3);
const backTo = Number(process.env.BACK_TO ?? 1);
const rss = () => process.env.ANVIL_PID ? Number(execSync(`ps -o rss= -p ${process.env.ANVIL_PID}`).toString().trim()) / 1024 : NaN;

await prepareChain();
await deploy(sc, () => {});
setYear(sc.contracts.yearDays);
setCountries(sc.countries.map((c) => ({ code: c.code, name: c.name, short: c.short, flow: FLOWS.find((f) => f.id === c.flowId)?.name ?? "" })));
const e = new Engine(Number(process.env.SEED ?? 4), sc);
const L = new Ledger();
await e.setup(() => {});
let b = await latestBlock();
e.begin(b.timestamp);
const start = b.timestamp;
let lastLog = b.number;
const T = new Timeline<{ lastLog: string }>();

async function runTo(end: number) {
  for (;;) {
    // as the app does: each step from the chain's own time
    let t = (await latestBlock()).timestamp;
    if (t >= end) break;
    t = Math.min(end, nextStop(t, e.nextDue(), 7 * DAY));
    const m = await mineAt(t);
    await e.tick(m.timestamp);
    b = await latestBlock();
    for (const log of await logsBetween(lastLog + 1n, b.number)) L.ingest(log);
    lastLog = b.number;
    if (T.due(b.timestamp)) await T.take(b.timestamp, b.number, e, L, { lastLog: String(lastLog) });
  }
}

async function fingerprint() {
  const blk = await latestBlock();
  const c = await census(e.requests, e.done, L, blk.number, blk.timestamp);
  return JSON.stringify({
    block: String(blk.number), t: blk.timestamp, actions: e.actions, requests: e.requests.length, done: e.done.size,
    money: L.money.map(String), inv: c.inv, edition: c.edition, supply: String(c.tr3Supply),
    bank: String(c.bankBal), pool: String(c.poolBal), registry: String(c.registryBal), tokens: String(await read("token", "nextTokenId")),
  });
}

// every send after FROM (years), with the engine's clock, to find where a replay parts from the first run
const from = start + Number(process.env.TRACE_FROM ?? 99) * YEAR;
let trace: string[] = [];
const traces: string[][] = [];
sendHook.fn = (who, c, fn, args) => { if (e.now >= from) trace.push(`${e.now} ${who.slice(0, 8)} ${c}.${fn}(${args.map(String).join(",")})`); };
const t0 = performance.now();
await T.take(b.timestamp, b.number, e, L, { lastLog: String(lastLog) });
const mb0 = rss();
await runTo(start + years * YEAR);
const first = await fingerprint();
traces.push(trace); trace = [];
const mb1 = rss();
console.log(`ran ${years} years in ${((performance.now() - t0) / 1000).toFixed(0)}s, ${T.points.length} checkpoints; anvil ${mb0.toFixed(0)} → ${mb1.toFixed(0)} MB`);

let failed = false;
for (const back of String(process.env.BACKS ?? backTo).split(",").map(Number)) {
  const i = T.before(start + back * YEAR);
  const cp = await T.restore(i, e, L);
  lastLog = BigInt(cp.extra.lastLog);
  resetCensus();
  console.log(`back to checkpoint ${i}: ${new Date(cp.t * 1000).toISOString().slice(0, 10)}, block ${(await latestBlock()).number} (checkpoint block ${cp.block})`);
  await runTo(start + years * YEAR);
  const again = await fingerprint();
  traces.push(trace); trace = [];
  const orig = traces[0].filter((x) => Number(x.split(" ")[0]) >= cp.t), rep = traces[traces.length - 1];
  const k = orig.findIndex((x, j) => x !== rep[j]);
  if (k >= 0) console.log(`  first difference at send ${k}:\n    first run: ${orig.slice(Math.max(0, k - 3), k + 2).join("\n               ")}\n    replay:    ${rep.slice(Math.max(0, k - 3), k + 2).join("\n               ")}`);
  if (again === first) console.log("  replay identical");
  else { failed = true; console.log("  REPLAY DIFFERS"); console.log("  " + first); console.log("  " + again); }
}
console.log(`anvil after the replays ${rss().toFixed(0)} MB`);
process.exit(failed ? 1 : 0);
