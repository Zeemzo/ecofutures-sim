// Checks real-time speed and the Next action button.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(process.argv[2]);
await new Promise((r) => setTimeout(r, 6000));
const clock = () => page.$eval("#clockDate", (e) => e.textContent);
console.log("after setup, real time:", await clock());
await new Promise((r) => setTimeout(r, 5000));
console.log("five seconds later:  ", await clock());
await page.click("#play");
for (let i = 0; i < 4; i++) {
  await page.click("#skip");
  await new Promise((r) => setTimeout(r, 1200));
  console.log("next action ->", await clock(), "|", await page.$eval("#toast", (t) => t.textContent));
}
await browser.close();
