// Photographs a page of the app: node scripts/shot.mjs <url> <file> [seconds] [tab]
import puppeteer from "puppeteer-core";
const [url, file, secs = "4", tab] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"], defaultViewport: { width: 1440, height: 1500 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text().slice(0, 200)); });
await page.goto(url);
await new Promise((r) => setTimeout(r, Number(secs) * 1000));
if (tab) { await page.click(`[data-tab="${tab}"]`); await new Promise((r) => setTimeout(r, 500)); }
await page.screenshot({ path: file });
await browser.close();
