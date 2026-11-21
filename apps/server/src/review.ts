import { DateTime } from "luxon";
import { newId, type CalEvent } from "@life/core";
import { ms } from "@life/scheduler";
import type { Planner } from "./planner";
import type { Store } from "./store";

export const REVIEW_STEPS = ["screenshots", "inbox", "projects", "uni", "week", "memory", "commit"] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];
export const SHORT_STEPS: ReviewStep[] = ["screenshots", "inbox", "commit"];

export interface ReviewState {
  week: string; // ISO week, e.g. 2026-W48
  startedAt?: string;
  short: boolean;
  steps: Partial<Record<ReviewStep, "done" | "skipped" | "nothing">>;
  completedAt?: string;
}

/**
 * The weekly admin hour: a guided, resumable, skippable flow. It's a *flexible* event — the
 * scheduler moves it around your week, offers the short version when the week is busy, and
 * nothing breaks if it's missed (the next one covers both weeks).
 */
export class WeeklyReview {
  constructor(
    private store: Store,
    private planner: Planner,
  ) {}

  private async weekKey() {
    const tz = (await this.store.prefs()).timezone;
    const now = DateTime.now().setZone(tz);
    return { tz, now, key: `${now.weekYear}-W${String(now.weekNumber).padStart(2, "0")}` };
  }

  /** Make sure this week's review exists as a flexible calendar event (Sunday afternoon by default). */
  async ensureEvent(preferred = { weekday: 7, hour: 16 }) {
    const { tz, now, key } = await this.weekKey();
    const events = await this.store.list("event");
    if (events.some((e) => e.externalId === `review:${key}`)) return;
    const start = now.set({ weekday: preferred.weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7, hour: preferred.hour, minute: 0, second: 0, millisecond: 0 });
    if (start.plus({ days: 2 }) < now) return; // too late for this week's
    const e: CalEvent = {
      id: newId("evt_"),
      title: "Weekly admin hour",
      start: start.toISO()!,
      end: start.plus({ hours: 1 }).toISO()!,
      lock: "flexible",
      certainty: "confirmed",
      area: "admin",
      source: "system",
      externalId: `review:${key}`,
      shortVersionMinutes: 15,
      // May move from Saturday morning to Tuesday evening.
      window: { earliest: start.set({ weekday: 6, hour: 9 }).toISO()!, latest: start.plus({ days: 2 }).set({ hour: 21 }).toISO()! },
      notes: "Guided weekly review. Skippable, resumable; there's a 15-minute short version.",
    };
    void tz;
    await this.store.create("event", e, { actor: "system", reason: "Weekly review" });
  }

  async state(): Promise<ReviewState> {
    const { key } = await this.weekKey();
    return (await this.store.getKv<ReviewState>(`review:${key}`)) ?? { week: key, short: false, steps: {} };
  }

  async mark(step: ReviewStep, outcome: "done" | "skipped" | "nothing", opts: { short?: boolean } = {}) {
    const s = await this.state();
    s.startedAt ??= new Date().toISOString();
    if (opts.short !== undefined) s.short = opts.short;
    s.steps[step] = outcome;
    if (step === "commit") {
      s.completedAt = new Date().toISOString();
      await this.planner.replan({ reason: "weekly review" });
    }
    const { key } = await this.weekKey();
    await this.store.setKv(`review:${key}`, s);
    return s;
  }

  /** Data for every step, in one call (the app renders cards from this). */
  async data() {
    const state = await this.state();
    const [tasks, projects, signals, proposed, plan, memories, questions] = await Promise.all([
      this.store.list("task"),
      this.store.list("project"),
      this.store.list("signal"),
      this.store.listChanges({ status: "proposed", limit: 200 }),
      this.planner.current(),
      this.store.list("memory"),
      this.store.list("question"),
    ]);
    const weekAgo = Date.now() - 7 * 86_400_000;
    const in3Weeks = Date.now() + 21 * 86_400_000;
    const lastReview = state.completedAt ? ms(state.completedAt) : weekAgo;
    return {
      state,
      steps: state.short ? SHORT_STEPS : REVIEW_STEPS,
      screenshots: {
        prompts: [
          "Group chats or DMs where plans were made (Messenger, Instagram, iMessage, WhatsApp)",
          "Your shift roster for the next fortnight",
          "Anything else with a date on it (posters, emails on another device)",
        ],
      },
      inbox: {
        proposed,
        signals: signals.filter((s) => s.status === "needs-review" || (s.status === "new" && ms(s.receivedAt) > Math.min(lastReview, weekAgo))),
        questions: questions.filter((q) => q.status === "open"),
      },
      projects: projects
        .filter((p) => p.status !== "done")
        .map((p) => {
          const pt = tasks.filter((t) => t.projectId === p.id);
          return {
            ...p,
            doneThisWeek: pt.filter((t) => t.completedAt && ms(t.completedAt) > weekAgo).map((t) => t.title),
            open: pt.filter((t) => t.status === "todo" || t.status === "doing").map((t) => ({ id: t.id, title: t.title })),
          };
        }),
      uni: tasks
        .filter((t) => t.area === "uni" && t.due && ms(t.due) < in3Weeks && t.status !== "done" && t.status !== "dropped")
        .sort((a, b) => a.due!.localeCompare(b.due!))
        .map((t) => ({ id: t.id, title: t.title, due: t.due, progress: t.progress ?? 0, plannedMinutes: plan.blocks.filter((b) => b.taskId === t.id).reduce((s, b) => s + (ms(b.end) - ms(b.start)) / 60_000, 0) })),
      week: { days: plan.days.slice(0, 7), conflicts: plan.conflicts },
      memory: memories.filter((m) => ms(m.at) > weekAgo).map((m) => ({ id: m.id, subject: m.subject, text: m.text })),
    };
  }
}
