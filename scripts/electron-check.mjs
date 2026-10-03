// Connects to the running desktop app (started with --remote-debugging-port=9333), runs a scenario, reports.
//   node scripts/electron-check.mjs [scenario] [seconds] [screenshot]
import puppeteer from "puppeteer-core";

const [scenario = "one", secs = "15", shot] = process.argv.slice(2);
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const pages = await browser.pages();
const page = pages.find((p) => p.url().startsWith("file:")) ?? pages[0];
page.on("pageerror", (e) => console.log("pageerror:", e.message));
console.log("page:", page.url().replace(/^file:\/\/.*\/dist\//, "file://…/dist/"));
await page.waitForSelector(`[data-scenario="${scenario}"]`, { timeout: 30000 });
await page.click(`[data-scenario="${scenario}"]`);
await page.click("#start");
await page.waitForFunction(() => document.getElementById("overlay").hidden, { timeout: 120000 });
console.log("set up:", await page.$eval("#toast", (t) => t.textContent));
await page.evaluate(() => { document.querySelectorAll("#speeds button")[5].click(); document.getElementById("play").click(); });
await new Promise((r) => setTimeout(r, Number(secs) * 1000));
console.log(await page.evaluate(() => JSON.stringify({
  date: document.getElementById("clockDate").textContent, requests: window.sim.engine.requests.length,
  done: window.sim.engine.done.size, ended: window.sim.ended, anomalies: window.sim.engine.anomalies.length, inv: window.sim.invFails.join(","),
})));
if (shot) await page.screenshot({ path: shot });
browser.disconnect();
