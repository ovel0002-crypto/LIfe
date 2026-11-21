import type { Block, CalEvent, DayMode, ISODate, Preferences, Task } from "@life/core";
import { remainingMinutes } from "./progress";
import {
  addDays,
  atLocal,
  energyAt,
  formatDay,
  formatTime,
  type Interval,
  iso,
  localDate,
  MIN,
  minutes,
  ms,
  overlaps,
  subtract,
} from "./time";

export interface PlanInput {
  now: string;
  tasks: Task[];
  events: CalEvent[];
  prefs: Preferences;
  /** Per-day mode overrides ("sick", "busy", ...). Missing = normal. */
  dayModes?: Record<ISODate, DayMode>;
  horizonDays?: number;
  /**
   * Blocks to keep as-is (already started / in the past). Everything else is re-planned,
   * which is what makes re-flow cheap and constant.
   */
  keepBlocks?: Block[];
}

export interface EventMove {
  eventId: string;
  title: string;
  from: { start: string; end: string };
  to: { start: string; end: string };
  /** true when shortened to its short version */
  shortened: boolean;
  reason: string;
}

export interface Conflict {
  kind: "overload" | "event-overlap" | "unplaceable-event";
  message: string;
  taskIds?: string[];
  eventIds?: string[];
  /** Concrete choices to offer the user — the system never silently crams. */
  options: string[];
}

export interface DaySummary {
  date: ISODate;
  mode: DayMode;
  freeMinutes: number;
  capacityMinutes: number;
  plannedMinutes: number;
  reservedMinutes: number;
}

export interface Unscheduled {
  taskId: string;
  minutesShort: number;
  reason: "past-deadline-capacity" | "no-room-in-horizon" | "day-mode" | "not-blockable";
}

export interface PlanResult {
  blocks: Block[];
  eventMoves: EventMove[];
  conflicts: Conflict[];
  unscheduled: Unscheduled[];
  days: DaySummary[];
  /** Human-readable reasons per task id, used for "why today" lines. */
  reasons: Record<string, string>;
}

const MODE_FACTOR: Record<DayMode, number> = {
  normal: 1,
  free: 1.3,
  "low-energy": 0.6,
  busy: 0.4,
  sick: 0.35, // only true musts are allowed on sick days (see allowedOnDay)
};

const GAP_MINUTES = 5;

interface DayState {
  date: ISODate;
  mode: DayMode;
  free: Interval[];
  freeMinutes: number;
  capacity: number;
  used: number;
  reserved: number;
  taskMinutes: Map<string, number>;
}

interface TaskState {
  task: Task;
  remaining: number;
  deadline?: number; // epoch ms (planning deadline incl. buffer)
  due?: number;
  earliest: number;
}

