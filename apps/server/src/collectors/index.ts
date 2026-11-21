import { DateTime } from "luxon";
import { newId, type Task } from "@life/core";
import { config } from "../config";
import type { Notifier } from "../notify";
import type { Store } from "../store";
import type { TriageAgent } from "../agent/triage";
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
  lastRun?: string;
  lastResult?: string;
}

export interface RunResult {
  ok: boolean;
  status: "captured" | "login-needed" | "no-session" | "error";
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
  async saveSession(id: string, storageState: unknown) {
    await this.store.setKv(`session:${id}`, { blob: encrypt(JSON.stringify(storageState), config.secret), at: new Date().toISOString() });
    await this.resolveLoginTodo(id);
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
    if (!state) {
      await this.loginNeeded(c.name, c.startUrl, id, "no-session");
      return this.finish(c, { ok: false, status: "no-session", summary: "No saved login yet" });
    }
    const { chromium } = await import("playwright-core");
    const browser = opts.browserFactory ? await opts.browserFactory() : await chromium.launch({ executablePath: config.chromiumPath, headless: true });
    try {
      const ctx = await browser.newContext({ storageState: state as never, viewport: { width: 1280, height: 1600 }, locale: "en-AU" });
      const page = await ctx.newPage();
      await page.goto(c.startUrl, { waitUntil: "networkidle", timeout: 45_000 });
      if (c.waitFor) await page.waitForSelector(c.waitFor, { timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      const hasPassword = await page.locator('input[type="password"]').count().then((n) => n > 0);
      if (looksLoggedOut(page.url(), hasPassword, c.loggedOutPattern)) {
        await this.loginNeeded(c.name, c.startUrl, id, "expired");
        return this.finish(c, { ok: false, status: "login-needed", summary: "Saved login expired" });
      }
      const text = (await page.evaluate(() => document.body.innerText)).slice(0, 40_000);
      // Full page, capped in height so the image stays a sensible size for vision.
      const height = Math.min(7000, await page.evaluate(() => document.documentElement.scrollHeight));
      const shot = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true, clip: { x: 0, y: 0, width: 1280, height } }).catch(() => undefined);
      // Refresh the saved session so it lives longer.
      await this.saveSession(id, await ctx.storageState());
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
  async loginNeeded(name: string, url?: string, id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), why: "expired" | "no-session" = "expired") {
    const marker = `[login:${id}]`;
    const open = (await this.store.list("task")).find((t) => t.notes?.includes(marker) && t.status !== "done" && t.status !== "dropped");
    if (open) return open;
    const local = id === "instagram" || !(await this.list()).some((c) => c.id === id);
    const task: Task = {
      id: newId("tsk_"),
      title: why === "no-session" ? `Connect ${name} so Life can read it` : `Log back into ${name}`,
      area: "admin",
      status: "todo",
      estimateMinutes: 5,
      importance: 4,
      source: "system",
      sourceUrl: url,
      doneWhen: "Life's next pull works",
      notes: local
        ? `Open ${name} in your normal Chrome on your PC and log in. The weekly Claude Desktop run uses that browser.\n${marker}`
        : `On your computer, in the Life repo, run:\n  pnpm --filter @life/server login-site ${id}\nA browser opens — log in as normal (MFA is fine), then press Enter in the terminal.\n${marker}`,
      createdAt: new Date().toISOString(),
    };
    await this.store.create("task", task, { actor: "system", reason: `${name} needs a login` });
    await this.notifier.send({ title: `${name} needs you`, body: task.title, url: "/" }).catch(() => undefined);
    return task;
  }

  private async resolveLoginTodo(id: string) {
    const marker = `[login:${id}]`;
    for (const t of await this.store.list("task")) {
      if (t.notes?.includes(marker) && t.status !== "done") {
        await this.store.update("task", t.id, { status: "done", completedAt: new Date().toISOString() }, { actor: "system", reason: "Login saved" });
      }
    }
  }
}
