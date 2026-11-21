import type { Block, CalEvent, ISODate, OpenQuestion, Preferences, Project, Source, Task } from "@life/core";
import { fmtMins } from "./plan";
import { remainingMinutes } from "./progress";
import { atLocal, endOfLocalDay, formatDay, formatTime, localDate, ms } from "./time";

export interface TodayItem {
  key: string;
  kind: "task" | "event" | "question";
  taskId?: string;
  eventId?: string;
  questionId?: string;
  title: string;
  minutes?: number;
  start?: string;
  end?: string;
  source: Source;
  area?: string;
  project?: string;
  /** One line: why this is on today's list. */
  why: string;
  /** e.g. "11:59pm", "5–10pm" */
  timeLabel?: string;
  locked?: boolean;
  tentative?: boolean;
  progress?: number;
}

export interface TodayList {
  date: ISODate;
  /** The one thing to do right now (or next). */
  now?: TodayItem;
  must: TodayItem[];
  should: TodayItem[];
  could: TodayItem[];
  waiting: TodayItem[];
  /** Maybe-plans and open questions that matter soon. */
  tentative: TodayItem[];
  stats: { plannedMinutes: number; doneToday: number; totalToday: number };
}

export interface TodayInput {
  now: string;
  tasks: Task[];
  events: CalEvent[];
  blocks: Block[];
  prefs: Preferences;
  projects?: Project[];
  questions?: OpenQuestion[];
  reasons?: Record<string, string>;
  maxCould?: number;
}