export function plan(input: PlanInput): PlanResult {
  const { prefs } = input;
  const zone = prefs.timezone;
  const now = ms(input.now);
  const horizon = input.horizonDays ?? 14;
  const today = localDate(now, zone);
  const dayModes = input.dayModes ?? {};
  const keep = input.keepBlocks ?? [];
  const conflicts: Conflict[] = [];
  const eventMoves: EventMove[] = [];
  const reasons: Record<string, string> = {};

  // ---- 1. Fixed busy time from events -----------------------------------------------------
  const timed = input.events.filter((e) => e.certainty !== "unknown-time");
  const fixed = timed.filter((e) => e.lock !== "flexible");
  const flexible = timed.filter((e) => e.lock === "flexible");

  const busy: Interval[] = [];
  for (const e of fixed) {
    const i = { start: ms(e.start), end: ms(e.end) };
    if (e.certainty === "maybe") {
      // Tentative: keep a buffer around it instead of committing work right up against it.
      const pad = prefs.maybeBufferMinutes * MIN;
      busy.push({ start: i.start - pad, end: i.end + pad });
    } else {
      busy.push(i);
    }
  }
  for (const b of keep) busy.push({ start: ms(b.start), end: ms(b.end) });

  // Hard vs soft overlaps are surfaced, never auto-resolved.
  for (const a of fixed.filter((e) => e.lock === "hard")) {
    for (const b of fixed.filter((e) => e.lock === "soft")) {
      if (overlaps({ start: ms(a.start), end: ms(a.end) }, { start: ms(b.start), end: ms(b.end) })) {
        conflicts.push({
          kind: "event-overlap",
          message: `"${b.title}" overlaps "${a.title}" (locked). Want to move "${b.title}"?`,
          eventIds: [a.id, b.id],
          options: [`Move "${b.title}"`, `Keep both (I'll sort it)`, `Unlock "${a.title}"`],
        });
      }
    }
  }

  // ---- 2. Flexible events: move them out of the way if they now clash ---------------------
  const sortedFlexible = [...flexible].sort((a, b) => ms(a.start) - ms(b.start));
  for (const e of sortedFlexible) {
    const orig = { start: ms(e.start), end: ms(e.end) };
    if (orig.end <= now) continue; // past
    const clash = busy.some((b) => overlaps(b, orig)) || orig.start < now;
    if (!clash) {
      busy.push(orig);
      continue;
    }
    const placed = relocateFlexible(e, orig, busy, now, prefs);
    if (placed) {
      busy.push(placed.interval);
      eventMoves.push({
        eventId: e.id,
        title: e.title,
        from: { start: e.start, end: e.end },
        to: { start: iso(placed.interval.start, zone), end: iso(placed.interval.end, zone) },
        shortened: placed.shortened,
        reason: placed.shortened
          ? `Clashed with something fixed; moved to ${formatDay(placed.interval.start, zone, now)} ${formatTime(placed.interval.start, zone)} as the short version`
          : `Clashed with something fixed; moved to ${formatDay(placed.interval.start, zone, now)} ${formatTime(placed.interval.start, zone)}`,
      });
    } else {
      conflicts.push({
        kind: "unplaceable-event",
        message: `Couldn't find a new time for "${e.title}".`,
        eventIds: [e.id],
        options: ["Skip it this time", "Split it into smaller pieces", "Pick a time myself"],
      });
    }
  }

  // ---- 3. Build day states ----------------------------------------------------------------
  const days: DayState[] = [];
  for (let d = 0; d < horizon; d++) {
    const date = addDays(today, d, zone);
    const mode = dayModes[date] ?? "normal";
    let start = atLocal(date, prefs.dayStart, zone);
    const end = atLocal(date, prefs.dayEnd, zone);
    if (d === 0) start = Math.max(start, roundUp(now, 5));
    const window = start < end ? [{ start, end }] : [];
    const free = subtract(window, busy);
    const freeMinutes = free.reduce((s, i) => s + minutes(i), 0);
    const reserved = input.events
      .filter((e) => e.certainty === "unknown-time" && (e.day ?? localDate(ms(e.start), zone)) === date)
      .reduce((s) => s + prefs.unknownTimeReserveMinutes, 0);
    const ratio = Math.min(0.9, prefs.capacityRatio * MODE_FACTOR[mode]);
    const capacity = Math.max(0, Math.floor(freeMinutes * ratio) - reserved);
    days.push({ date, mode, free, freeMinutes, capacity, used: 0, reserved, taskMinutes: new Map() });
  }

  // Kept blocks count against their day's capacity and their task's remaining time.
  const keptFuture = new Map<string, number>();
  for (const b of keep) {
    const s = Math.max(ms(b.start), now);
    const e = ms(b.end);
    if (e <= s) continue;
    const day = days.find((d) => d.date === localDate(s, zone));
    const m = Math.round((e - s) / MIN);
    if (day) {
      day.used += m;
      day.taskMinutes.set(b.taskId, (day.taskMinutes.get(b.taskId) ?? 0) + m);
    }
    keptFuture.set(b.taskId, (keptFuture.get(b.taskId) ?? 0) + m);
  }

  // ---- 4. Task states ---------------------------------------------------------------------
  const states: TaskState[] = [];
  const unscheduled: Unscheduled[] = [];
  for (const t of input.tasks) {
    if (t.status === "done" || t.status === "dropped" || t.status === "waiting") continue;
    const remaining = Math.max(0, remainingMinutes(t, prefs) - (keptFuture.get(t.id) ?? 0));
    if (remaining <= 0) continue;
    const due = t.due ? ms(t.due) : undefined;
    // Aim to finish before the deadline with a buffer, unless the deadline is too close for that.
    let deadline = due;
    if (due !== undefined) {
      const buffered = due - prefs.deadlineBufferHours * 60 * MIN;
      deadline = buffered > now + remaining * MIN ? buffered : due;
    }
    const earliest = Math.max(
      t.earliestStart ? ms(t.earliestStart) : 0,
      t.deferredUntil ? ms(t.deferredUntil) : 0,
    );
    // Small tasks with no deadline are "could do" gap-fillers, not calendar blocks.
    if (remaining < prefs.minBlockMinutes && due === undefined && !t.mustToday) {
      unscheduled.push({ taskId: t.id, minutesShort: remaining, reason: "not-blockable" });
      continue;
    }
    states.push({ task: t, remaining, deadline, due, earliest });
  }

  // ---- 5. Greedy placement, day by day, slot by slot ---------------------------------------
  const blocks: Block[] = [];
  for (const day of days) {
    for (const slot of day.free) {
      let cursor = slot.start;
      while (cursor < slot.end && day.capacity - day.used > 0) {
        const slotLeft = Math.floor((slot.end - cursor) / MIN);
        const capLeft = day.capacity - day.used;
        let best: { s: TaskState; score: number; len: number } | undefined;
        for (const s of states) {
          if (s.remaining <= 0) continue;
          if (s.earliest > cursor) continue;
          if (s.due !== undefined && cursor >= s.due) continue;
          if (!allowedOnDay(s, day, prefs, zone)) continue;
          const usedToday = day.taskMinutes.get(s.task.id) ?? 0;
          const perDayLeft = prefs.maxTaskMinutesPerDay - usedToday;
          let len = Math.min(prefs.maxBlockMinutes, s.remaining, slotLeft, capLeft, perDayLeft);
          // Don't run a block past the actual due time.
          if (s.due !== undefined) len = Math.min(len, Math.floor((s.due - cursor) / MIN));
          const tooSmall = len < Math.min(prefs.minBlockMinutes, s.remaining);
          if (len <= 0 || tooSmall) continue;
          const score = scoreTask(s, cursor, days, day, prefs, now, zone);
          if (!best || score > best.score) best = { s, score, len };
        }
        if (!best) break;
        const start = cursor;
        const end = cursor + best.len * MIN;
        blocks.push({
          id: `blk_${best.s.task.id}_${start.toString(36)}`,
          taskId: best.s.task.id,
          start: iso(start, zone),
          end: iso(end, zone),
        });
        best.s.remaining -= best.len;
        day.used += best.len;
        day.taskMinutes.set(best.s.task.id, (day.taskMinutes.get(best.s.task.id) ?? 0) + best.len);
        if (!reasons[best.s.task.id]) reasons[best.s.task.id] = explain(best.s, start, days, prefs, now, zone);
        cursor = end + GAP_MINUTES * MIN;
      }
    }
  }

  // ---- 6. Overload: anything that can't make its deadline becomes a choice, not a cram ------
  const horizonEnd = atLocal(days[days.length - 1]?.date ?? today, prefs.dayEnd, zone);
  for (const s of states) {
    if (s.remaining <= 0) continue;
    if (s.due !== undefined && s.due <= horizonEnd) {
      unscheduled.push({ taskId: s.task.id, minutesShort: s.remaining, reason: "past-deadline-capacity" });
      conflicts.push(overloadConflict(s, blocks, states, days, prefs, now, zone));
    } else {
      const blockedByMode = days.some((d) => d.mode === "sick");
      unscheduled.push({
        taskId: s.task.id,
        minutesShort: s.remaining,
        reason: blockedByMode ? "day-mode" : "no-room-in-horizon",
      });
    }
  }

  return {
    blocks,
    eventMoves,
    conflicts,
    unscheduled,
    reasons,
    days: days.map((d) => ({
      date: d.date,
      mode: d.mode,
      freeMinutes: d.freeMinutes,
      capacityMinutes: d.capacity,
      plannedMinutes: d.used,
      reservedMinutes: d.reserved,
    })),
  };
}

