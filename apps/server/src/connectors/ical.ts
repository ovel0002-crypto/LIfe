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
   * calendar  → any other calendar (work roster app, sports club...) → events
   */
  kind: "moodle" | "timetable" | "calendar";
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

/** Parse an iCal document into concrete occurrences within a window (recurring events expanded). */
export function occurrences(text: string, from: Date, to: Date): Occurrence[] {
  const data = ical.sync.parseICS(text);
  const out: Occurrence[] = [];
  for (const v of Object.values(data)) {
    if (!v || v.type !== "VEVENT") continue;
    const e = v as VEvent;
    const summary = typeof e.summary === "string" ? e.summary : String((e.summary as { val?: string })?.val ?? "");
    const durMs = e.end && e.start ? new Date(e.end as Date).getTime() - new Date(e.start as Date).getTime() : 0;
    const base = {
      summary,
      description: typeof e.description === "string" ? e.description : undefined,
      location: typeof e.location === "string" ? e.location : undefined,
      url: typeof e.url === "string" ? e.url : undefined,
      categories: e.categories as string[] | undefined,
    };
    if (e.rrule) {
      const exdates = new Set(Object.values(e.exdate ?? {}).map((d) => new Date(d as Date).getTime()));
      for (const d of e.rrule.between(from, to, true)) {
        if (exdates.has(d.getTime())) continue;
        out.push({ ...base, uid: `${e.uid}@${d.toISOString()}`, start: d, end: new Date(d.getTime() + durMs) });
      }
    } else if (e.start) {
      const start = new Date(e.start as Date);
      const end = e.end ? new Date(e.end as Date) : start;
      if (end >= from && start <= to) out.push({ ...base, uid: String(e.uid), start, end });
    }
  }
  return out;
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
  const occ = occurrences(text, from, to);
  const source = feed.kind === "moodle" ? "moodle" : feed.kind === "timetable" ? "timetable" : "gcal";
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
      const data: Omit<CalEvent, "id"> = {
        title: o.summary,
        start: o.start.toISOString(),
        end: o.end.toISOString(),
        lock: existing?.lock ?? feed.lock,
        certainty: "confirmed",
        area: feed.kind === "timetable" ? "uni" : existing?.area,
        source,
        externalId,
        location: o.location,
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
  return { created, updated, seen: occ.length };
}

export async function syncAllFeeds(store: Store) {
  const feeds = await listFeeds(store);
  const results: Record<string, unknown> = {};
  for (const f of feeds) {
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
