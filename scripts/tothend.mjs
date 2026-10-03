// Runs the app until the programme is over (or a time limit) and reports how it ended.
//   node scripts/tothend.mjs "http://localhost:5173/?auto=1&speed=5&fill=1&rate=40" 600
import puppeteer from "puppeteer-core";
const [url, limit = "600", shot] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"], defaultViewport: { width: 1440, height: 1500 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 15000));
  const s = await page.evaluate(() => ({ ended: window.sim.ended, full: window.sim.engine?.landFull, date: document.getElementById("clockDate").textContent,
    land: document.getElementById("sLandText").textContent, reqs: window.sim.engine?.requests.length, done: window.sim.engine?.done.size,
    anomalies: window.sim.engine?.anomalies.length, inv: window.sim.invFails.join(","), checks: window.sim.invChecks }));
  console.log(Math.round((Date.now() - t0) / 1000) + "s", JSON.stringify(s));
  if (s.ended || Date.now() - t0 > Number(limit) * 1000) break;
}
console.log(await page.evaluate(() => document.getElementById("endBanner")?.innerText ?? "no banner"));
if (shot) await page.screenshot({ path: shot });
await browser.close();
