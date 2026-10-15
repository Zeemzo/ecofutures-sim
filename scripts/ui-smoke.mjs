// Drives the setup screen in a real browser, as a tester would: for each scenario, on its own fresh anvil, pick it,
// press "Production settings", then "Deploy and set up", and wait for the run to be ready. Also loads a settings file
// saved by 1.x (V11's countries and flows) the same way. Found necessary by Ravi, 12 Oct: a 1.x setup reached the
// deploy with no allowance and failed "Cannot convert undefined to a BigInt"; the headless runs never touch this screen.
//
//   npx vite build && node scripts/ui-smoke.mjs            every scenario, then the 1.x file
//   node scripts/ui-smoke.mjs fill good-day                just these
//
// Needs Google Chrome (CHROME=path to override) and anvil on PATH.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_PORT = 4317;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// every chain and the page server stop however the test ends
const chains = new Set();
const stopAll = () => { for (const c of chains) c.kill(); preview?.kill(); };
process.on("exit", stopAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));
// vite itself, not through npx: killing npx leaves the server it starts running
const preview = spawn(new URL("../node_modules/.bin/vite", import.meta.url).pathname, ["preview", "--port", String(PAGE_PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
for (let i = 0; ; i++) { // until the page is served
  try { if ((await fetch(`http://127.0.0.1:${PAGE_PORT}/`)).ok) break; } catch {}
  if (i > 60) throw new Error("vite preview did not start");
  await sleep(500);
}
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

/** A settings file as 1.3.0 saved it: no desk rate or allowance, its own fee fields, and V11's path B. */
function v1File() {
  const country = (code, name, short, flowId, extra = {}) => ({ code, name, short, flowId, minTerm: 3, maxTerm: 100, listingDays: 60,
    postSaleDays: 0, baseFee: 0, attestationFee: 0, judgmentFee: 0, holders: 2, orgsPerHolder: 1, verifiersPerOrg: 2, weight: 25, ...extra });
  const scenario = {
    id: "fifteen", name: "Fifteen years of arrivals (saved by 1.3.0)", summary: "",
    contracts: { yearDays: 365, maxVerificationDelayDays: 30, acceptanceDays: 30, watchdogDays: 14, backstopDays: 14, minAuctionDays: 3,
      reviewDays: 30, responseDays: 7, panelDays: 7, redrawDays: 7, haltAfter: 3, baseFee: 50, verifierPermille: 70, taxPermille: 30,
      foundationPermille: 10, editionScale: 100 },
    countries: [country(144, "Sri Lanka", "LK", 1), country(392, "Japan", "JP", 2), country(76, "Brazil", "BR", 3, { minTerm: 16, postSaleDays: 30 })],
    flows: [
      { id: 1, name: "Path A under a power", steps: [1, 2, 4, 6, 7, 8] },
      { id: 2, name: "Path A", steps: [4, 6, 7, 8] },
      { id: 3, name: "Path B: escrow until recorded", steps: [4, 6, 7, 8, 5, 6] },
    ],
    behaviour: { arrivalsPerYear: 8 },
  };
  const dir = mkdtempSync(join(tmpdir(), "ecofutures-ui-"));
  const file = join(dir, "settings-1.3.0.json");
  writeFileSync(file, JSON.stringify({ scenario, seed: 7 }));
  return file;
}

async function attempt(label, prepare, port, phone = false) {
  // as the desktop app starts it: without --prune-history anvil keeps every state on disk (gigabytes a run)
  const node = spawn("anvil", ["--auto-impersonate", "--timestamp", "1767225600", "--port", String(port), "--gas-limit", "100000000", "--prune-history", "64", "--silent"], { stdio: "ignore" });
  chains.add(node);
  await sleep(1000);
  const ctx = await browser.createBrowserContext(); // its own storage, as a first launch
  const page = await ctx.newPage();
  // the Android app's WebView: a phone's width, touch, and its user agent
  if (phone) await page.emulate({ viewport: { width: 412, height: 915, isMobile: true, hasTouch: true },
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
  const consoleErrors = [];
  // an Error logged by the app shows as "JSHandle@error": read its message and the first lines of its stack
  page.on("console", async (m) => {
    if (m.type() !== "error") return;
    const parts = await Promise.all(m.args().map((h) => h.evaluate((x) => (x instanceof Error ? `${x.message} @ ${(x.stack ?? "").split("\n").slice(1, 3).join(" ")}` : String(x))).catch(() => "?")));
    consoleErrors.push(`${parts.join(" ") || m.text()} (${m.location()?.url ?? "?"})`);
  });
  const t0 = Date.now();
  let result;
  try {
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/?rpc=${encodeURIComponent(`http://127.0.0.1:${port}`)}`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#start");
    await prepare(page);
    await page.click("#toProduction");
    const errs = await page.$$eval(".errs li", (li) => li.map((x) => x.textContent));
    if (errs.length) throw new Error(`the configuration is refused: ${errs.join("; ")}`);
    await page.click("#start");
    await page.waitForFunction(() => document.getElementById("overlay")?.hidden === true || /failed/i.test(document.getElementById("overlayStatus")?.textContent ?? ""), { timeout: 180_000 });
    const status = await page.$eval("#overlayStatus", (x) => x.textContent ?? "");
    const ready = await page.$eval("#overlay", (x) => x.hidden);
    if (!ready) result = { ok: false, note: status };
    else {
      // then play it: the clock moves, the actors act, nothing reverts unexpectedly; then a year forward by travel
      const text = (id) => page.$eval(`#${id}`, (x) => x.textContent ?? "");
      const d0 = await text("clockDate");
      await page.$$eval("#speeds button", (b) => b[b.length - 1].click()); // the fastest
      await page.click("#play");
      await sleep(20_000);
      await page.click("#play"); // pause
      let d1 = await text("clockDate");
      for (let still = 0; still < 3; ) { await sleep(1_000); const d = await text("clockDate"); still = d === d1 ? still + 1 : 0; d1 = d; }
      await page.waitForFunction(() => !document.querySelector("#tFwdY")?.disabled, { timeout: 60_000 });
      await page.click("#tFwdY");
      if (!/programme is over/i.test(await text("clockSub"))) try {
        await page.waitForFunction((d) => Date.parse(document.getElementById("clockDate")?.textContent ?? "") - Date.parse(d) > 300 * 86400_000, { timeout: 600_000 }, d1);
        await page.waitForFunction(() => !document.querySelector("#tFwdY")?.disabled, { timeout: 600_000 }); // the travel is done
      } catch {}
      for (let still = 0, d = ""; still < 3; ) { await sleep(1_000); const x = await text("clockDate"); still = x === d ? still + 1 : 0; d = x; }
      const d2 = await text("clockDate"), acts = await text("sActions"), anoms = await text("sAnomalies");
      const day = (d) => /\d{1,2} \w+ \d{4}/.exec(d)?.[0] ?? d;
      const year = (d) => Number(/\b(\d{4})\b/.exec(d)?.[1] ?? 0);
      // a run whose last term has ended stops its clock there, and says so
      const over = /programme is over/i.test(await text("clockSub"));
      const played = Date.parse(d1) > Date.parse(d0), travelled = over || Date.parse(d2) - Date.parse(d1) > 360 * 86400_000;
      const quiet = /^0 /.test(anoms.trim());
      // an active covenant's drawer shows its market (R, 14 Oct): the pool, the listing and the offers
      let drawer = "no active covenant";
      if (await page.$(".tile.s-active")) {
        await page.click(".tile.s-active");
        drawer = await page.waitForSelector("#dBody .market", { timeout: 15_000 }).then(() => "ok", () => "BROKEN (no Market section)");
        await page.keyboard.press("Escape");
        await page.evaluate(() => { const s = document.getElementById("scrim"); if (s && !s.hidden) s.click(); });
      }
      // the Contracts tab: every contract drawn, and one's details open (V12's new contracts once broke it)
      await page.click('[data-view="explorer"]');
      await page.waitForSelector(".node", { timeout: 15_000 }).catch(() => {});
      const nodes = await page.$$eval(".node", (x) => x.length);
      if (nodes) { await page.click('.node[data-key="market"]').catch(() => {}); await sleep(800); }
      const shown = await page.$eval(".ex-head .eyebrow", (e) => e.textContent ?? "").catch(() => "");
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      const covered = await page.evaluate(() => { const s = document.querySelector(".ex-side"); return !!s && getComputedStyle(s).position === "sticky" && window.innerWidth <= 1000; });
      const contracts = nodes === 15 && /Market/i.test(shown) && !wide && !covered;
      await page.click('[data-view="sim"]');
      result = { ok: played && travelled && quiet && contracts && !/BROKEN/.test(drawer), note: `played ${day(d0)} → ${day(d1)}, +1 yr → ${day(d2)}${over ? " (the programme is over)" : ""}; ${acts} transactions, ${anoms}; drawer ${drawer}; Contracts tab ${contracts ? "ok" : `BROKEN (${nodes} contracts drawn, showing "${shown}")`}` };
      void year;
    }
  } catch (e) {
    result = { ok: false, note: String(e.message ?? e) };
  }
  if (errors.length && result.ok) result = { ok: false, note: `page error: ${errors[0]}` };
  // an Error the app itself logged (a caught failure in its own code, as the feed's once was) fails the run; a resource
  // that did not load (a dropped connection to the local chain under load) is only noted
  const appErrors = consoleErrors.filter((x) => !/^Failed to load resource/.test(x));
  if (appErrors.length && result.ok) result.ok = false;
  if (consoleErrors.length) result.note += ` [${consoleErrors.length} console errors, first: ${consoleErrors[0].slice(0, 400)}]`;
  console.log(`${label.padEnd(34)} ${result.ok ? "ok  " : "FAIL"}  ${Math.round((Date.now() - t0) / 1000)}s  ${result.note}`);
  await ctx.close().catch(() => {});
  node.kill();
  chains.delete(node);
  return result.ok;
}

// the scenarios, as the config defines them (every one but "custom", which is the others edited)
const ids = [...readFileSync(new URL("../src/config.ts", import.meta.url), "utf8").matchAll(/make\("([a-z-]+)"/g)].map((m) => m[1]).filter((x) => x !== "custom");
const wanted = process.argv.slice(2);
let port = 8870, failed = 0;
for (const id of ids.filter((x) => !wanted.length || wanted.includes(x))) {
  if (!(await attempt(id, (p) => p.click(`[data-scenario="${id}"]`), ++port))) failed++;
}
if (!wanted.length || wanted.includes("v1file")) {
  const file = v1File();
  const load = async (p) => {
    const input = await p.$("#importCfg");
    await input.uploadFile(file);
    await p.waitForFunction(() => /1\.3\.0/.test(document.querySelector(".card-s.on, h1, .panel-c")?.textContent ?? "") || true);
    await sleep(500);
  };
  if (!(await attempt("a settings file saved by 1.3.0", load, ++port))) failed++;
}
if (!wanted.length || wanted.includes("phone")) {
  // on a phone: the run, and the Contracts tab, readable at 412 px with nothing wider than the screen
  if (!(await attempt("fifteen, on a phone (412 px)", (p) => p.click('[data-scenario="fifteen"]'), ++port, true))) failed++;
}
await browser.close();
preview.kill();
console.log(failed ? `${failed} failed` : "every setup deployed");
process.exit(failed ? 1 : 0);
