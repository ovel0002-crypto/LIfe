import { newId, type CheckIn } from "@life/core";
import { fmtMins, ms, recordProgress, shouldCheckIn } from "@life/scheduler";
import type { Notifier } from "./notify";
import type { Planner } from "./planner";
import type { Store } from "./store";

export type CheckInResponse = "on-it" | "doing-other" | "snooze" | "done" | "partial";

/**
 * The accountability loop: when a block starts, ask once ("On A2 intro now?").
 * Answers re-flow the plan; silence is fine — it just re-flows, and after two ignored check-ins
 * it stops asking for the day.
 */
export class CheckIns {
  constructor(
    private store: Store,
    private planner: Planner,
    private notifier: Notifier,
  ) {}

  async tick(now = new Date()) {
    const plan = await this.planner.current();
    const history = await this.store.list("checkin");
    const prefs = await this.store.prefs();
    const nowMs = now.getTime();

    // Close out unanswered check-ins whose block has ended → mark ignored and re-flow.
    let changed = false;
    for (const c of history.filter((h) => !h.response)) {
      const b = plan.blocks.find((x) => x.id === c.blockId);
      if (!b || ms(b.end) <= nowMs || nowMs - ms(c.askedAt) > 90 * 60_000) {
        await this.store.update("checkin", c.id, { response: "ignored" }, { actor: "system" });
        changed = true;
      }
    }
    if (changed) await this.planner.replan();

    // Ask about a block that started in the last 3 minutes.
    const starting = plan.blocks.find((b) => ms(b.start) <= nowMs && nowMs - ms(b.start) < 3 * 60_000);
    if (!starting) return;
    const verdict = shouldCheckIn(now.toISOString(), history, prefs, starting.id);
    if (!verdict.ok) return;
    const task = await this.store.get("task", starting.taskId);
    if (!task) return;
    const c: CheckIn = { id: newId("chk_"), blockId: starting.id, taskId: task.id, askedAt: now.toISOString() };
    await this.store.create("checkin", c, { actor: "system" });
    await this.notifier.send({
      title: `Time for: ${task.title}`,
      body: `${fmtMins((ms(starting.end) - ms(starting.start)) / 60_000)} block. On it?`,
      url: "/",
      tag: starting.id,
      actions: [
        { id: "on-it", label: "✅ On it" },
        { id: "doing-other", label: "🔄 Doing something else" },
        { id: "snooze", label: "⏰ +30m" },
      ],
    });
  }

  /** Respond to a block's check-in (from push action, Telegram button or the app). */
  async respond(blockId: string, response: CheckInResponse, extra: { minutesSpent?: number; fractionDone?: number } = {}) {
    const plan = await this.planner.current();
    const block = plan.blocks.find((b) => b.id === blockId);
    const history = await this.store.list("checkin");
    const existing = history.find((h) => h.blockId === blockId);
    const now = new Date().toISOString();
    if (existing) await this.store.update("checkin", existing.id, { response, respondedAt: now }, { actor: "you" });
    else await this.store.create("checkin", { id: newId("chk_"), blockId, taskId: block?.taskId, askedAt: now, response, respondedAt: now }, { actor: "you" });
    if (!block) return { ok: false };
    const task = await this.store.get("task", block.taskId);

    if (response === "on-it") {
      const confirmed = (await this.store.getKv<string[]>("confirmedBlocks")) ?? [];
      await this.store.setKv("confirmedBlocks", [...confirmed.slice(-50), blockId]);
      if (task && task.status === "todo") await this.store.update("task", task.id, { status: "doing" }, { actor: "you", reason: "Started" });
    } else if (response === "snooze" && task) {
      await this.store.update("task", task.id, { earliestStart: new Date(Date.now() + 30 * 60_000).toISOString() }, { actor: "you", reason: "Snoozed 30m" });
    } else if ((response === "done" || response === "partial") && task) {
      const minutesSpent = extra.minutesSpent ?? Math.round((Math.min(Date.now(), ms(block.end)) - ms(block.start)) / 60_000);
      const next = recordProgress(task, { minutesSpent, fractionDone: extra.fractionDone, finished: response === "done" });
      await this.store.update("task", task.id, next, { actor: "you", reason: response === "done" ? "Done" : "Progress" });
    }
    // "doing-other": nothing to record — re-flow moves the work to another slot.
    await this.planner.replan();
    return { ok: true };
  }
}
