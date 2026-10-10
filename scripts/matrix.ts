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
const SIM = "../sim/"; // the analysis folder, sim/ in this repository
const OUT = new URL(`${SIM}out/matrix/`, import.meta.url).pathname;
type Case = { name: string; what: string; scenario: Scenario; years: number };

const base = (id: string) => cloneScenario(SCENARIOS.find((s) => s.id === id)!);
const cases: Case[] = [];
for (const s of SCENARIOS) {
  if (s.id === "custom") continue;
  cases.push({ name: s.id, what: s.summary, scenario: cloneScenario(s), years: s.id === "fill" || s.id === "edition-race" ? 70 : s.id === "fifteen" ? 16 : 10 });
}
{
  const s = base("fifteen");
  s.id = "fast-clock"; s.name = "A fast clock";
  Object.assign(s.contracts, { yearDays: 120, acceptanceDays: 10, watchdogDays: 5, minAuctionDays: 2, kycDays: 10, reviewDays: 10,
    maxVerificationDelayDays: 12, responseDays: 3, panelDays: 3, redrawDays: 3, haltAfter: 2, editionScale: 20000,
    // the paper clocks no shorter than the actors' pace: they revisit a paper step every one to five days (Engine.flow)
    powerDays: 7, anchoringDays: 10, attestationDays: 15, decisionDays: 2, gtaAttestFromDays: 7, guardianAnchorFromDays: 4,
    restoreDays: 20, damageDays: 5, firstClaimDays: 1, reseatDays: 10, accessionDays: 60 });
  for (const c of s.countries) { c.listingDays = 100; if (c.postSaleDays) c.postSaleDays = 20; }
  s.behaviour.arrivalYears = 15; s.behaviour.arrivalsPerYear = 12;
  cases.push({ name: s.id, what: "A 120-day protocol year with every window and clock shortened: 10-day review, 5-day watchdog, 3+3+3-day challenges, halts after 2 unattested windows, 7-day power, 10-day anchoring and 15-day attestation clocks (a GTA from day 7), 20-day restore, 10-day reseat, 60-day accession, 100-day listing, 20-day post-sale.", scenario: s, years: 15 });
}
{
  const s = base("fifteen");
  s.id = "slow-clock"; s.name = "A slow clock";
  Object.assign(s.contracts, { yearDays: 730, reviewDays: 60, maxVerificationDelayDays: 28, acceptanceDays: 45, watchdogDays: 21,
    minAuctionDays: 5, kycDays: 60, responseDays: 10, panelDays: 10, redrawDays: 10, haltAfter: 4, editionScale: 20000,
    powerDays: 28, anchoringDays: 28, attestationDays: 60, decisionDays: 5, gtaAttestFromDays: 42, guardianAnchorFromDays: 14,
    restoreDays: 120, damageDays: 28, firstClaimDays: 5, reseatDays: 60, accessionDays: 360 });
  for (const c of s.countries) { c.listingDays = 600; if (c.postSaleDays) c.postSaleDays = 120; }
  s.behaviour.arrivalYears = 6; s.behaviour.arrivalsPerYear = 30; s.behaviour.maxTermYears = 12;
  cases.push({ name: s.id, what: "A two-year protocol year: 60-day review, 28-day grace, 21-day watchdog, 10+10+10-day challenges, halts after 4, 28-day power and anchoring and 60-day attestation clocks (a GTA from day 42), 120-day restore, 360-day accession, 600-day listing.", scenario: s, years: 8 });
}
{
  const s = base("fifteen");
  s.id = "fees"; s.name = "Different fees";
  Object.assign(s.contracts, { baseFee: 80, verifierPermille: 60, taxPermille: 40, foundationPermille: 15 });
  const lk = s.countries.find((c) => c.code === 144)!, br = s.countries.find((c) => c.code === 76)!, id = s.countries.find((c) => c.code === 360)!;
  Object.assign(lk, { baseFee: 30, deskRate: 3, allowanceFixed: 12, allowancePerHa: 5 });
  Object.assign(br, { deskRate: 6, allowanceFixed: 0, allowancePerHa: 0 });
  Object.assign(id, { baseFee: 120 });
  s.behaviour.arrivalYears = 8; s.behaviour.arrivalsPerYear = 15;
  cases.push({ name: s.id, what: "V 80, a 6% / 4% / 1.5% split (verifier / tax / Foundation: a 1.3% pool and a 1.2% Holder share), Sri Lanka's V 30 with D 3 and an allowance of 12 + 5 a hectare, Indonesia's V 120, Brazil's D 6 and no allowance.", scenario: s, years: 10 });
}
{
  const s = base("fifteen");
  s.id = "new-countries"; s.name = "New countries";
  s.countries = s.countries.filter((c) => c.code !== 392);
  s.countries.push(
    { code: 404, name: "Kenya", short: "KE", flowId: 3, minTerm: 10, maxTerm: 40, listingDays: 330, postSaleDays: 60, baseFee: 0, deskRate: 5, allowanceFixed: 20, allowancePerHa: 1, holders: 2, orgsPerHolder: 2, verifiersPerOrg: 3, weight: 25 },
    { code: 356, name: "India", short: "IN", flowId: 1, minTerm: 5, maxTerm: 60, listingDays: 330, postSaleDays: 0, baseFee: 40, deskRate: 0, allowanceFixed: 40, allowancePerHa: 3, holders: 3, orgsPerHolder: 1, verifiersPerOrg: 4, weight: 25 },
  );
  s.behaviour.arrivalYears = 8; s.behaviour.arrivalsPerYear = 18;
  cases.push({ name: s.id, what: "Japan removed; Kenya on path B (10-40 years, D 5, allowance 20 + 1 a hectare) and India under a power (5-60 years, V 40, allowance 40 + 3 a hectare), each with its own cast.", scenario: s, years: 10 });
}
{
  const s = base("fifteen");
  s.id = "lean-cast"; s.name = "A lean cast";
  for (const c of s.countries) Object.assign(c, { holders: 1, orgsPerHolder: 2, verifiersPerOrg: 1 });
  s.behaviour.arrivalYears = 8; s.behaviour.arrivalsPerYear = 12;
  cases.push({ name: s.id, what: "One Trust Admin a country with two one-verifier organisations: each organisation's verifier is the other's only independent attester and challenger, and with the land's own Trust Admin excluded every panel is three GTAs.", scenario: s, years: 10 });
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
  const anvil = spawn("anvil", ["--auto-impersonate", "--timestamp", "1767225600", "--port", String(port), "--gas-limit", "100000000", "--prune-history", "64", "--silent"], { stdio: "ignore" });
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
