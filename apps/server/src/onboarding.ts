import { DateTime } from "luxon";
import type { CalEvent, Preferences, Task } from "@life/core";
import { config } from "./config";
import * as google from "./connectors/google";
import { listFeeds } from "./connectors/ical";
import type { Collectors } from "./collectors";
import type { MemoryStore } from "./memory";
import type { Planner } from "./planner";
import type { Store } from "./store";

/**
 * "Set up Life / Tune Life": a re-runnable onboarding. Life reads what's connected first, then
 * proposes what it inferred for you to confirm, fix or dismiss. Nothing here is permanent —
 * everything lands in preferences + memory and can be changed any time (Settings → About me).
 */
export const ONBOARDING_STEPS = ["connect", "inferences", "projects", "rhythm", "matters", "plan"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingState {
  steps: Partial<Record<OnboardingStep, "done" | "skipped">>;
  startedAt?: string;
  completedAt?: string;
  verdicts: Record<string, "confirmed" | "dismissed" | "edited">;
  retuneDismissedAt?: string;
}

export interface Inference {
  id: string;
  kind: "work-pattern" | "units" | "day-window" | "overdue" | "busy-days";
  text: string;
  detail?: string;
  /** What confirming it changes. */
  apply?: Partial<Pick<Preferences, "dayStart" | "dayEnd">> & { memory?: string };
  items?: { id: string; title: string; due?: string; project?: string }[];
}

export interface SourceStatus {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  setup: string;
}

export class Onboarding {
  constructor(
    private store: Store,
    private planner: Planner,
    private memory: MemoryStore,
    private collectors: Collectors,
  ) {}

  async state(): Promise<OnboardingState> {
    return (await this.store.getKv<OnboardingState>("onboarding")) ?? { steps: {}, verdicts: {} };
  }

  private async save(s: OnboardingState) {
    await this.store.setKv("onboarding", s);
  }

  async sources(): Promise<SourceStatus[]> {
    const [feeds, accounts, notion, discord, collectors, pushSubs] = await Promise.all([
      listFeeds(this.store),
      google.connectedAccounts(this.store).catch(() => [] as string[]),
      this.store.getKv<{ databaseId?: string }>("notion"),
      this.store.getKv<{ myUserId?: string }>("discord"),
      this.collectors.list(),
      this.store.getKv<unknown[]>("pushSubs"),
    ]);
    const pull = (id: string) => this.store.getKv<{ at: string }>(`pull:${id}`);
    const [moodle, instagram, tamarinSeen] = await Promise.all([pull("moodle"), pull("instagram"), this.store.getKv<string>("tamarin:lastSeen")]);
    const roster = feeds.find((f) => f.kind === "roster") ?? collectors.find((c) => c.kind === "roster");
    const shiftCount = (await this.store.list("event")).filter((e) => e.area === "work" && e.lock === "hard" && Date.parse(e.end) > Date.now()).length;
    const ago = (iso?: string) => (iso ? `last ${DateTime.fromISO(iso).toRelative()}` : "not yet");
    return [
      { id: "roster", name: "Work roster (Humanforce)", ok: Boolean(roster) || shiftCount > 0, detail: roster ? `Connected (${roster.name}) · ${shiftCount} upcoming shifts` : shiftCount ? `${shiftCount} upcoming shifts imported` : "Not connected", setup: "Settings → Auto-pulls: add the roster page with your username and password. You can also upload a roster .ics file." },
      { id: "moodle", name: "Moodle deadlines", ok: Boolean(moodle), detail: `Claude in Chrome run: ${ago(moodle?.at)}`, setup: "Set up the twice-weekly Claude in Chrome shortcut in claude/scheduled/moodle-deadlines.md" },
      { id: "timetable", name: "Class timetable", ok: feeds.some((f) => f.kind === "timetable"), detail: feeds.some((f) => f.kind === "timetable") ? "Connected" : "Not connected", setup: "Allocate+ home page → 'subscribe to your timetable' → paste the link in Settings → Calendars (kind: timetable)" },
      { id: "google-personal", name: "Personal Gmail + Calendar", ok: accounts.includes("personal"), detail: accounts.includes("personal") ? "Connected" : "Not connected", setup: "Settings → Connect personal" },
      { id: "google-uni", name: "Monash Gmail", ok: accounts.includes("uni"), detail: accounts.includes("uni") ? "Connected" : "Not connected", setup: "Settings → Connect Monash (signs in through Okta)" },
      { id: "notion", name: "Notion action items", ok: Boolean(notion?.databaseId && config.notion.token), detail: notion?.databaseId ? "Connected" : "Not connected", setup: "Settings → Team: Notion" },
      { id: "tamarin", name: "Team Discord (Tamarin)", ok: Boolean(discord?.myUserId && config.tamarinSecret), detail: tamarinSeen ? `Last message ${ago(tamarinSeen)}` : "No messages yet", setup: "Ask a Tamarin admin to add an outgoing webhook to https://<your Life domain>/api/hooks/tamarin, then fill in Settings → Team: Discord" },
      { id: "instagram", name: "Instagram DMs", ok: Boolean(instagram), detail: `Claude in Chrome run: ${ago(instagram?.at)}`, setup: "Set up the weekly shortcut in claude/scheduled/instagram-dms.md" },
      { id: "notifications", name: "Notifications", ok: Boolean(pushSubs?.length) || Boolean(config.telegram.botToken), detail: pushSubs?.length ? "Push on" : config.telegram.botToken ? "Telegram on" : "Off", setup: "Settings → Turn on notifications here (open Life from your home screen first)" },
    ];
  }

  /** What Life worked out from your data, for you to confirm, fix or dismiss. */
  async inferences(now = DateTime.now()): Promise<Inference[]> {
    const prefs = await this.store.prefs();
    const zone = prefs.timezone;
    const [events, tasks, projects] = await Promise.all([this.store.list("event"), this.store.list("task"), this.store.list("project")]);
    const state = await this.state();
    const out: Inference[] = [];
    const window = (e: CalEvent) => {
      const s = DateTime.fromISO(e.start).setZone(zone);
      return s > now.minus({ weeks: 6 }) && s < now.plus({ weeks: 6 });
    };

    // Work pattern from shifts.
    const shifts = events.filter((e) => e.area === "work" && e.lock === "hard" && window(e));
    if (shifts.length >= 3) {
      const byDay = new Map<string, number>();
      const starts: number[] = [];
      const ends: number[] = [];
      for (const e of shifts) {
        const s = DateTime.fromISO(e.start).setZone(zone);
        const en = DateTime.fromISO(e.end).setZone(zone);
        byDay.set(s.toFormat("cccc"), (byDay.get(s.toFormat("cccc")) ?? 0) + 1);
        starts.push(s.hour + s.minute / 60);
        ends.push(en.hour + en.minute / 60 + (en.day !== s.day ? 24 : 0));
      }
      const common = [...byDay.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= Math.max(2, shifts.length * 0.15))
        .map(([d]) => d)
        .sort((a, b) => WEEK.indexOf(a) - WEEK.indexOf(b))
        .map((d) => `${d}s`);
      // Most common workplace across shifts ("Luna Park · Cafe Cook" → "Luna Park"; "Shift at X" → "X").
      const places = new Map<string, number>();
      for (const e of shifts) {
        const p = e.title.split(" · ")[0].replace(/^shift (at|@)\s+/i, "").split(",")[0].trim();
        places.set(p, (places.get(p) ?? 0) + 1);
      }
      const place = [...places.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const fmt = (h: number) => DateTime.fromObject({ hour: Math.floor(h) % 24, minute: Math.round((h % 1) * 60) }).toFormat("h:mma").toLowerCase();
      out.push({
        id: "work-pattern",
        kind: "work-pattern",
        text: `You mostly work ${common.length ? common.join(", ") : "varied days"} at ${place}, usually ${fmt(median(starts))}–${fmt(median(ends))}.`,
        detail: `${shifts.length} shifts in your roster around now.`,
        apply: { memory: `Works at ${place}; usual shift days: ${common.join(", ") || "varied"}; typical shift ${fmt(median(starts))}–${fmt(median(ends))}.` },
      });
    }

    // Uni units from tasks/events.
    const unitRe = /\b([A-Z]{3}\d{4})\b/g;
    const units = new Set<string>();
    for (const t of [...tasks.map((x) => `${x.title} ${x.notes ?? ""}`), ...events.filter(window).map((x) => x.title), ...projects.map((p) => p.title)]) {
      for (const m of t.matchAll(unitRe)) units.add(m[1]);
    }
    if (units.size) {
      out.push({
        id: "units",
        kind: "units",
        text: `You're doing ${units.size} unit${units.size > 1 ? "s" : ""} this semester: ${[...units].sort().join(", ")}.`,
        apply: { memory: `Current Monash units: ${[...units].sort().join(", ")}.` },
      });
    }

    // Day window from fixed commitments.
    const fixed = events.filter((e) => e.lock === "hard" && window(e));
    if (fixed.length >= 4) {
      const earliest = Math.min(...fixed.map((e) => DateTime.fromISO(e.start).setZone(zone).hour));
      const suggestedStart = `${String(Math.max(6, Math.min(earliest, 9))).padStart(2, "0")}:00`;
      if (suggestedStart !== prefs.dayStart) {
        out.push({
          id: `day-start-${suggestedStart}`,
          kind: "day-window",
          text: `Your earliest commitments start around ${suggestedStart}. Start planning your day from ${suggestedStart}?`,
          apply: { dayStart: suggestedStart },
        });
      }
    }

    // Overdue team items held back from Today.
    const held = tasks.filter((t) => t.status === "waiting" && t.notes?.includes("[overdue-import]"));
    if (held.length) {
      out.push({
        id: "overdue",
        kind: "overdue",
        text: `${held.length} item${held.length > 1 ? "s" : ""} from Notion ${held.length > 1 ? "are" : "is"} already overdue. Keep with a new date, mark done, or drop?`,
        items: held.map((t) => ({ id: t.id, title: t.title, due: t.due, project: projects.find((p) => p.id === t.projectId)?.title })),
      });
    }

    return out.filter((i) => i.kind === "overdue" || !state.verdicts[i.id]);
  }

  async verdict(id: string, verdict: "confirmed" | "dismissed" | "edited", edit?: { text?: string; dayStart?: string; dayEnd?: string }) {
    const s = await this.state();
    const inf = (await this.inferences()).find((i) => i.id === id);
    s.verdicts[id] = verdict;
    await this.save(s);
    if (verdict === "dismissed" || !inf) return { ok: true };
    const apply = { ...inf.apply, ...(edit?.dayStart ? { dayStart: edit.dayStart } : {}), ...(edit?.dayEnd ? { dayEnd: edit.dayEnd } : {}) };
    if (apply.dayStart || apply.dayEnd) {
      await this.store.setPrefs({ ...(apply.dayStart ? { dayStart: apply.dayStart } : {}), ...(apply.dayEnd ? { dayEnd: apply.dayEnd } : {}) }, { actor: "you", reason: "Onboarding" });
    }
    const fact = edit?.text ?? apply.memory;
    if (fact) await this.memory.remember({ subject: "Me", kind: "profile", text: fact, type: "observation" });
    await this.planner.replan({ reason: "onboarding" });
    return { ok: true };
  }

  /** keep (with a new due date) / done / drop for an overdue team item. */
  async decideOverdue(taskId: string, action: "keep" | "done" | "drop", due?: string) {
    const t = await this.store.get("task", taskId);
    if (!t) return { ok: false };
    const notes = (t.notes ?? "").replace("\n[overdue-import]", "").replace("[overdue-import]", "");
    const patch: Partial<Task> =
      action === "done"
        ? { status: "done", completedAt: new Date().toISOString(), notes, waitingOn: undefined }
        : action === "drop"
          ? { status: "dropped", notes, waitingOn: undefined }
          : { status: "todo", due: due ?? DateTime.now().plus({ days: 7 }).set({ hour: 17, minute: 0 }).toISO()!, notes, waitingOn: undefined };
    await this.store.update("task", taskId, patch, { actor: "you", reason: `Overdue team item: ${action}` });
    await this.planner.replan({ reason: "onboarding" });
    return { ok: true };
  }

  async markStep(step: OnboardingStep, outcome: "done" | "skipped") {
    const s = await this.state();
    s.startedAt ??= new Date().toISOString();
    s.steps[step] = outcome;
    if (step === "plan") {
      s.completedAt = new Date().toISOString();
      const p = await this.store.prefs();
      await this.memory.remember({
        subject: "Me",
        kind: "profile",
        text: `Planning preferences: day ${p.dayStart}–${p.dayEnd}, quiet ${p.quietStart}–${p.quietEnd}, plans ${Math.round(p.capacityRatio * 100)}% of free time${
          Object.keys(p.focus).length ? `, focus: ${Object.entries(p.focus).map(([k, v]) => `${k} ${v > 0 ? "more" : "less"}`).join(", ")}` : ""
        }.`,
        type: "observation",
      });
      await this.planner.replan({ reason: "onboarding complete" });
    }
    await this.save(s);
    return s;
  }

  async restart() {
    const s = await this.state();
    await this.save({ steps: {}, verdicts: {}, startedAt: new Date().toISOString(), retuneDismissedAt: s.retuneDismissedAt });
  }

  async dismissRetune() {
    const s = await this.state();
    s.retuneDismissedAt = new Date().toISOString();
    await this.save(s);
  }

  /** Should the app show "Set up Life" or a "re-tune" card? */
  async banner(now = DateTime.now()): Promise<"setup" | "retune" | null> {
    const s = await this.state();
    if (!s.completedAt) return "setup";
    const last = DateTime.fromISO(s.retuneDismissedAt && s.retuneDismissedAt > s.completedAt ? s.retuneDismissedAt : s.completedAt);
    return now.diff(last, "days").days >= 14 ? "retune" : null;
  }
}

const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
