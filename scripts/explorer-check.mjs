// Sets up a run, opens the Contracts view, makes a live read and a write that should be refused.
import puppeteer from "puppeteer-core";
const [url, shotGraph, shotFn] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--disable-background-timer-throttling"], defaultViewport: { width: 1440, height: 1500 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
await page.waitForSelector('[data-scenario="one"]');
await page.click('[data-scenario="one"]');
await page.click("#start");
await page.waitForFunction(() => document.getElementById("overlay").hidden, { timeout: 120000 });
await page.click('[data-view="explorer"]');
await page.waitForSelector(".ex-graph svg");
if (shotGraph) await page.screenshot({ path: shotGraph });
// a read: Tree.editionInfo
await page.click('.node[data-key="tree"]');
await page.click('[data-extab="reads"]');
const read = await page.$$eval("details.fn", (ds) => ds.findIndex((d) => d.dataset.fn === "editionInfo()"));
await page.evaluate((i) => { const d = document.querySelectorAll("details.fn")[i]; d.open = true; d.querySelector("form button").click(); }, read);
await new Promise((r) => setTimeout(r, 1500));
console.log("read Tree.editionInfo ->", await page.evaluate((i) => document.querySelectorAll("details.fn")[i].querySelector(".out").textContent.slice(0, 160), read));
// a write that must be refused: Bank.releaseHeldHolderFees for a Trust Admin with no successor
await page.click('.node[data-key="bank"]'); await page.click('[data-extab="writes"]');
const w = await page.$$eval("details.fn", (ds) => ds.findIndex((d) => d.dataset.fn === "releaseHeldHolderFees(address)"));
await page.evaluate((i) => { const d = document.querySelectorAll("details.fn")[i]; d.open = true; d.querySelector("input[data-arg='0']").value = "LK-TA1"; d.querySelector("form button").click(); }, w);
await new Promise((r) => setTimeout(r, 2500));
console.log("write Bank.releaseHeldHolderFees(LK-TA1) ->", await page.evaluate((i) => document.querySelectorAll("details.fn")[i].querySelector(".out").textContent, w));
await page.evaluate((i) => document.querySelectorAll("details.fn")[i].scrollIntoView({ block: "start" }), w);
if (shotFn) await page.screenshot({ path: shotFn });
await browser.close();
