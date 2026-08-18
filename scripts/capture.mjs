import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.URL ?? "http://localhost:3939";
const OUT = ".impeccable/review";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

// The row's title block is the affordance that opens the detail view.
const ROW = 'main div[class*="rounded-xl"] button:has-text("@")';

async function shot(name, viewport, fn) {
  const ctx = await browser.newContext({
    viewport,
    // The Paper-comparison shot matches the artboard's pixel width exactly so
    // the two can be set side by side without rescaling.
    deviceScaleFactor: name.startsWith("paper-") ? 1 : 2,
  });
  const page = await ctx.newPage();
  // networkidle never settles behind the dev HMR socket.
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });
  // Settle entrance motion so a capture never reads an animating element
  // as a missing one.
  await page.waitForTimeout(2500);
  if (fn) await fn(page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await ctx.close();
  console.log("captured", name);
}

// Captured at the Paper artboard's own width (1440) for a direct comparison.
await shot("paper-inbox", { width: 1440, height: 618 });
await shot("desktop", { width: 1440, height: 900 });
await shot("paper-detail", { width: 1200, height: 1031 }, async (page) => {
  await page.locator(ROW).first().click();
  await page.waitForTimeout(900);
});
await shot("mobile", { width: 390, height: 844 });

await browser.close();