export function buildToday(input: TodayInput): TodayList {
  const { prefs } = input;
  const zone = prefs.timezone;
  const now = ms(input.now);
  const date = localDate(now, zone);
  const dayEnd = endOfLocalDay(now, zone);
  const dayStartMs = atLocal(date, "00:00", zone);
  const projectName = (id?: string) => input.projects?.find((p) => p.id === id)?.title;
  const byId = new Map(input.tasks.map((t) => [t.id, t]));

  const todaysBlocks = input.blocks
    .filter((b) => localDate(ms(b.start), zone) === date)
    .sort((a, b) => ms(a.start) - ms(b.start));

  const used = new Set<string>();
  const must: TodayItem[] = [];
  const should: TodayItem[] = [];
  const could: TodayItem[] = [];
  const waiting: TodayItem[] = [];
  const tentative: TodayItem[] = [];

  const taskItem = (t: Task, extra: Partial<TodayItem> = {}): TodayItem => ({
    key: `t:${t.id}`,
    kind: "task",
    taskId: t.id,
    title: t.title,
    minutes: remainingMinutes(t, prefs),
    source: t.source,
    area: t.area,
    project: projectName(t.projectId),
    why: input.reasons?.[t.id] ?? "",
    progress: t.progress,
    ...extra,
  });

  // ---- Must: locked commitments today + deadlines today + things you marked as must ----
  for (const e of input.events) {
    if (e.certainty === "maybe" || e.certainty === "unknown-time") continue;
    const s = ms(e.start);
    const en = ms(e.end);
    if (en < dayStartMs || s > dayEnd) continue;
    if (e.lock !== "hard") continue;
    must.push({
      key: `e:${e.id}`,
      kind: "event",
      eventId: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      source: e.source,
      area: e.area,
      why: "Locked in",
      timeLabel: `${formatTime(s, zone)}–${formatTime(en, zone)}`,
      locked: true,
    });
  }
  for (const t of input.tasks) {
    if (t.status === "done" || t.status === "dropped" || t.status === "waiting") continue;
    const dueToday = t.due && ms(t.due) <= dayEnd;
    if (dueToday || t.mustToday === date) {
      const overdue = t.due && ms(t.due) < now;
      must.push(
        taskItem(t, {
          timeLabel: t.due ? (overdue ? "overdue" : `due ${formatTime(ms(t.due), zone)}`) : undefined,
          why: overdue
            ? `Was due ${formatDay(ms(t.due!), zone, now)} — still worth finishing?`
            : t.mustToday === date
              ? "You marked this as a must today"
              : `Due today ${formatTime(ms(t.due!), zone)}`,
        }),
      );
      used.add(t.id);
    }
  }
  must.sort((a, b) => sortKey(a) - sortKey(b));

  // ---- Should: planned blocks today, in order ------------------------------------------
  const blockMinutesByTask = new Map<string, { minutes: number; start: string; end: string }>();
  for (const b of todaysBlocks) {
    const m = Math.round((ms(b.end) - ms(b.start)) / 60_000);
    const cur = blockMinutesByTask.get(b.taskId);
    if (cur) cur.minutes += m;
    else blockMinutesByTask.set(b.taskId, { minutes: m, start: b.start, end: b.end });
  }
  for (const [taskId, info] of blockMinutesByTask) {
    const t = byId.get(taskId);
    if (!t || used.has(taskId)) continue;
    should.push(
      taskItem(t, {
        key: `t:${t.id}`,
        minutes: info.minutes,
        start: info.start,
        end: info.end,
        timeLabel: `${formatTime(ms(info.start), zone)} · ${fmtMins(info.minutes)}`,
        why: input.reasons?.[t.id] ?? "Planned for today",
      }),
    );
    used.add(taskId);
  }
  // Manual reorder wins over block order for the list (the calendar follows on next re-flow).
  should.sort((a, b) => {
    const ra = byId.get(a.taskId!)?.manualRank;
    const rb = byId.get(b.taskId!)?.manualRank;
    if (ra !== undefined || rb !== undefined) return (ra ?? 1e9) - (rb ?? 1e9);
    return ms(a.start!) - ms(b.start!);
  });

  // ---- Could: quick wins and things with no block that are fine to do today ------------
  const candidates = input.tasks
    .filter((t) => t.status === "todo" || t.status === "doing")
    .filter((t) => !used.has(t.id))
    .filter((t) => !t.deferredUntil || ms(t.deferredUntil) <= dayEnd)
    .filter((t) => !t.earliestStart || ms(t.earliestStart) <= dayEnd)
    .map((t) => ({ t, rem: remainingMinutes(t, prefs) }))
    .filter(({ rem }) => rem > 0)
    .sort((a, b) => {
      const qa = a.rem <= 20 ? 0 : 1;
      const qb = b.rem <= 20 ? 0 : 1;
      if (qa !== qb) return qa - qb;
      return (b.t.importance ?? 3) - (a.t.importance ?? 3) || a.rem - b.rem;
    });
  for (const { t, rem } of candidates.slice(0, input.maxCould ?? 5)) {
    could.push(
      taskItem(t, {
        why: rem <= 20 ? `Quick win — fits a ${fmtMins(rem)} gap` : "If you have spare energy",
      }),
    );
    used.add(t.id);
  }

  // ---- Waiting on --------------------------------------------------------------------------
  for (const t of input.tasks.filter((x) => x.status === "waiting")) {
    waiting.push(taskItem(t, { why: t.waitingOn ? `Waiting on ${t.waitingOn}` : "Waiting on someone" }));
  }

  // ---- Tentative: maybe-plans today/tomorrow, and open questions that matter soon -------
  const soon = dayEnd + 24 * 3600_000;
  for (const e of input.events) {
    if (e.certainty !== "maybe" && e.certainty !== "unknown-time") continue;
    const when = e.certainty === "unknown-time" ? atLocal(e.day ?? localDate(ms(e.start), zone), "12:00", zone) : ms(e.start);
    if (when < dayStartMs || when > soon) continue;
    tentative.push({
      key: `e:${e.id}`,
      kind: "event",
      eventId: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      source: e.source,
      area: e.area,
      tentative: true,
      timeLabel:
        e.certainty === "unknown-time"
          ? `${formatDay(when, zone, now)}, time TBC`
          : `${formatDay(when, zone, now)} ${formatTime(when, zone)}?`,
      why: "Not confirmed yet — I've left room around it",
    });
  }
  for (const q of input.questions ?? []) {
    if (q.status !== "open") continue;
    if (q.relevantBy && ms(q.relevantBy) > soon + 2 * 24 * 3600_000) continue;
    tentative.push({
      key: `q:${q.id}`,
      kind: "question",
      questionId: q.id,
      title: q.question,
      source: q.source,
      why: q.context ?? "Need your answer to plan around it",
    });
  }

  // ---- Now / Next ------------------------------------------------------------------------
  let nowItem: TodayItem | undefined;
  const current = todaysBlocks.find((b) => ms(b.start) <= now && ms(b.end) > now);
  const next = todaysBlocks.find((b) => ms(b.start) > now);
  const pick = current ?? next;
  if (pick) {
    const item = should.find((i) => i.taskId === pick.taskId) ?? must.find((i) => i.taskId === pick.taskId);
    if (item) {
      nowItem = {
        ...item,
        start: pick.start,
        end: pick.end,
        timeLabel: current
          ? `now until ${formatTime(ms(pick.end), zone)}`
          : `next at ${formatTime(ms(pick.start), zone)}`,
      };
    }
  } else {
    nowItem = must.find((i) => i.kind === "task") ?? should[0] ?? could[0];
  }

  const doneToday = input.tasks.filter((t) => t.completedAt && localDate(ms(t.completedAt), zone) === date).length;
  return {
    date,
    now: nowItem,
    must,
    should,
    could,
    waiting,
    tentative,
    stats: {
      plannedMinutes: todaysBlocks.reduce((s, b) => s + (ms(b.end) - ms(b.start)) / 60_000, 0),
      doneToday,
      totalToday: doneToday + must.filter((i) => i.kind === "task").length + should.length,
    },
  };
}

function sortKey(i: TodayItem): number {
  if (i.start) return ms(i.start);
  return Number.MAX_SAFE_INTEGER;
}
