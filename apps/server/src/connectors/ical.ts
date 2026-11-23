import { DateTime } from "luxon";
import ical, { type VEvent } from "node-ical";
import { newId, type CalEvent, type Lock, type Task } from "@life/core";
import type { Store } from "../store";

export interface Feed {
  id: string;
  name: string;
  url: string;
  /**
   * moodle    → deadlines become tasks with due dates (assignments, quizzes)
   * timetable → classes become events
   * calendar  → any other calendar (sports club, shared calendars...) → events
   * roster    → work shifts (e.g. Humanforce): hard, confirmed, area work, tidy titles
   */
  kind: "moodle" | "timetable" | "calendar" | "roster";
  /** Lock for imported events — chosen by you when adding the feed. */
  lock: Lock;
  lastSync?: string;
  lastError?: string;
}

export async function listFeeds(store: Store): Promise<Feed[]> {
  return (await store.getKv<Feed[]>("feeds")) ?? [];
}

export async function saveFeeds(store: Store, feeds: Feed[]) {
  await store.setKv("feeds", feeds);
}

interface Occurrence {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  url?: string;
  categories?: string[];
}

/**
 * Times without a timezone ("floating", e.g. Humanforce's DTSTART:20261031T163000) are wall-clock
 * times. node-ical reads them in the *server's* timezone, so re-read them in the user's timezone.
 */
function fixFloating(d: Date, floating: boolean, zone?: string): Date {
  if (!floating || !zone) return d;
  return DateTime.fromObject(
    { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() },
    { zone },
  ).toJSDate();
}

/** Parse an iCal document into concrete occurrences within a window (recurring events expanded). */
export function occurrences(text: string, from: Date, to: Date, zone?: string): Occurrence[] {
  const data = ical.sync.parseICS(text);
  const out: Occurrence[] = [];
  for (const v of Object.values(data)) {
    if (!v || v.type !== "VEVENT") continue;
    const e = v as VEvent;
    const summary = typeof e.summary === "string" ? e.summary : String((e.summary as { val?: string })?.val ?? "");
    const floating = Boolean(e.start) && !(e.start as Date & { tz?: string }).tz && !(e.start as Date & { dateOnly?: boolean }).dateOnly;
    const s0 = e.start ? fixFloating(new Date(e.start as Date), floating, zone) : undefined;
    const e0 = e.end ? fixFloating(new Date(e.end as Date), floating, zone) : s0;
    const durMs = s0 && e0 ? e0.getTime() - s0.getTime() : 0;
    const base = {
      summary,
      description: typeof e.description === "string" ? e.description : undefined,
      location: typeof e.location === "string" ? e.location : undefined,
      url: typeof e.url === "string" ? e.url : undefined,
      categories: e.categories as string[] | undefined,
    };
    if (e.rrule) {
      const exdates = new Set(Object.values(e.exdate ?? {}).map((d) => fixFloating(new Date(d as Date), floating, zone).getTime()));
      for (const raw of e.rrule.between(from, to, true)) {
        const d = fixFloating(raw, floating, zone);
        if (exdates.has(d.getTime())) continue;
        out.push({ ...base, uid: `${e.uid}@${d.toISOString()}`, start: d, end: new Date(d.getTime() + durMs) });
      }
    } else if (s0) {
      const end = e0 ?? s0;
      if (end >= from && s0 <= to) out.push({ ...base, uid: String(e.uid), start: s0, end });
    }
  }
  return out;
}

