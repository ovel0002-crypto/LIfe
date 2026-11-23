import { DateTime } from "luxon";
import { newId, type Task } from "@life/core";
import { config } from "../config";
import type { Notifier } from "../notify";
import type { Store } from "../store";
import type { TriageAgent } from "../agent/triage";
import { syncFeed, type Feed } from "../connectors/ical";
import { decrypt, encrypt } from "./secret";

/**
 * Server browser collectors: open a logged-in page on a schedule (e.g. your Humanforce roster),
 * read it, and hand text + screenshot to triage. Read-only by construction — the code only
 * navigates, waits and reads; it never clicks or types on the page.
 *
 * Login is captured once on your own computer with `pnpm --filter @life/server login-site <id>`
 * (a real browser window, so passwords and MFA stay with you) and uploaded as an encrypted session.
 */
export interface Collector {
  id: string;
  name: string;
  /** The page to read, e.g. https://yourworkplace.humanforce.com/... roster page */
  startUrl: string;
  kind: "roster" | "messages" | "page";
  /** Local time: ISO weekday 1-7 and hour. Runs once per week at/after this time. */
  schedule: { weekday: number; hour: number };
  /** Regex: if the final URL matches, the session has expired. */
  loggedOutPattern?: string;
  /** Optional CSS selector to wait for before reading (e.g. the roster table). */
  waitFor?: string;
  hint?: string;
  /** Try to download a calendar file from the page (e.g. Humanforce "Roster download") and import it directly. */
  download?: boolean;
  lastRun?: string;
  lastResult?: string;
}

export interface RunResult {
  ok: boolean;
  status: "imported" | "captured" | "login-needed" | "bad-password" | "no-session" | "error";
  summary?: string;
  proposed?: number;
}

const DEFAULT_LOGGED_OUT = "(login|signin|sign-in|logon|sso|oauth|okta|auth0|authorize)";

/** A page asks for a login if its URL looks like a login flow or it shows a password field. */
export function looksLoggedOut(finalUrl: string, hasPasswordField: boolean, pattern?: string): boolean {
  if (hasPasswordField) return true;
  return new RegExp(pattern ?? DEFAULT_LOGGED_OUT, "i").test(new URL(finalUrl).pathname + new URL(finalUrl).search);
}

export class Collectors {
  constructor(
    private store: Store,
    private triage: TriageAgent,
    private notifier: Notifier,
  ) {}

  async list(): Promise<Collector[]> {
    return (await this.store.getKv<Collector[]>("collectors")) ?? [];
  }

  async save(c: Omit<Collector, "id"> & { id?: string }): Promise<Collector> {
    const all = await this.list();
    const id = c.id ?? c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const next = { ...all.find((x) => x.id === id), ...c, id } as Collector;
    await this.store.setKv("collectors", [...all.filter((x) => x.id !== id), next]);
    return next;
  }

  async remove(id: string) {
    await this.store.setKv("collectors", (await this.list()).filter((x) => x.id !== id));
    await this.store.setKv(`session:${id}`, null);
  }

  /** Store a Playwright storageState (JSON), encrypted. */
  async saveSession(id: string, storageState: unknown, opts: { quiet?: boolean } = {}) {
    await this.store.setKv(`session:${id}`, { blob: encrypt(JSON.stringify(storageState), config.secret), at: new Date().toISOString() });
    await this.resolveLoginTodo(id, opts.quiet);
  }

  /** Store a username/password (encrypted) so the collector can log itself back in. */
  async saveCredentials(id: string, creds: { username: string; password: string }) {
    await this.store.setKv(`cred:${id}`, { blob: encrypt(JSON.stringify(creds), config.secret), at: new Date().toISOString() });
    await this.resolveLoginTodo(id);
  }

  async hasCredentials(id: string): Promise<boolean> {
    return Boolean((await this.store.getKv<{ blob?: string } | null>(`cred:${id}`))?.blob);
  }

  private async credentials(id: string): Promise<{ username: string; password: string } | undefined> {
    const c = await this.store.getKv<{ blob?: string } | null>(`cred:${id}`);
    return c?.blob ? JSON.parse(decrypt(c.blob, config.secret)) : undefined;
  }

  async hasSession(id: string): Promise<boolean> {
    const s = await this.store.getKv<{ blob?: string } | null>(`session:${id}`);
    return Boolean(s?.blob);
  }