// ----------------------------------------------------------------------------------------------

function roundUp(t: number, toMinutes: number): number {
  const step = toMinutes * MIN;
  return Math.ceil(t / step) * step;
}

/** Sick days only take true musts; low-energy days avoid demanding work unless urgent. */
function allowedOnDay(s: TaskState, day: DayState, prefs: Preferences, zone: string): boolean {
  if (day.mode !== "sick") return true;
  if (s.task.mustToday === day.date) return true;
  if (s.due === undefined) return false;
  // Due before the end of tomorrow = a true must.
  const endTomorrow = atLocal(addDays(day.date, 1, zone), "23:59", zone);
  return s.due <= endTomorrow;
}

function capacityBetween(days: DayState[], from: number, to: number, zone: string, prefs: Preferences): number {
  let total = 0;
  for (const d of days) {
    const dayEnd = atLocal(d.date, prefs.dayEnd, zone);
    const dayStart = atLocal(d.date, prefs.dayStart, zone);
    if (dayEnd <= from || dayStart >= to) continue;
    const left = Math.max(0, d.capacity - d.used);
    // Pro-rate a partial day (deadline mid-day).
    const span = Math.max(1, dayEnd - Math.max(dayStart, from));
    const usable = Math.max(0, Math.min(dayEnd, to) - Math.max(dayStart, from));
    total += left * Math.min(1, usable / span);
  }
  return total;
}

