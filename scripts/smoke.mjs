// Opens the app in the system Chrome, lets it run, and reports what it shows. Used to check the app end to end.
//   node scripts/smoke.mjs [url] [seconds]
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5173/?auto=1&speed=5";
const seconds = Number(process.argv[3] ?? 30);
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
  defaultViewport: { width: 1440, height: 1900 },
});
const page = await browser.newPage();
page.on("console", (m) => { if (!m.text().includes("[vite]")) console.log("console:", m.type(), m.text().slice(0, 300)); });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
for (let i = 0; i < seconds; i += 5) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await page.evaluate(() => ({
    date: document.getElementById("clockDate")?.textContent,
    sub: document.getElementById("clockSub")?.textContent,
    actions: document.getElementById("sActions")?.textContent,
    inv: document.getElementById("sInvariants")?.textContent,
    anom: document.getElementById("sAnomalies")?.textContent,
    overlay: document.getElementById("overlayStatus")?.textContent,
    feed: document.getElementById("feed")?.children.length,
  }));
  console.log(`${i + 5}s`, JSON.stringify(s));
}
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
if (process.env.DRAWER) {
  // pause, open an active covenant, and photograph its drawer
  await page.click("#play");
  await new Promise((r) => setTimeout(r, 1500));
  await page.click(".tile.s-active");
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: process.env.DRAWER, fullPage: false });
}
await browser.close();