  private async session(id: string): Promise<unknown | undefined> {
    const s = await this.store.getKv<{ blob?: string } | null>(`session:${id}`);
    if (!s?.blob) return undefined;
    return JSON.parse(decrypt(s.blob, config.secret));
  }

  /** Runs every collector whose weekly slot has passed since its last run. */
  async runDue(now = DateTime.now()) {
    const tz = (await this.store.prefs()).timezone;
    const local = now.setZone(tz);
    for (const c of await this.list()) {
      const slot = local.set({ weekday: c.schedule.weekday as 1, hour: c.schedule.hour, minute: 0, second: 0, millisecond: 0 });
      const due = slot <= local ? slot : slot.minus({ weeks: 1 });
      if (c.lastRun && DateTime.fromISO(c.lastRun) >= due) continue;
      await this.run(c.id).catch((e) => console.error(`[collector ${c.id}]`, e));
    }
  }

  async run(id: string, opts: { browserFactory?: () => Promise<import("playwright-core").Browser> } = {}): Promise<RunResult> {
    const c = (await this.list()).find((x) => x.id === id);
    if (!c) return { ok: false, status: "error", summary: "No such collector" };
    const state = await this.session(id);
    const creds = await this.credentials(id);
    if (!state && !creds) {
      await this.loginNeeded(c.name, c.startUrl, id, "no-session");
      return this.finish(c, { ok: false, status: "no-session", summary: "No saved login yet" });
    }
    const { chromium } = await import("playwright-core");
    const browser = opts.browserFactory ? await opts.browserFactory() : await chromium.launch({ executablePath: config.chromiumPath, headless: true });
    try {
      const ctx = await browser.newContext({
        ...(state ? { storageState: state as never } : {}),
        viewport: { width: 1280, height: 1600 },
        locale: "en-AU",
        acceptDownloads: true,
      });
      const page = await ctx.newPage();
      const open = async () => {
        await page.goto(c.startUrl, { waitUntil: "networkidle", timeout: 45_000 });
        if (c.waitFor) await page.waitForSelector(c.waitFor, { timeout: 20_000 }).catch(() => undefined);
        await page.waitForTimeout(1000);
      };
      const loggedOut = async () =>
        looksLoggedOut(page.url(), await page.locator('input[type="password"]').count().then((n) => n > 0), c.loggedOutPattern);

      await open();
      if (await loggedOut()) {
        if (!creds) {
          await this.loginNeeded(c.name, c.startUrl, id, "expired");
          return this.finish(c, { ok: false, status: "login-needed", summary: "Saved login expired" });
        }
        await logIn(page, creds);
        await open();
        if (await loggedOut()) {
          await this.loginNeeded(c.name, c.startUrl, id, "bad-password");
          return this.finish(c, { ok: false, status: "bad-password", summary: "Login didn't work — check the username/password" });
        }
      }
      // Keep the (refreshed) session for next time.
      await this.saveSession(id, await ctx.storageState(), { quiet: true });

      if (c.download) {
        const ics = await downloadCalendar(page);
        if (ics) {
          const feed: Feed = { id: c.id, name: c.name, url: `collector:${c.id}`, kind: c.kind === "roster" ? "roster" : "calendar", lock: "hard" };
          const r = await syncFeed(this.store, feed, { text: ics });
          const summary = `Imported roster file: ${r.created} new, ${r.updated} changed${r.proposedRemovals ? `, ${r.proposedRemovals} removed (to review)` : ""}`;
          await this.store.setKv(`pull:${id}`, { at: new Date().toISOString(), proposed: r.proposedRemovals ?? 0, summary });
          return this.finish(c, { ok: true, status: "imported", summary, proposed: r.proposedRemovals });
        }
      }

      const text = (await page.evaluate(() => document.body.innerText)).slice(0, 40_000);
      // Full page, capped in height so the image stays a sensible size for vision.
      const height = Math.min(7000, await page.evaluate(() => document.documentElement.scrollHeight));
      const shot = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true, clip: { x: 0, y: 0, width: 1280, height } }).catch(() => undefined);
      const r = await this.triage.process({
        source: "browser",
        title: `${c.name} (${c.kind})`,
        body: text,
        url: c.startUrl,
        images: shot ? [{ mediaType: "image/jpeg", data: shot.toString("base64") }] : undefined,
        hint:
          c.hint ??
          (c.kind === "roster"
            ? "The user's work roster. Every shift for the user is an event with lock 'hard', certainty 'confirmed', area 'work'. Update shifts that moved; propose removing ones that disappeared only if clearly cancelled."
            : undefined),
      });
      await this.store.setKv(`pull:${id}`, { at: new Date().toISOString(), proposed: r.proposed, summary: r.summary });
      return this.finish(c, { ok: true, status: "captured", summary: r.summary, proposed: r.proposed });
    } catch (e) {
      return this.finish(c, { ok: false, status: "error", summary: (e as Error).message.slice(0, 300) });
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async finish(c: Collector, r: RunResult) {
    await this.save({ ...c, lastRun: new Date().toISOString(), lastResult: `${r.status}${r.summary ? `: ${r.summary}` : ""}` });
    return r;
  }

  /** Creates (once) a human to-do to log back in, and nudges. */
  async loginNeeded(name: string, url?: string, id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), why: "expired" | "no-session" | "bad-password" = "expired") {
    const marker = `[login:${id}]`;
    const open = (await this.store.list("task")).find((t) => t.notes?.includes(marker) && t.status !== "done" && t.status !== "dropped");
    if (open) return open;
    const local = id === "instagram" || !(await this.list()).some((c) => c.id === id);
    const task: Task = {
      id: newId("tsk_"),
      title: why === "no-session" ? `Connect ${name} so Life can read it` : why === "bad-password" ? `Check your ${name} password in Life` : `Log back into ${name}`,
      area: "admin",
      status: "todo",
      estimateMinutes: 5,
      importance: 4,
      source: "system",
      sourceUrl: url,
      doneWhen: "Life's next pull works",
      notes: why === "bad-password"
        ? `Life couldn't log into ${name} with the saved username/password. If you changed it, update it in Life → Settings → Auto-pulls.\n${marker}`
        : local
        ? `Open ${name} in your normal Chrome on your PC and log in. The weekly Claude Desktop run uses that browser.\n${marker}`
        : `On your computer, in the Life repo, run:\n  pnpm --filter @life/server login-site ${id}\nA browser opens — log in as normal (MFA is fine), then press Enter in the terminal.\n${marker}`,
      createdAt: new Date().toISOString(),
    };
    await this.store.create("task", task, { actor: "system", reason: `${name} needs a login` });
    await this.notifier.send({ title: `${name} needs you`, body: task.title, url: "/" }).catch(() => undefined);
    return task;
  }

  private async resolveLoginTodo(id: string, _quiet?: boolean) {
    const marker = `[login:${id}]`;
    for (const t of await this.store.list("task")) {
      if (t.notes?.includes(marker) && t.status !== "done") {
        await this.store.update("task", t.id, { status: "done", completedAt: new Date().toISOString() }, { actor: "system", reason: "Login saved" });
      }
    }
  }
}

