import type { Block, CheckIn, Preferences, Task } from "@life/core";
import { atLocal, localDate, ms } from "./time";

/**
 * Kind, not naggy:
 *  - never during quiet hours,
 *  - after two ignored check-ins in a row today, stop for the day (ask once at close-out instead),
 *  - at most one check-in per block.
 */
export function shouldCheckIn(
  nowIso: string,
  history: CheckIn[],
  prefs: Preferences,
  blockId?: string,
): { ok: boolean; reason: string } {
  const zone = prefs.timezone;
  const now = ms(nowIso);
  if (inQuietHours(now, prefs)) return { ok: false, reason: "quiet-hours" };
  const today = localDate(now, zone);
  const todays = history
    .filter((c) => localDate(ms(c.askedAt), zone) === today)
    .sort((a, b) => ms(a.askedAt) - ms(b.askedAt));
  if (blockId && todays.some((c) => c.blockId === blockId)) return { ok: false, reason: "already-asked" };
  const lastTwo = todays.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((c) => !c.response || c.response === "ignored")) {
    return { ok: false, reason: "backed-off" };
  }
  return { ok: true, reason: "ok" };
}

export function inQuietHours(now: number, prefs: Preferences): boolean {
  const zone = prefs.timezone;
  const date = localDate(now, zone);
  const qs = atLocal(date, prefs.quietStart, zone);
  const qe = atLocal(date, prefs.quietEnd, zone);
  // Quiet hours usually wrap midnight (22:30 -> 07:30).
  if (qs > qe) return now >= qs || now < qe;
  return now >= qs && now < qe;
}

export interface CloseOutItem {
  taskId: string;
  title: string;
  suggestion: "tomorrow" | "later-this-week" | "break-down" | "drop";
  why: string;
}

/**
 * End-of-day close-out: everything planned for today that didn't get done gets one suggested next step.
 * The user confirms with one tap per item.
 */
export function closeOut(nowIso: string, tasks: Task[], blocks: Block[], prefs: Preferences): CloseOutItem[] {
  const zone = prefs.timezone;
  const today = localDate(ms(nowIso), zone);
  const plannedToday = new Set(blocks.filter((b) => localDate(ms(b.start), zone) === today).map((b) => b.taskId));
  const items: CloseOutItem[] = [];
  for (const t of tasks) {
    if (t.status === "done" || t.status === "dropped" || t.status === "waiting") continue;
    if (!plannedToday.has(t.id) && t.mustToday !== today) continue;
    const timesSkipped = (t.notes?.match(/\[skipped\]/g) ?? []).length;
    if (timesSkipped >= 2 && !t.due) {
      items.push({ taskId: t.id, title: t.title, suggestion: "drop", why: "Skipped a few times with no deadline — still want it?" });
    } else if (timesSkipped >= 1 || t.estimateMinutes > 120) {
      items.push({ taskId: t.id, title: t.title, suggestion: "break-down", why: "Might be too big — split into smaller steps?" });
    } else if (t.due && ms(t.due) - ms(nowIso) < 3 * 24 * 3600_000) {
      items.push({ taskId: t.id, title: t.title, suggestion: "tomorrow", why: "Due soon — first thing tomorrow" });
    } else {
      items.push({ taskId: t.id, title: t.title, suggestion: t.due ? "tomorrow" : "later-this-week", why: "Moving it on" });
    }
  }
  return items;
}

export interface FreshStart {
  needed: boolean;
  daysAway: number;
  overdue: Task[];
  stale: Task[];
  message: string;
}

/**
 * Graceful when you go dark: instead of a wall of overdue items, offer one "fresh start" review.
 */
export function freshStart(nowIso: string, lastActiveIso: string | undefined, tasks: Task[]): FreshStart {
  const now = ms(nowIso);
  const daysAway = lastActiveIso ? Math.floor((now - ms(lastActiveIso)) / (24 * 3600_000)) : 0;
  const open = tasks.filter((t) => t.status === "todo" || t.status === "doing");
  const overdue = open.filter((t) => t.due && ms(t.due) < now);
  const stale = open.filter((t) => !t.due && ms(t.createdAt) < now - 21 * 24 * 3600_000);
  const needed = daysAway >= 4 || overdue.length >= 5;
  return {
    needed,
    daysAway,
    overdue,
    stale,
    message: needed
      ? `Welcome back. ${overdue.length} things slipped past their dates — let's quickly decide what still matters, then I'll re-plan from today.`
      : "",
  };
}
