// Runs the app, pauses on a covenant with an open review window, raises a challenge through the drawer
// planned to find the land in breach, then plays on and reports what the chain did with it.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5173/?auto=1&speed=5";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"], defaultViewport: { width: 1440, height: 1900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url);
await new Promise((r) => setTimeout(r, 8000));
// slow to a day a second and wait for a covenant whose window is open and untouched
await page.evaluate(() => { document.querySelectorAll("#speeds button")[2].click(); });
let rid = 0;
for (let i = 0; i < 60 && !rid; i++) {
  await new Promise((r) => setTimeout(r, 500));
  rid = await page.evaluate(() => {
    const s = window.sim;
    const r = s.census?.rows.find((x) => x.stage === "active" && x.windowOpen && x.windowAction === 0 && !x.challenged);
    return r ? r.rid : 0;
  });
}
await page.click("#play"); // pause
console.log("covenant with an open window:", rid);
await new Promise((r) => setTimeout(r, 800));
await page.click(`.tile[data-rid="${rid}"]`);
await new Promise((r) => setTimeout(r, 1500));
await page.select("#dOutcome", "3");
await page.click("#dChallenge");
await new Promise((r) => setTimeout(r, 1500));
console.log("toast:", await page.$eval("#toast", (t) => t.textContent));
await page.click("#dClose");
await page.click("#play"); // play at a day a second
await new Promise((r) => setTimeout(r, 30000));
const story = await page.evaluate((rid) => window.sim.entries.filter((e) => e.rid === rid).slice(-14).map((e) => e.text), rid);
console.log(story.join("\n"));
console.log("anomalies:", await page.evaluate(() => window.sim.engine.anomalies.length));
await browser.close();
