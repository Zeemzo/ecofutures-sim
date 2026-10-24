// Drives the forms the way a tester does: deploys the "one" scenario, then on the Contracts tab types into
// Registry.requestVerification and checks every unit preview, reads EcoLens.quote and checks its output is shown in
// USDT, TR3 and hectares, and from Take over's "Act freely" sends a request with maxTotal typed as a plain 1000.
// Found necessary 15 Oct: a tester typed maxTotal 1000 and the form sent 1000 base units (PriceAboveMaximum).
//
//   npx vite build && node scripts/forms-smoke.mjs
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_PORT = 4318, PORT = 8897;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = spawn("anvil", ["--auto-impersonate", "--timestamp", "1767225600", "--port", String(PORT), "--gas-limit", "100000000", "--prune-history", "64", "--silent"], { stdio: "ignore" });
const preview = spawn(new URL("../node_modules/.bin/vite", import.meta.url).pathname, ["preview", "--port", String(PAGE_PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
process.on("exit", () => { node.kill(); preview.kill(); });
for (let i = 0; ; i++) { try { if ((await fetch(`http://127.0.0.1:${PAGE_PORT}/`)).ok) break; } catch {} if (i > 60) throw new Error("no page"); await sleep(500); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
let failed = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`); if (!ok) failed++; };

await page.goto(`http://127.0.0.1:${PAGE_PORT}/?rpc=${encodeURIComponent(`http://127.0.0.1:${PORT}`)}`, { waitUntil: "networkidle0" });
await page.click('[data-scenario="one"]');
await page.click("#toProduction");
await page.click("#start");
await page.waitForFunction(() => document.getElementById("overlay")?.hidden === true, { timeout: 180_000 });

// ---- Contracts tab: Registry.requestVerification's fields
await page.click('[data-view="explorer"]');
await page.waitForSelector(".node", { timeout: 15_000 });
await page.click('.node[data-key="registry"]');
await sleep(300);
const open = async (sig) => page.evaluate((sig) => { const d = [...document.querySelectorAll("details.fn")].find((x) => x.dataset.fn === sig); if (d) d.open = true; return !!d; }, sig);
check(await open("requestVerification(uint16,uint64,uint16,bytes32,address,uint256,string)"), "requestVerification is listed");
const form = 'details.fn[data-fn="requestVerification(uint16,uint64,uint16,bytes32,address,uint256,string)"] form';
const type = async (sel, i, v, attr = "data-arg") => { const el = await page.$(`${sel} [${attr}="${i}"]`); await el.click({ clickCount: 3 }); await el.type(v); };
await type(form, 1, "1 ha");
await type(form, 5, "1000");
const pv = await page.$$eval(`${form} .preview`, (xs) => xs.map((x) => x.textContent));
check(pv.some((t) => /1 ha/.test(t)), "landUnits preview", pv.join(" | "));
check(pv.some((t) => /1,000 USDT/.test(t)), "maxTotal preview", pv.join(" | "));
const ph = await page.$eval(`${form} [data-arg="5"]`, (x) => x.placeholder);
check(/USDT/.test(ph), "maxTotal placeholder names USDT", ph);

// ---- a read: EcoLens.quote, its output in units
await page.evaluate(() => document.querySelector('.side-c[data-goto="lens"]')?.click());
await sleep(300);
await page.evaluate(() => document.querySelector('[data-extab="reads"]')?.click());
await sleep(300);
check(await open("quote(uint16,uint64,uint16,uint8)"), "EcoLens.quote is listed");
const qf = 'details.fn[data-fn="quote(uint16,uint64,uint16,uint8)"] form';
await type(qf, 0, "144"); await type(qf, 1, "100"); await type(qf, 2, "5"); await type(qf, 3, "100");
await page.click(`${qf} button[type="submit"]`);
await page.waitForFunction((qf) => /USDT|Reverted/.test(document.querySelector(`${qf} .out`)?.textContent ?? ""), { timeout: 20_000 }, qf);
const out = await page.$eval(`${qf} .out`, (x) => x.textContent);
check(/"upfront": "219 USDT"/.test(out) && /TR3/.test(out) && /"edition": 1/.test(out), "quote shown in USDT and TR3", out.replace(/\s+/g, " ").slice(0, 300));

// ---- Take over, Act freely: Guardian 1 requests with maxTotal 1000
await page.click('[data-view="sim"]');
await sleep(500);
// play until the scenario's landowner exists, then pause
await page.click("#play");
await page.waitForFunction(() => (window.sim.engine?.requests?.length ?? 0) > 0, { timeout: 60_000 });
await page.click("#play");
await sleep(1500);
await page.select("#freeWho", await page.$eval("#freeWho", (s) => [...s.options].find((o) => /Guardian 1\b/.test(o.textContent))?.value ?? ""));
await sleep(300);
await page.select("#freeFn", "registry.requestVerification");
await sleep(300);
const ff = "#freeForm";
check(await page.$eval("#freeWho", (s) => /Guardian/.test(s.selectedOptions[0]?.textContent ?? "")), "acting as the landowner");
const vals = ["144", "100", "5", "forms smoke parcel", "0x0000000000000000000000000000000000000000", "1000", "forms-smoke"];
for (let i = 0; i < vals.length; i++) await type(ff, i, vals[i], "data-farg");
const before = await page.evaluate(() => window.sim.engine.requests.length);
await page.click(`${ff} button[type="submit"]`);
await page.click("#play");
await page.waitForFunction(() => /Sent|Reverted/.test(document.querySelector("#freeOut")?.textContent ?? ""), { timeout: 60_000 }).catch(() => {});
const res = await page.$eval("#freeOut", (x) => x.textContent);
check(/^Sent/.test(res), "a request sent with maxTotal 1000", res);
await page.click("#play").catch(() => {});

// ---- a list: EcoLists.requests with a JSON filter, a field by an actor's name, an enum by its name, the rest "any"
await page.click('[data-view="explorer"]');
await sleep(300);
await page.evaluate(() => document.querySelector('.side-c[data-goto="lists"]')?.click());
await sleep(300);
await page.evaluate(() => document.querySelector('[data-extab="reads"]')?.click());
await sleep(300);
const rsig = await page.evaluate(() => [...document.querySelectorAll("details.fn")].map((d) => d.dataset.fn).find((f) => f?.startsWith("requests(")));
check(!!rsig && await open(rsig), "EcoLists.requests is listed", rsig ?? "");
const rf = `details.fn[data-fn="${rsig}"] form`;
await type(rf, 0, '{"status": "NONE", "guardian": "Guardian 1"}'); // NONE: any status, by its name
await type(rf, 1, "0"); await type(rf, 2, "200");
await page.click(`${rf} button[type="submit"]`);
await page.waitForFunction((rf) => /rows|Reverted|⚠|rror/.test(document.querySelector(`${rf} .out`)?.textContent ?? ""), { timeout: 20_000 }, rf)
  .catch(async () => console.log("no output:", await page.$eval(rf, (x) => x.outerHTML.slice(0, 1500))));
const lout = await page.$eval(`${rf} .out`, (x) => x.textContent);
check(/"rows"/.test(lout) && /\(Guardian 1\)/.test(lout) && / ha/.test(lout) && /USDT/.test(lout), "a list read with a JSON filter, rows in units", lout.replace(/\s+/g, " ").slice(0, 300));

check(errors.length === 0, "no page errors", errors[0] ?? "");
void before;
await browser.close();
console.log(failed ? `${failed} failed` : "every form check passed");
process.exit(failed ? 1 : 0);
