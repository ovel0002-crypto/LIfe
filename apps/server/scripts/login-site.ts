/**
 * Save a login for a server browser collector. Run this on YOUR computer (Windows/Mac/Linux):
 *
 *   LIFE_SERVER_URL=https://life.example.com LIFE_API_TOKEN=... pnpm --filter @life/server login-site humanforce
 *
 * It opens your installed Google Chrome (or Playwright's Chromium) at the collector's page.
 * Log in as you normally would — password, SSO, MFA all happen in that window and never pass
 * through Life. Then press Enter here. Only the resulting session cookies are uploaded
 * (encrypted at rest on the server).
 */
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright-core";

const id = process.argv[2];
const server = (process.env.LIFE_SERVER_URL ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.env.LIFE_API_TOKEN;
if (!id) {
  console.error("Usage: pnpm --filter @life/server login-site <collector-id>");
  process.exit(1);
}
const headers: Record<string, string> = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };

const list = (await (await fetch(`${server}/api/collectors`, { headers })).json()) as { id: string; name: string; startUrl: string }[];
const c = list.find((x) => x.id === id);
if (!c) {
  console.error(`No collector "${id}". Known: ${list.map((x) => x.id).join(", ") || "(none — add one in Settings first)"}`);
  process.exit(1);
}

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: false });
} catch {
  browser = await chromium.launch({ headless: false }); // needs `npx playwright-core install chromium`
}
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
await page.goto(c.startUrl);
console.log(`\nA browser window opened at ${c.name}.\n1. Log in as normal (MFA is fine).\n2. Get to the page with your roster/shifts.\n3. Come back here and press Enter.\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Press Enter when you can see your roster… ");
rl.close();
const state = await ctx.storageState();
const res = await fetch(`${server}/api/collectors/${id}/session`, { method: "POST", headers, body: JSON.stringify({ storageState: state, startUrl: page.url() }) });
await browser.close();
if (!res.ok) {
  console.error(`Upload failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Saved. Life will read ${c.name} on its weekly schedule. Test it now in Settings → Auto-pulls → Run now.`);