/** Fill a typical login form (username/email + password) and submit. Only used on the login page. */
export async function logIn(page: import("playwright-core").Page, creds: { username: string; password: string }) {
  const pw = page.locator('input[type="password"]').first();
  const user = page
    .locator('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[name*="login" i], input[type="text"]')
    .first();
  await user.fill(creds.username);
  await pw.fill(creds.password);
  const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")').first();
  await Promise.all([page.waitForLoadState("networkidle").catch(() => undefined), (await submit.count()) ? submit.click() : pw.press("Enter")]);
  await page.waitForTimeout(1500);
}

/**
 * Find a "download roster / export calendar" control and capture the .ics it produces.
 * Clicking it only downloads a file; nothing else on the page is clicked.
 */
export async function downloadCalendar(page: import("playwright-core").Page): Promise<string | undefined> {
  // 1. A direct link to an .ics file.
  const href = await page
    .locator('a[href$=".ics"], a[href*=".ics?"], a[href*="ical" i], a[href*="ics=" i]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  if (href) {
    const res = await page.request.get(new URL(href, page.url()).toString()).catch(() => undefined);
    const text = res && (await res.text());
    if (text?.includes("BEGIN:VCALENDAR")) return text;
  }
  // 2. A button/link that triggers a download.
  const candidates = page.locator("a, button, [role=button]").filter({ hasText: /download|export|\.ics|ical|add to calendar|calendar file/i });
  const n = Math.min(await candidates.count(), 4);
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const dl = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), el.click()]).then(([d]) => d).catch(() => undefined);
    if (!dl) continue;
    const path = await dl.path().catch(() => null);
    if (!path) continue;
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.includes("BEGIN:VCALENDAR")) return text;
  }
  return undefined;
}
