// Drives the setup screen: picks a scenario, adds a country by ISO code, deploys, plays, and reports.
//   node scripts/configure.mjs <url> <scenario> <isoCode> <seconds> [screenshot]
import puppeteer from "puppeteer-core";
const [url, scenario, code, secs = "20", shot] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"], defaultViewport: { width: 1440, height: 1500 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
await page.waitForSelector(`[data-scenario="${scenario}"]`);
await page.click(`[data-scenario="${scenario}"]`);
await page.click('[data-tab="countries"]');
await page.type("#newCode", code);
await page.click("#addCountry");
await page.click("#start");
await page.waitForFunction(() => document.getElementById("overlay").hidden, { timeout: 120000 });
console.log("set up:", await page.$eval("#toast", (t) => t.textContent));
await page.evaluate(() => { document.querySelectorAll("#speeds button")[5].click(); document.getElementById("play").click(); });
await new Promise((r) => setTimeout(r, Number(secs) * 1000));
const s = await page.evaluate(() => {
  const sim = window.sim;
  const byCountry = {};
  for (const r of sim.census.rows) byCountry[r.country] = (byCountry[r.country] ?? 0) + 1;
  return { date: document.getElementById("clockDate").textContent, lanes: [...document.querySelectorAll(".lane-head b")].map((b) => b.textContent),
    byCountry, anomalies: sim.engine.anomalies.length, anomalyKinds: [...new Set(sim.engine.anomalies.map((a) => `${a.label}: ${a.error}`))].slice(0, 6),
    inv: sim.invFails.join(","), checks: sim.invChecks, scale: document.getElementById("sScale").textContent };
});
console.log(JSON.stringify(s, null, 1));
if (shot) await page.screenshot({ path: shot });
await browser.close();
