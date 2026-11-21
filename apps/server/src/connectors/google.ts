import { google, type calendar_v3 } from "googleapis";
import { newId, type Block, type CalEvent } from "@life/core";
import { config } from "../config";
import type { Store } from "../store";

/**
 * Google Calendar (two-way) and Gmail (read-only) for up to two accounts
 * ("personal" and "uni"; Monash Google accounts sign in through Okta in the same OAuth flow).
 *
 * - Your real events are read into Life (lock: soft by default — you can lock them).
 * - Planned work blocks are written to a separate "Life – Plan" calendar so your main calendar stays clean.
 * - Events created in Life (social plans, shifts) are written to your main calendar, tagged so we know they're ours.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
];
const PLAN_CAL_NAME = "Life – Plan";

export type Account = "personal" | "uni";

function oauth() {
  if (!config.google.clientId || !config.google.clientSecret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

export function authUrl(account: Account): string {
  return oauth().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state: account });
}

export async function handleCallback(store: Store, code: string, account: Account) {
  const client = oauth();
  const { tokens } = await client.getToken(code);
  await store.setKv(`google:${account}:tokens`, tokens);
}

export async function clientFor(store: Store, account: Account) {
  const tokens = await store.getKv<Record<string, unknown>>(`google:${account}:tokens`);
  if (!tokens) return undefined;
  const client = oauth();
  client.setCredentials(tokens);
  client.on("tokens", (t) => void store.setKv(`google:${account}:tokens`, { ...tokens, ...t }));
  return client;
}

export async function connectedAccounts(store: Store): Promise<Account[]> {
  const out: Account[] = [];
  for (const a of ["personal", "uni"] as Account[]) if (await store.getKv(`google:${a}:tokens`)) out.push(a);
  return out;
}

const tagOf = (e: calendar_v3.Schema$Event) => e.extendedProperties?.private ?? {};

/** Pull events from the primary calendar into Life. */
export async function pullCalendar(store: Store, account: Account, days = 30) {
  const auth = await clientFor(store, account);
  if (!auth) return { skipped: true };
  const cal = google.calendar({ version: "v3", auth });
  const now = new Date();
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin: new Date(now.getTime() - 86_400_000).toISOString(),
    timeMax: new Date(now.getTime() + days * 86_400_000).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 500,
  });
  const existing = await store.list("event");
  const batchId = newId("gcal_");
  let created = 0;
  let updated = 0;
  const seen = new Set<string>();
  for (const g of res.data.items ?? []) {
    if (!g.id || g.status === "cancelled") continue;
    const tag = tagOf(g);
    if (tag.lifeBlock) continue; // our own plan blocks
    const start = g.start?.dateTime ?? (g.start?.date ? `${g.start.date}T00:00:00Z` : undefined);
    const end = g.end?.dateTime ?? (g.end?.date ? `${g.end.date}T00:00:00Z` : undefined);
    if (!start || !end) continue;
    const allDay = !g.start?.dateTime;
    const externalId = `gcal:${account}:${g.id}`;
    seen.add(externalId);
    const match = existing.find((e) => e.externalId === externalId || (tag.lifeId && e.id === tag.lifeId));
    if (match) {
      if (match.start !== start || match.end !== end || match.title !== (g.summary ?? match.title)) {
        await store.update("event", match.id, { start, end, title: g.summary ?? match.title, externalId }, { actor: "connector", reason: "Changed in Google Calendar", batchId });
        updated++;
      }
      continue;
    }
    if (allDay) continue; // all-day items (birthdays, holidays) don't block time
    const ev: CalEvent = {
      id: newId("evt_"),
      title: g.summary ?? "(busy)",
      start,
      end,
      lock: "soft",
      certainty: g.status === "tentative" ? "maybe" : "confirmed",
      source: "gcal",
      externalId,
      location: g.location ?? undefined,
    };
    await store.create("event", ev, { actor: "connector", reason: "From Google Calendar", batchId });
    created++;
  }
  // Events deleted in Google → remove (only ones that came from Google).
  for (const e of existing) {
    if (e.externalId?.startsWith(`gcal:${account}:`) && !seen.has(e.externalId) && Date.parse(e.start) > now.getTime()) {
      await store.remove("event", e.id, { actor: "connector", reason: "Deleted in Google Calendar", batchId });
    }
  }
  return { created, updated };
}