function loadRatio(s: TaskState, cursor: number, days: DayState[], prefs: Preferences, zone: string): number {
  if (s.deadline === undefined) return 0;
  const cap = capacityBetween(days, cursor, s.deadline, zone, prefs);
  return s.remaining / Math.max(cap, 1);
}

function scoreTask(
  s: TaskState,
  cursor: number,
  days: DayState[],
  day: DayState,
  prefs: Preferences,
  now: number,
  zone: string,
): number {
  const t = s.task;
  const ratio = s.deadline !== undefined ? loadRatio(s, cursor, days, prefs, zone) : 0;
  // Urgency: how much of the remaining capacity before the deadline this task needs.
  const urgency = s.deadline === undefined ? 0.15 : 0.3 + 3 * Math.min(ratio, 2);
  const importance = (t.importance ?? 3) / 3;
  const focus = Math.max(0.1, 1 + (prefs.focus[t.area] ?? 0) + (t.projectId ? prefs.focus[t.projectId] ?? 0 : 0));
  // Energy fit: demanding work in low-energy slots is penalised.
  const slotEnergy = energyAt(cursor, prefs);
  const need = t.energy ?? "medium";
  let energyFit = 1;
  if (need === "high" && slotEnergy === "low") energyFit = 0.6;
  if (need === "low" && slotEnergy === "high") energyFit = 0.85;
  if (day.mode === "low-energy" && need === "high" && ratio < 0.8) energyFit *= 0.3;
  const must = t.mustToday === day.date ? 5 : 1;
  const manual = typeof t.manualRank === "number" ? 1 + 0.6 / (1 + t.manualRank) : 1;
  // Small nudge to keep in-progress work moving (momentum).
  const momentum = t.status === "doing" ? 1.1 : 1;
  return urgency * importance * focus * energyFit * must * manual * momentum;
}

function explain(s: TaskState, start: number, days: DayState[], prefs: Preferences, now: number, zone: string): string {
  const t = s.task;
  const parts: string[] = [];
  if (t.mustToday) parts.push("You marked this as a must");
  if (s.due !== undefined) {
    const ratio = loadRatio(s, start, days, prefs, zone);
    const hrs = Math.round(((s.remaining + 0) / 60) * 10) / 10;
    const when = `${formatDay(s.due, zone, now)} ${formatTime(s.due, zone)}`;
    if (ratio > 0.8) parts.push(`Due ${when} — tight, needs most of your free time until then`);
    else if (ratio > 0.4) parts.push(`Due ${when} — keeping it on track`);
    else parts.push(`Due ${when} — starting early so it's never a rush (${hrs}h left)`);
  }
  const f = (prefs.focus[t.area] ?? 0) + (t.projectId ? prefs.focus[t.projectId] ?? 0 : 0);
  if (f > 0) parts.push("You asked to focus on this");
  if (parts.length === 0) parts.push("Free time available — moving this project forward");
  return parts.join(" · ");
}

