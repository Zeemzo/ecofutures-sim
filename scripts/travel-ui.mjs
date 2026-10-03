// Checks travel in time in the app: runs to a date, goes back a year, travels forward to the same date again, and
// compares what the page shows.
//   node scripts/travel-ui.mjs "http://localhost:5191/?rpc=http://127.0.0.1:8612&auto=1&scenario=fifteen&speed=5" 2029-06-01
import puppeteer from "puppeteer-core";

const url = process.argv[2];
const until = Date.parse(`${process.argv[3] ?? "2029-06-01"}T00:00:00Z`) / 1000;
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
  defaultViewport: { width: 1440, height: 1200 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text().slice(0, 300)); });
await page.goto(url);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const view = () => page.evaluate(() => {
  const s = window.sim;
  return {
    clock: s.clock, date: document.getElementById("clockDate").textContent, sub: document.getElementById("clockSub").textContent,
    actions: s.engine.actions, requests: s.engine.requests.length, done: s.engine.done.size, block: String(s.block),
    money: s.ledger.money.map(String).join(","), kpis: document.getElementById("kpis").textContent + document.getElementById("ticker").textContent,
    feed: s.entries.length, samples: s.samples.length, inv: document.getElementById("sInvariants").textContent.split("·")[0].trim(), // the checks are counted on a timer, so only what held is compared
    busy: s.busy, travelling: s.travelTarget, checkpoints: undefined,
  };
});
// run to the date, then pause
for (;;) { await wait(500); const v = await view().catch(() => null); if (v && v.clock >= until) break; }
await page.click("#play");
while ((await view()).busy) await wait(100);
// a step may have carried the clock past the date: travel to exactly the date
await page.evaluate((d) => { document.getElementById("tDate").value = d; }, new Date(until * 1000).toISOString().slice(0, 10));
await page.click("#tGo");
for (;;) { await wait(300); const v = await view(); if (!v.travelling && !v.busy) break; }
const a = await view();
console.log("at the date      ", a.date, `actions ${a.actions}, requests ${a.requests}, block ${a.block}, feed ${a.feed}`);
await page.click("#tBackY");
for (;;) { await wait(300); const v = await view(); if (!v.travelling && !v.busy) break; }
const b = await view();
console.log("back a year      ", b.date, `actions ${b.actions}, requests ${b.requests}, block ${b.block}, feed ${b.feed}`);
await page.evaluate((d) => { document.getElementById("tDate").value = d; }, new Date(until * 1000).toISOString().slice(0, 10));
await page.click("#tGo");
for (;;) { await wait(300); const v = await view(); if (!v.travelling && !v.busy) break; }
const c = await view();
console.log("forward again    ", c.date, `actions ${c.actions}, requests ${c.requests}, block ${c.block}, feed ${c.feed}`);
const same = ["clock", "actions", "requests", "done", "money", "kpis", "inv"].filter((k) => a[k] !== c[k]);
console.log(same.length ? `DIFFERS in ${same.join(", ")}` : "THE SAME: back a year and forward again arrives where it was");
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await browser.close();
process.exit(same.length ? 1 : 0);