async function planCalendarId(cal: calendar_v3.Calendar, store: Store, account: Account) {
  const key = `google:${account}:planCal`;
  const cached = await store.getKv<string>(key);
  if (cached) return cached;
  const list = await cal.calendarList.list();
  let id = list.data.items?.find((c) => c.summary === PLAN_CAL_NAME)?.id ?? undefined;
  if (!id) {
    const created = await cal.calendars.insert({ requestBody: { summary: PLAN_CAL_NAME, description: "Work blocks planned by Life. Safe to hide." } });
    id = created.data.id!;
  }
  await store.setKv(key, id);
  return id;
}

/** Mirror the plan's work blocks to the "Life – Plan" calendar (diffed, so it's cheap). */
export async function pushPlan(store: Store, account: Account, blocks: Block[], titleOf: (taskId: string) => string) {
  const auth = await clientFor(store, account);
  if (!auth) return { skipped: true };
  const cal = google.calendar({ version: "v3", auth });
  const calendarId = await planCalendarId(cal, store, account);
  const now = Date.now();
  const res = await cal.events.list({ calendarId, timeMin: new Date(now - 3600_000).toISOString(), timeMax: new Date(now + 21 * 86_400_000).toISOString(), singleEvents: true, maxResults: 1000 });
  const remote = new Map((res.data.items ?? []).map((e) => [tagOf(e).lifeBlock, e]));
  const wanted = new Map(blocks.filter((b) => Date.parse(b.end) > now).map((b) => [`${b.taskId}|${b.start}|${b.end}`, b]));
  let added = 0;
  let removed = 0;
  for (const [key, e] of remote) {
    if (!key || !wanted.has(key)) {
      await cal.events.delete({ calendarId, eventId: e.id! });
      removed++;
    }
  }
  for (const [key, b] of wanted) {
    if (remote.has(key)) continue;
    await cal.events.insert({
      calendarId,
      requestBody: {
        summary: titleOf(b.taskId),
        start: { dateTime: b.start },
        end: { dateTime: b.end },
        transparency: "transparent",
        extendedProperties: { private: { lifeBlock: key, lifeTask: b.taskId } },
        reminders: { useDefault: false },
      },
    });
    added++;
  }
  return { added, removed };
}

/** Write events created in Life (e.g. from chat or screenshots) to your main calendar. */
export async function pushEvents(store: Store, account: Account) {
  const auth = await clientFor(store, account);
  if (!auth) return { skipped: true };
  const cal = google.calendar({ version: "v3", auth });
  const events = await store.list("event");
  let pushed = 0;
  for (const e of events) {
    if (e.externalId || e.source === "timetable" || e.source === "gcal" || e.certainty === "unknown-time") continue;
    if (Date.parse(e.end) < Date.now()) continue;
    const created = await cal.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: e.certainty === "maybe" ? `${e.title} (?)` : e.title,
        start: { dateTime: e.start },
        end: { dateTime: e.end },
        location: e.location,
        status: e.certainty === "maybe" ? "tentative" : "confirmed",
        extendedProperties: { private: { lifeId: e.id } },
      },
    });
    await store.update("event", e.id, { externalId: `gcal:${account}:${created.data.id}` }, { actor: "system", reason: "Synced to Google Calendar" });
    pushed++;
  }
  return { pushed };
}

/** Recent Gmail messages since the last check (metadata + snippet; the triage agent decides what matters). */
export async function pullGmail(store: Store, account: Account, max = 30) {
  const auth = await clientFor(store, account);
  if (!auth) return [];
  const gmail = google.gmail({ version: "v1", auth });
  const cursorKey = `gmail:${account}:after`;
  const after = (await store.getKv<number>(cursorKey)) ?? Math.floor(Date.now() / 1000) - 2 * 86_400;
  const list = await gmail.users.messages.list({ userId: "me", q: `after:${after} -category:promotions -category:social`, maxResults: max });
  const out: { id: string; from: string; subject: string; snippet: string; date: string; body: string }[] = [];
  for (const m of list.data.messages ?? []) {
    const full = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "full" });
    const headers = full.data.payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value ?? "";
    out.push({ id: m.id!, from: h("from"), subject: h("subject"), date: h("date"), snippet: full.data.snippet ?? "", body: plainBody(full.data.payload) });
  }
  await store.setKv(cursorKey, Math.floor(Date.now() / 1000));
  return out;
}

function plainBody(p?: { mimeType?: string | null; body?: { data?: string | null } | null; parts?: unknown[] | null } | null): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8").slice(0, 8000);
  for (const part of (p.parts ?? []) as Parameters<typeof plainBody>[0][]) {
    const t = plainBody(part);
    if (t) return t;
  }
  return "";
}
