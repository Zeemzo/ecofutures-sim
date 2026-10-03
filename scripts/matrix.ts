// Tests every configuration the simulator offers against the contracts. For each: a fresh anvil, the protocol
// deployed with that configuration, the run, and the audit that reads the configuration back from the chain and
// checks the contracts enforced exactly it. Writes sim/out/matrix/<name>/{config.json,run.log,audit.json}.
//
//   npx tsx scripts/matrix.ts            all of them, four at a time
//   npx tsx scripts/matrix.ts fees late  just these
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { SCENARIOS, cloneScenario, validate, type Scenario } from "../src/config";

// the analysis folder: v11/sim inside the contracts repo, sim/ beside the simulator on its own
const SIM = existsSync(new URL("../../foundry.toml", import.meta.url)) ? "../../sim/" : "../sim/";
const OUT = new URL(`${SIM}out/matrix/`, import.meta.url).pathname;
type Case = { name: string; what: string; scenario: Scenario; years: number };

const base = (id: string) => cloneScenario(SCENARIOS.find((s) => s.id === id)!);
const cases: Case[] = [];
for (const s of SCENARIOS) {
  if (s.id === "custom") continue;
  cases.push({ name: s.id, what: s.summary, scenario: cloneScenario(s), years: s.id === "fifteen" ? 16 : 10 });
}
{
  const s = base("fifteen");
  s.id = "fees"; s.name = "Different fees";
  Object.assign(s.contracts, { baseFee: 80, verifierPermille: 60, taxPermille: 40, serverPermille: 15 });
  const lk = s.countries.find((c) => c.code === 144)!, br = s.countries.find((c) => c.code === 76)!, id = s.countries.find((c) => c.code === 360)!;
  Object.assign(lk, { baseFee: 30, attestationFee: 12, judgmentFee: 20 });
  Object.assign(br, { attestationFee: 3, judgmentFee: 15 });
  Object.assign(id, { baseFee: 120 });
  s.behaviour.arrivalYears = 8; s.behaviour.arrivalsPerYear = 15;
  cases.push({ name: s.id, what: "V 80, a 6% / 4% / 1.5% split (verifier / tax / server), Sri Lanka's V 30 with 12 and 20 USDT attestation and judgment fees, Indonesia's V 120, Brazil's fees 3 and 15.", scenario: s, years: 10 });
}
{
  const s = base("fifteen");
  s.id = "new-countries"; s.name = "New countries";
  s.countries = s.countries.filter((c) => c.code !== 392);
  s.countries.push(
    { code: 404, name: "Kenya", short: "KE", flowId: 3, minTerm: 10, maxTerm: 40, listingDays: 330, postSaleDays: 60, baseFee: 0, attestationFee: 7, judgmentFee: 11, holders: 2, orgsPerHolder: 2, verifiersPerOrg: 3, weight: 25 },
    { code: 356, name: "India", short: "IN", flowId: 1, minTerm: 5, maxTerm: 60, listingDays: 330, postSaleDays: 0, baseFee: 40, attestationFee: 6, judgmentFee: 10, holders: 3, orgsPerHolder: 1, verifiersPerOrg: 4, weight: 25 },
  );
  s.behaviour.arrivalYears = 8; s.behaviour.arrivalsPerYear = 18;
  cases.push({ name: s.id, what: "Japan removed; Kenya on path B (10-40 years) and India under a power (5-60 years, V 40), each with its own cast.", scenario: s, years: 10 });
}
{
  const s = base("fifteen");
  s.id = "lean-cast"; s.name = "A lean cast";
  for (const c of s.countries) Object.assign(c, { holders: 1, orgsPerHolder: 2, verifiersPerOrg: 1 });
  s.behaviour.arrivalYears = 8; s.behaviour.arrivalsPerYear = 12;
  cases.push({ name: s.id, what: "One Trust Admin a country with two one-verifier organisations: no independent verifier exists, so attestations fall to the backstop and challenges cannot be raised.", scenario: s, years: 10 });
}

const only = process.argv.slice(2);
const todo = only.length ? cases.filter((c) => only.includes(c.name)) : cases;
for (const c of todo) {
  const problems = validate(c.scenario);
  if (problems.length) { console.error(`${c.name}: ${problems.join("; ")}`); process.exit(1); }
}

function run(cmd: string, args: string[], env: Record<string, string>, log: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => { writeFileSync(log, out); resolve(code ?? 1); });
  });
}

async function one(c: Case, port: number) {
  const dir = `${OUT}${c.name}/`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}config.json`, JSON.stringify({ scenario: c.scenario, seed: 4, years: c.years, what: c.what }, null, 1));
  try { execSync(`lsof -ti tcp:${port} | xargs kill 2>/dev/null`); } catch {}
  const anvil = spawn("anvil", ["--auto-impersonate", "--timestamp", "1798761600", "--port", String(port), "--gas-limit", "100000000", "--prune-history", "64", "--silent"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1500));
  const rpc = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  const r1 = await run("npx", ["tsx", "scripts/headless.ts"], { RPC: rpc, CONFIG: `${dir}config.json`, SEED: "4", YEARS: String(c.years) }, `${dir}run.log`);
  const r2 = await run("npx", ["tsx", "scripts/audit.ts"], { RPC: rpc, CONFIG: `${dir}config.json`, NAME: c.name, AUDIT_OUT: dir }, `${dir}audit.log`);
  anvil.kill();
  const audit = existsSync(`${dir}audit.json`) ? JSON.parse(readFileSync(`${dir}audit.json`, "utf8")) : null;
  const fails = audit ? audit.checks.filter((x: any) => x.failureCount > 0).map((x: any) => `${x.id} (${x.failureCount})`) : ["no audit"];
  console.log(`${c.name.padEnd(16)} run ${r1 === 0 ? "ok" : "FAILED"}  audit ${r2 === 0 ? "ok" : "FAILED"}  ${Math.round((Date.now() - t0) / 1000)}s  ${fails.length ? "FAIL: " + fails.join(", ") : "all checks held"}`);
}

const queue = [...todo];
await Promise.all([8601, 8602, 8603, 8604].map(async (port) => {
  for (let c = queue.shift(); c; c = queue.shift()) await one(c, port);
}));
console.log("done");
