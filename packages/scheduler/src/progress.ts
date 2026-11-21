import type { AreaKind, Preferences, Task } from "@life/core";

/**
 * Minutes of work left on a task.
 * - explicit `remainingMinutes` wins (set by re-estimation),
 * - otherwise estimate × learned factor for the area × (1 - progress).
 */
export function remainingMinutes(task: Task, prefs?: Pick<Preferences, "estimateFactor">): number {
  if (task.status === "done" || task.status === "dropped") return 0;
  if (typeof task.remainingMinutes === "number") return Math.max(0, Math.round(task.remainingMinutes));
  const factor = prefs?.estimateFactor?.[task.area] ?? 1;
  const progress = clamp(task.progress ?? 0, 0, 1);
  return Math.max(0, Math.round(task.estimateMinutes * factor * (1 - progress)));
}

/**
 * Record a work session. Partial progress counts: "did 30 of 90 min" or "about half done".
 * Returns the updated task (does not mutate).
 */
export function recordProgress(
  task: Task,
  session: { minutesSpent: number; fractionDone?: number; finished?: boolean; at?: string },
): Task {
  const actual = (task.actualMinutes ?? 0) + Math.max(0, session.minutesSpent);
  if (session.finished || session.fractionDone === 1) {
    return {
      ...task,
      actualMinutes: actual,
      progress: 1,
      remainingMinutes: 0,
      status: "done",
      completedAt: session.at ?? new Date().toISOString(),
    };
  }
  let progress: number;
  let remaining: number;
  if (typeof session.fractionDone === "number" && session.fractionDone > 0) {
    // The user's own sense of progress beats the original estimate for "how much is left".
    progress = clamp(session.fractionDone, 0.01, 0.99);
    const fromEstimate = task.estimateMinutes * (1 - progress);
    // Tracked time only predicts the total if it was tracked from the start of the task;
    // otherwise (e.g. 30 tracked minutes on something already 30% done) trust the estimate.
    const trackedFromStart = !task.progress && (task.actualMinutes ?? 0) === 0;
    if (trackedFromStart) {
      const fromPace = actual / progress - actual;
      remaining = Math.max(10, Math.round((fromEstimate + fromPace) / 2));
    } else {
      remaining = Math.max(10, Math.round(fromEstimate));
    }
  } else {
    // No fraction given: burn down the estimate, but never claim it's done.
    const base = task.remainingMinutes ?? task.estimateMinutes * (1 - (task.progress ?? 0));
    remaining = Math.max(10, Math.round(base - session.minutesSpent));
    progress = clamp(actual / (actual + remaining), 0, 0.99);
  }
  return { ...task, actualMinutes: actual, progress, remainingMinutes: remaining, status: "doing" };
}

/**
 * Learn how your estimates compare to reality, per area (exponential moving average of actual/estimate).
 * Only completed tasks with recorded time count.
 */
export function learnEstimateFactors(
  completed: Task[],
  current: Partial<Record<AreaKind, number>> = {},
  alpha = 0.2,
): Partial<Record<AreaKind, number>> {
  const next = { ...current };
  const sorted = [...completed]
    .filter((t) => t.status === "done" && (t.actualMinutes ?? 0) > 0 && t.estimateMinutes > 0)
    .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
  for (const t of sorted) {
    const ratio = clamp(t.actualMinutes! / t.estimateMinutes, 0.3, 3);
    const prev = next[t.area] ?? 1;
    next[t.area] = round2(prev * (1 - alpha) + ratio * alpha);
  }
  return next;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