const KEEP_UPPER = new Set(["saw", "f&b", "foh", "boh", "bbq"]);
const titleCase = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (KEEP_UPPER.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");

/** Pull "Key - Value" lines out of a shift description (Humanforce format). */
export function shiftDetails(description = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of description.split(/\n/)) {
    const m = line.match(/^\s*([A-Za-z ]+?)\s+-\s+(.+?)\s*$/);
    if (m) out[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

/** "Shift at LUNA PARK, FOOD & BEVERAGE" + details → "Luna Park · Cafe Cook (Food Cafe) — Linfox Retail" */
export function shiftTitle(o: Pick<Occurrence, "summary" | "description" | "location">): string {
  const d = shiftDetails(o.description);
  const place = titleCase(d.location ?? (o.location ?? o.summary.replace(/^shift at\s+/i, "")).split(",")[0]);
  const role = d.role ? titleCase(d.role.replace(/^f&b[\s-]*/i, "").replace(/-/g, " ")) : "";
  const area = d.area && !/^food & beverage$/i.test(d.area) ? titleCase(d.area) : "";
  const event = d.event ? ` — ${d.event}` : "";
  return `${place}${role ? ` · ${role}` : " shift"}${area ? ` (${area})` : ""}${event}`;
}

/** Moodle deadline heuristics: "Assignment 2 is due", "Quiz 3 closes", etc. */
export function moodleTaskFrom(o: Occurrence): Pick<Task, "title" | "estimateMinutes" | "energy" | "importance"> | undefined {
  const s = o.summary;
  const lower = s.toLowerCase();
  const cats = (o.categories ?? []).join(" ").toLowerCase();
  const isDeadline = /\b(is due|due|closes|deadline|submission)\b/.test(lower) || /assign|quiz/.test(cats);
  if (!isDeadline && !/quiz|assignment|test|exam/.test(lower)) return undefined;
  const name = s.replace(/\s+(is due|closes|opens|due)\b.*$/i, "").trim();
  if (/\bopens\b/i.test(s)) return undefined; // "Quiz opens" isn't a deadline
  if (/quiz|test/.test(lower)) return { title: `Do ${name}`, estimateMinutes: 45, energy: "medium", importance: 4 };
  if (/exam/.test(lower)) return { title: `Revise for ${name}`, estimateMinutes: 480, energy: "high", importance: 5 };
  if (/assign|report|essay|project|lab/.test(lower + cats)) return { title: `Finish ${name}`, estimateMinutes: 480, energy: "high", importance: 4 };
  return { title: `Complete ${name}`, estimateMinutes: 90, energy: "medium", importance: 3 };
}

/**
 * Import one feed. Idempotent: occurrences are matched by externalId, and only source-owned
 * fields (title, times, due) are updated so your own edits (estimate, notes, lock) are kept.
 */
export async function syncFeed(store: Store, feed: Feed, opts: { text?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const text = opts.text ?? (await (await fetch(feed.url)).text());
  const from = new Date(now.getTime() - 86_400_000);
  const to = new Date(now.getTime() + 60 * 86_400_000);
  const zone = (await store.prefs()).timezone;
  const occ = occurrences(text, from, to, zone);
  const source = feed.kind === "moodle" ? "moodle" : feed.kind === "timetable" ? "timetable" : feed.kind === "roster" ? "browser" : "gcal";
  const batchId = newId("sync_");
  const [tasks, events] = await Promise.all([store.list("task"), store.list("event")]);
  let created = 0;
  let updated = 0;
  for (const o of occ) {
    const externalId = `${feed.id}:${o.uid}`;
    if (feed.kind === "moodle") {
      const t = moodleTaskFrom(o);
      if (!t) continue;
      const due = o.end.getTime() > o.start.getTime() ? o.end : o.start;
      const existing = tasks.find((x) => x.sourceUrl === externalId || (x.notes ?? "").includes(externalId));
      if (existing) {
        if (existing.due !== due.toISOString()) {
          await store.update("task", existing.id, { due: due.toISOString() }, { actor: "connector", reason: "Moodle date changed", batchId });
          updated++;
        }
        continue;
      }
      await store.create(
        "task",
        {
          id: newId("tsk_"),
          ...t,
          area: "uni",
          status: "todo",
          due: due.toISOString(),
          source: "moodle",
          sourceUrl: o.url ?? externalId,
          notes: `${o.summary}${o.description ? `\n${o.description.slice(0, 500)}` : ""}\n[${externalId}]`,
          createdAt: now.toISOString(),
        },
        { actor: "connector", reason: "From Moodle", batchId },
      );
      created++;
    } else {
      const existing = events.find((e) => e.externalId === externalId);
      const isShift = feed.kind === "roster" || /^shift\b/i.test(o.summary);
      const data: Omit<CalEvent, "id"> = {
        title: isShift ? shiftTitle(o) : o.summary,
        start: o.start.toISOString(),
        end: o.end.toISOString(),
        lock: existing?.lock ?? (feed.kind === "roster" ? "hard" : feed.lock),
        certainty: "confirmed",
        area: feed.kind === "timetable" ? "uni" : isShift ? "work" : existing?.area,
        source,
        externalId,
        location: o.location ? titleCase(o.location.split(",")[0]) : undefined,
        notes: isShift && o.description ? o.description.trim() : undefined,
      };
      if (existing) {
        if (existing.start !== data.start || existing.end !== data.end || existing.title !== data.title) {
          await store.update("event", existing.id, { title: data.title, start: data.start, end: data.end, location: data.location }, { actor: "connector", reason: `${feed.name} changed`, batchId });
          updated++;
        }
      } else {
        await store.create("event", { id: newId("evt_"), ...data }, { actor: "connector", reason: `From ${feed.name}`, batchId });
        created++;
      }
    }
  }
  // Shifts/classes that vanished from the feed: propose removal (Review), never delete silently.
  let proposedRemovals = 0;
  if (feed.kind !== "moodle") {
    const seen = new Set(occ.map((o) => `${feed.id}:${o.uid}`));
    const nowMs = now.getTime();
    const already = new Set((await store.listChanges({ status: "proposed", limit: 500 })).filter((c) => c.op === "delete").map((c) => c.entityId));
    for (const e of events) {
      if (!e.externalId?.startsWith(`${feed.id}:`) || seen.has(e.externalId)) continue;
      if (Date.parse(e.start) < nowMs || Date.parse(e.start) > to.getTime() || already.has(e.id)) continue;
      await store.remove("event", e.id, { actor: "connector", reason: `No longer in ${feed.name}`, batchId, propose: true });
      proposedRemovals++;
    }
  }
  return { created, updated, proposedRemovals, seen: occ.length };
}

export async function syncAllFeeds(store: Store) {
  const feeds = await listFeeds(store);
  const results: Record<string, unknown> = {};
  for (const f of feeds) {
    if (f.url.startsWith("upload:")) continue; // uploaded files are re-imported when you upload again
    try {
      results[f.id] = await syncFeed(store, f);
      f.lastSync = new Date().toISOString();
      f.lastError = undefined;
    } catch (e) {
      f.lastError = (e as Error).message;
      results[f.id] = { error: f.lastError };
    }
  }
  await saveFeeds(store, feeds);
  return results;
}
