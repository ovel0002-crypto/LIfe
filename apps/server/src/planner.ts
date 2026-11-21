import { newId, type Block } from "@life/core";
import { buildToday, closeOut, freshStart, ms, plan, type PlanResult, type TodayList } from "@life/scheduler";
import type { Store } from "./store";

export interface StoredPlan extends PlanResult {
  computedAt: string;
}

type Listener = (p: StoredPlan) => void | Promise<void>;

/**
 * Re-flow is constant and cheap: it's pure deterministic code (no LLM), so we simply re-plan
 * after any change and on a timer.
 */
export class Planner {
  private listeners: Listener[] = [];
  constructor(private store: Store) {}

  onPlan(l: Listener) {
    this.listeners.push(l);
  }

  async replan(opts: { now?: string; reason?: string } = {}): Promise<StoredPlan> {
    const now = opts.now ?? new Date().toISOString();
    const [tasks, events, prefs, dayModes, previous] = await Promise.all([
      this.store.list("task"),
      this.store.list("event"),
      this.store.prefs(),
      this.store.dayModes(),
      this.store.getKv<StoredPlan>("plan"),
    ]);
    // Keep a block that's in progress only if you confirmed you're on it (check-in "on it" / Start).
    // Missed or unconfirmed blocks simply re-flow — nothing is lost.
    const nowMs = ms(now);
    const confirmed = new Set((await this.store.getKv<string[]>("confirmedBlocks")) ?? []);
    const keepBlocks: Block[] = (previous?.blocks ?? []).filter((b) => confirmed.has(b.id) && ms(b.start) <= nowMs && ms(b.end) > nowMs);
    const result = plan({ now, tasks, events, prefs, dayModes, keepBlocks });
    const blocks = [...keepBlocks, ...result.blocks];

    // Flexible events (weekly review, gym...) can be moved by the system; record each move so it's undoable.
    if (result.eventMoves.length) {
      const batchId = newId("reflow_");
      for (const m of result.eventMoves) {
        const isShort = m.shortened;
        await this.store.update(
          "event",
          m.eventId,
          { start: m.to.start, end: m.to.end, ...(isShort ? { notes: "Short version" } : {}) },
          { actor: "system", reason: m.reason, batchId },
        );
      }
    }

    // Keep the previous plan's "why" lines when nothing new was computed for a task.
    const stored: StoredPlan = { ...result, blocks, reasons: { ...(previous?.reasons ?? {}), ...result.reasons }, computedAt: now };
    await this.store.setKv("plan", stored);
    for (const l of this.listeners) await l(stored);
    return stored;
  }

  async current(): Promise<StoredPlan> {
    const p = await this.store.getKv<StoredPlan>("plan");
    // Re-plan if stale (>5 min) — the plan is always "from now".
    if (!p || Date.now() - ms(p.computedAt) > 5 * 60_000) return this.replan();
    return p;
  }

  async today(now = new Date().toISOString()): Promise<TodayList & { conflicts: StoredPlan["conflicts"]; freshStart?: ReturnType<typeof freshStart> }> {
    const p = await this.current();
    const [tasks, events, prefs, projects, questions, lastActive] = await Promise.all([
      this.store.list("task"),
      this.store.list("event"),
      this.store.prefs(),
      this.store.list("project"),
      this.store.list("question"),
      this.store.getKv<string>("lastActiveAt"),
    ]);
    const list = buildToday({ now, tasks, events, blocks: p.blocks, prefs, projects, questions, reasons: p.reasons });
    const fs = freshStart(now, lastActive, tasks);
    await this.store.setKv("lastActiveAt", now);
    return { ...list, conflicts: p.conflicts, freshStart: fs.needed ? fs : undefined };
  }

  async closeOut(now = new Date().toISOString()) {
    const p = await this.current();
    const [tasks, prefs] = await Promise.all([this.store.list("task"), this.store.prefs()]);
    return closeOut(now, tasks, p.blocks, prefs);
  }
}