function relocateFlexible(
  e: CalEvent,
  orig: Interval,
  busy: Interval[],
  now: number,
  prefs: Preferences,
): { interval: Interval; shortened: boolean } | undefined {
  const zone = prefs.timezone;
  const durMs = orig.end - orig.start;
  const winStart = Math.max(now, e.window ? ms(e.window.earliest) : atLocal(localDate(orig.start, zone), prefs.dayStart, zone));
  const winEnd = e.window ? ms(e.window.latest) : atLocal(localDate(orig.start, zone), prefs.dayEnd, zone);
  // Build free time within the window, bounded to waking hours each day.
  const windows: Interval[] = [];
  let d = localDate(winStart, zone);
  for (let i = 0; i < 31; i++) {
    const ds = Math.max(winStart, atLocal(d, prefs.dayStart, zone));
    const de = Math.min(winEnd, atLocal(d, prefs.dayEnd, zone));
    if (ds < de) windows.push({ start: roundUp(ds, 5), end: de });
    if (atLocal(d, prefs.dayEnd, zone) >= winEnd) break;
    d = addDays(d, 1, zone);
  }
  const free = subtract(windows, busy);
  const tryLen = (len: number) => {
    let best: Interval | undefined;
    let bestDist = Infinity;
    for (const f of free) {
      if (f.end - f.start < len) continue;
      // Closest start to the original time.
      const candidate = Math.min(Math.max(orig.start, f.start), f.end - len);
      const dist = Math.abs(candidate - orig.start);
      if (dist < bestDist) {
        bestDist = dist;
        best = { start: candidate, end: candidate + len };
      }
    }
    return best;
  };
  const full = tryLen(durMs);
  if (full) return { interval: full, shortened: false };
  if (e.shortVersionMinutes) {
    const short = tryLen(e.shortVersionMinutes * MIN);
    if (short) return { interval: short, shortened: true };
  }
  return undefined;
}

function overloadConflict(
  s: TaskState,
  blocks: Block[],
  states: TaskState[],
  days: DayState[],
  prefs: Preferences,
  now: number,
  zone: string,
): Conflict {
  const t = s.task;
  const due = s.due!;
  const short = s.remaining;
  const options: string[] = [];

  // Option A: use buffer (slack) time the planner deliberately left free.
  const slack = days
    .filter((d) => atLocal(d.date, prefs.dayStart, zone) < due)
    .reduce((sum, d) => sum + Math.max(0, d.freeMinutes - d.reserved - Math.max(d.capacity, d.used)), 0);
  if (slack >= short) options.push(`Use ${fmtMins(short)} of your buffer time before it's due (busier days)`);

  // Option B: push lower-priority work scheduled before the deadline.
  const displaceable = new Map<string, number>();
  for (const b of blocks) {
    if (ms(b.start) >= due) continue;
    const other = states.find((x) => x.task.id === b.taskId);
    if (!other || other.task.id === t.id) continue;
    if (other.due !== undefined && other.due <= due) continue;
    displaceable.set(other.task.id, (displaceable.get(other.task.id) ?? 0) + (ms(b.end) - ms(b.start)) / MIN);
  }
  const names = [...displaceable.keys()]
    .map((id) => states.find((x) => x.task.id === id)!.task.title)
    .slice(0, 3);
  if (names.length) options.push(`Push ${names.map((n) => `"${n}"`).join(", ")} until after it's due`);

  // Option C: day modes that removed capacity.
  const reduced = days.filter((d) => d.mode !== "normal" && d.mode !== "free" && atLocal(d.date, prefs.dayStart, zone) < due);
  if (reduced.length) options.push(`Treat ${reduced.map((d) => d.date).join(", ")} as a normal day`);

  options.push(`Cut scope or ask for an extension on "${t.title}"`);
  options.push("Leave it — I'll handle it");

  return {
    kind: "overload",
    message: `"${t.title}" is due ${formatDay(due, zone, now)} ${formatTime(due, zone)} but ${fmtMins(short)} won't fit in your plan.`,
    taskIds: [t.id],
    options,
  };
}

export function fmtMins(m: number): string {
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return r ? `${h}h ${r}m` : `${h}h`;
}
