import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { z } from "zod";
import { newId, type AreaKind, type CalEvent, type DayMode, type Task } from "@life/core";
import { fmtMins, recordProgress, remainingMinutes } from "@life/scheduler";
import type { MemoryStore } from "../memory";
import type { Planner } from "../planner";
import type { Store } from "../store";

export interface ToolContext {
  store: Store;
  planner: Planner;
  memory: MemoryStore;
  batchId: string;
  actor: "you" | "assistant" | "connector";
  /** When true, mutations go to the Review queue instead of being applied. */
  propose: boolean;
  source: Task["source"];
  /** Set by mutating tools so the caller knows to re-plan. */
  mutated: boolean;
}

interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  mutates: boolean;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

const area = z.enum(["uni", "work", "social", "personal", "admin", "health"]);
const isoDT = z.string().describe("ISO-8601 datetime with timezone offset, e.g. 2026-11-28T23:55:00+11:00");

function tool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

async function zone(ctx: ToolContext) {
  return (await ctx.store.prefs()).timezone;
}

function who(ctx: ToolContext, reason?: string) {
  return { actor: ctx.actor, batchId: ctx.batchId, propose: ctx.propose, reason } as const;
}

function compactTask(t: Task, prefs?: Parameters<typeof remainingMinutes>[1]) {
  return {
    id: t.id,
    title: t.title,
    area: t.area,
    status: t.status,
    left: fmtMins(remainingMinutes(t, prefs)),
    ...(t.due ? { due: t.due } : {}),
    ...(t.projectId ? { projectId: t.projectId } : {}),
    ...(t.progress ? { progress: Math.round(t.progress * 100) + "%" } : {}),
    ...(t.waitingOn ? { waitingOn: t.waitingOn } : {}),
    ...(t.parentId ? { parentId: t.parentId } : {}),
  };
}

export const tools = [
  tool({
    name: "get_overview",
    description:
      "Get the current picture: today's list (now/must/should/could/waiting/tentative), upcoming deadlines, active projects, open questions and plan conflicts. Call this first when you need context.",
    schema: z.object({}),
    mutates: false,
    async run(_a, ctx) {
      const today = await ctx.planner.today();
      const [tasks, projects, prefs, dayModes] = await Promise.all([
        ctx.store.list("task"),
        ctx.store.list("project"),
        ctx.store.prefs(),
        ctx.store.dayModes(),
      ]);
      const upcoming = tasks
        .filter((t) => t.due && (t.status === "todo" || t.status === "doing"))
        .sort((a, b) => a.due!.localeCompare(b.due!))
        .slice(0, 12)
        .map((t) => compactTask(t, prefs));
      const pick = (items: { title: string; why?: string; timeLabel?: string; taskId?: string; eventId?: string }[]) =>
        items.map((i) => ({ title: i.title, id: i.taskId ?? i.eventId, when: i.timeLabel, why: i.why }));
      return {
        now: today.now ? pick([today.now])[0] : null,
        must: pick(today.must),
        should: pick(today.should),
        could: pick(today.could),
        waiting: pick(today.waiting),
        tentative: pick(today.tentative),
        conflicts: today.conflicts.map((c) => ({ message: c.message, options: c.options })),
        upcomingDeadlines: upcoming,
        projects: projects.filter((p) => p.status === "active").map((p) => ({ id: p.id, title: p.title, area: p.area, stage: p.stage })),
        focus: prefs.focus,
        dayModes,
      };
    },
  }),
  tool({
    name: "list_tasks",
    description: "Search tasks. Filters are optional.",
    schema: z.object({
      status: z.enum(["todo", "doing", "waiting", "done", "dropped", "open"]).optional().describe("'open' = todo|doing|waiting"),
      area: area.optional(),
      projectId: z.string().optional(),
      search: z.string().optional(),
    }),
    mutates: false,
    async run(a, ctx) {
      const prefs = await ctx.store.prefs();
      let tasks = await ctx.store.list("task");
      if (a.status === "open") tasks = tasks.filter((t) => ["todo", "doing", "waiting"].includes(t.status));
      else if (a.status) tasks = tasks.filter((t) => t.status === a.status);
      if (a.area) tasks = tasks.filter((t) => t.area === a.area);
      if (a.projectId) tasks = tasks.filter((t) => t.projectId === a.projectId);
      if (a.search) {
        const q = a.search.toLowerCase();
        tasks = tasks.filter((t) => t.title.toLowerCase().includes(q) || t.notes?.toLowerCase().includes(q));
      }
      return tasks.slice(0, 50).map((t) => compactTask(t, prefs));
    },
  }),
  tool({
    name: "add_task",
    description:
      "Add a task. Write the title as a concrete action starting with a verb ('Draft intro paragraph for A2', not 'assignment'). Give a realistic estimate. Use status 'waiting' + waitingOn for things someone else owes the user.",
    schema: z.object({
      title: z.string(),
      area,
      estimateMinutes: z.number().int().min(5).max(6000),
      due: isoDT.optional(),
      earliestStart: isoDT.optional(),
      projectId: z.string().optional(),
      importance: z.number().int().min(1).max(5).optional(),
      energy: z.enum(["low", "medium", "high"]).optional(),
      doneWhen: z.string().optional(),
      mustToday: z.boolean().optional().describe("User said this has to happen today"),
      status: z.enum(["todo", "waiting"]).optional(),
      waitingOn: z.string().optional(),
      sourceUrl: z.string().optional(),
      notes: z.string().optional(),
    }),
    mutates: true,
    async run(a, ctx) {
      const tz = await zone(ctx);
      const { mustToday, ...rest } = a;
      const t: Task = {
        id: newId("tsk_"),
        ...rest,
        status: a.status ?? "todo",
        source: ctx.source,
        createdAt: new Date().toISOString(),
        ...(mustToday ? { mustToday: DateTime.now().setZone(tz).toISODate()! } : {}),
      };
      await ctx.store.create("task", t, who(ctx, "Added"));
      return { ok: true, id: t.id, proposed: ctx.propose };
    },
  }),
  tool({
    name: "update_task",
    description: "Change fields on a task (title, due, estimate, importance, status, project, waitingOn, notes...).",
    schema: z.object({
      id: z.string(),
      title: z.string().optional(),
      area: area.optional(),
      estimateMinutes: z.number().int().min(5).max(6000).optional(),
      remainingMinutes: z.number().int().min(0).optional(),
      due: isoDT.nullable().optional().describe("null clears the due date"),
      earliestStart: isoDT.nullable().optional(),
      projectId: z.string().nullable().optional(),
      importance: z.number().int().min(1).max(5).optional(),
      energy: z.enum(["low", "medium", "high"]).optional(),
      status: z.enum(["todo", "doing", "waiting", "done", "dropped"]).optional(),
      waitingOn: z.string().nullable().optional(),
      doneWhen: z.string().optional(),
      notes: z.string().optional(),
    }),
    mutates: true,
    async run({ id, ...patch }, ctx) {
      const clean = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === null ? undefined : v])) as Partial<Task>;
      const c = await ctx.store.update("task", id, clean, who(ctx, "Updated"));
      return c ? { ok: true } : { ok: false, error: "No task with that id" };
    },
  }),
  tool({
    name: "complete_task",
    description: "Mark a task done. Optionally record how long it actually took (improves future estimates).",
    schema: z.object({ id: z.string(), minutesSpent: z.number().int().min(0).optional() }),
    mutates: true,
    async run(a, ctx) {
      const t = await ctx.store.get("task", a.id);
      if (!t) return { ok: false, error: "No task with that id" };
      const next = recordProgress(t, { minutesSpent: a.minutesSpent ?? 0, finished: true });
      await ctx.store.update("task", a.id, next, who(ctx, "Done"));
      await completeParentIfFinished(t, ctx);
      return { ok: true };
    },
  }),
  tool({
    name: "log_progress",
    description: "Record partial progress ('did 30 of 90 min', 'about half done'). Remaining time is re-estimated.",
    schema: z.object({
      id: z.string(),
      minutesSpent: z.number().int().min(0),
      fractionDone: z.number().min(0).max(1).optional().describe("User's sense of how complete it is, 0..1"),
    }),
    mutates: true,
    async run(a, ctx) {
      const t = await ctx.store.get("task", a.id);
      if (!t) return { ok: false, error: "No task with that id" };
      const next = recordProgress(t, { minutesSpent: a.minutesSpent, fractionDone: a.fractionDone });
      await ctx.store.update("task", a.id, next, who(ctx, "Progress logged"));
      return { ok: true, remaining: fmtMins(remainingMinutes(next)) };
    },
  }),
  tool({
    name: "defer_task",
    description: "Push a task out of the plan until a date ('not today', 'next week'). Nothing is lost.",
    schema: z.object({ id: z.string(), until: z.union([z.enum(["tomorrow", "next-week"]), isoDT]) }),
    mutates: true,
    async run(a, ctx) {
      const tz = await zone(ctx);
      const base = DateTime.now().setZone(tz).startOf("day");
      const until =
        a.until === "tomorrow" ? base.plus({ days: 1 }).toISO()! : a.until === "next-week" ? base.plus({ weeks: 1 }).startOf("week").toISO()! : a.until;
      const t = await ctx.store.get("task", a.id);
      if (!t) return { ok: false, error: "No task with that id" };
      await ctx.store.update("task", a.id, { deferredUntil: until, notes: `${t.notes ?? ""} [skipped]`.trim() }, who(ctx, `Deferred until ${until}`));
      return { ok: true, until };
    },
  }),
  tool({
    name: "break_down_task",
    description:
      "Split a task into concrete steps of 25–90 minutes, each with a clear 'done when'. If the user is stuck starting, make the first step a 10-minute starter. Steps inherit the parent's area, project and due date.",
    schema: z.object({
      id: z.string(),
      steps: z
        .array(z.object({ title: z.string(), estimateMinutes: z.number().int().min(5).max(240), doneWhen: z.string().optional(), energy: z.enum(["low", "medium", "high"]).optional() }))
        .min(2)
        .max(12),
    }),
    mutates: true,
    async run(a, ctx) {
      const parent = await ctx.store.get("task", a.id);
      if (!parent) return { ok: false, error: "No task with that id" };
      const ids: string[] = [];
      let rank = 0;
      for (const s of a.steps) {
        const child: Task = {
          id: newId("tsk_"),
          title: s.title,
          area: parent.area,
          projectId: parent.projectId,
          parentId: parent.id,
          status: "todo",
          estimateMinutes: s.estimateMinutes,
          doneWhen: s.doneWhen,
          energy: s.energy ?? parent.energy,
          due: parent.due,
          importance: parent.importance,
          source: parent.source,
          sourceUrl: parent.sourceUrl,
          createdAt: new Date().toISOString(),
          manualRank: parent.manualRank !== undefined ? parent.manualRank + rank++ / 100 : undefined,
        };
        await ctx.store.create("task", child, who(ctx, `Step of "${parent.title}"`));
        ids.push(child.id);
      }
      // Parent becomes a container: its time now lives in the steps.
      await ctx.store.update("task", parent.id, { remainingMinutes: 0, status: "doing", notes: `${parent.notes ?? ""} Split into ${a.steps.length} steps.`.trim() }, who(ctx, "Broken down"));
      return { ok: true, stepIds: ids };
    },
  }),
  tool({
    name: "add_project",
    description: "Add a project (personal project, uni unit, team project). Stages describe its phases.",
    schema: z.object({ title: z.string(), area, stage: z.string().optional(), stages: z.array(z.string()).optional(), notes: z.string().optional() }),
    mutates: true,
    async run(a, ctx) {
      const p = { id: newId("prj_"), ...a, status: "active" as const, source: ctx.source };
      await ctx.store.create("project", p, who(ctx, "Added project"));
      return { ok: true, id: p.id };
    },
  }),
  tool({
    name: "update_project",
    description: "Update a project's stage, status (active/paused/done) or notes.",
    schema: z.object({ id: z.string(), title: z.string().optional(), stage: z.string().optional(), stages: z.array(z.string()).optional(), status: z.enum(["active", "paused", "done"]).optional(), notes: z.string().optional() }),
    mutates: true,
    async run({ id, ...patch }, ctx) {
      const c = await ctx.store.update("project", id, patch, who(ctx, "Updated project"));
      return c ? { ok: true } : { ok: false, error: "No project with that id" };
    },
  }),
  tool({
    name: "add_event",
    description:
      "Add a calendar event. Defaults: lock 'flexible' for things that can move (gym, admin), 'soft' for plans with other people (ask before moving). Only use lock 'hard' if the user explicitly said it can't move, or it's an exam/rostered shift. Use certainty 'maybe' for unconfirmed plans and 'unknown-time' (with `day`) when the day is known but not the time — never invent a time.",
    schema: z.object({
      title: z.string(),
      start: isoDT.optional(),
      end: isoDT.optional(),
      day: z.string().optional().describe("YYYY-MM-DD, for unknown-time events"),
      lock: z.enum(["hard", "soft", "flexible"]).optional(),
      certainty: z.enum(["confirmed", "likely", "maybe", "unknown-time"]),
      area: area.optional(),
      location: z.string().optional(),
      notes: z.string().optional(),
    }),
    mutates: true,
    async run(a, ctx) {
      const tz = await zone(ctx);
      let { start, end } = a;
      if (!start && a.day) {
        start = DateTime.fromISO(a.day, { zone: tz }).set({ hour: 12 }).toISO()!;
        end = DateTime.fromISO(a.day, { zone: tz }).set({ hour: 13 }).toISO()!;
      }
      if (!start) return { ok: false, error: "Need start or day" };
      end ??= DateTime.fromISO(start).plus({ hours: 1 }).toISO()!;
      const e: CalEvent = {
        id: newId("evt_"),
        title: a.title,
        start,
        end,
        day: a.day,
        lock: a.lock ?? "soft",
        certainty: a.certainty,
        area: a.area as AreaKind | undefined,
        location: a.location,
        notes: a.notes,
        source: ctx.source,
      };
      await ctx.store.create("event", e, who(ctx, "Added event"));
      return { ok: true, id: e.id, proposed: ctx.propose };
    },
  }),
  tool({
    name: "update_event",
    description: "Change an event (time, certainty, lock, title). Use when plans change or get confirmed.",
    schema: z.object({
      id: z.string(),
      title: z.string().optional(),
      start: isoDT.optional(),
      end: isoDT.optional(),
      lock: z.enum(["hard", "soft", "flexible"]).optional(),
      certainty: z.enum(["confirmed", "likely", "maybe", "unknown-time"]).optional(),
      location: z.string().optional(),
      notes: z.string().optional(),
    }),
    mutates: true,
    async run({ id, ...patch }, ctx) {
      const c = await ctx.store.update("event", id, patch, who(ctx, "Event changed"));
      return c ? { ok: true } : { ok: false, error: "No event with that id" };
    },
  }),
  tool({
    name: "remove_event",
    description: "Remove a cancelled event.",
    schema: z.object({ id: z.string() }),
    mutates: true,
    async run(a, ctx) {
      const c = await ctx.store.remove("event", a.id, who(ctx, "Cancelled"));
      return c ? { ok: true } : { ok: false, error: "No event with that id" };
    },
  }),
  tool({
    name: "list_events",
    description: "List events between two dates (default: next 7 days).",
    schema: z.object({ from: isoDT.optional(), to: isoDT.optional() }),
    mutates: false,
    async run(a, ctx) {
      const from = a.from ? Date.parse(a.from) : Date.now() - 3600_000;
      const to = a.to ? Date.parse(a.to) : Date.now() + 7 * 86_400_000;
      const events = await ctx.store.list("event");
      return events
        .filter((e) => Date.parse(e.end) >= from && Date.parse(e.start) <= to)
        .sort((x, y) => x.start.localeCompare(y.start))
        .map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, lock: e.lock, certainty: e.certainty }));
    },
  }),
  tool({
    name: "set_day_mode",
    description: "Set how a day is going: normal, low-energy, sick, busy (unexpectedly), free. Changes how much gets planned.",
    schema: z.object({ date: z.string().optional().describe("YYYY-MM-DD, default today"), mode: z.enum(["normal", "low-energy", "sick", "busy", "free"]) }),
    mutates: true,
    async run(a, ctx) {
      const tz = await zone(ctx);
      const date = a.date ?? DateTime.now().setZone(tz).toISODate()!;
      await ctx.store.setDayMode(date, a.mode as DayMode, who(ctx, "Day mode"));
      return { ok: true, date, mode: a.mode };
    },
  }),
  tool({
    name: "set_focus",
    description:
      "Set what to focus on. key = an area (uni, work, social, personal, admin, health) or a project id. weight: 1 = strong focus, 0.5 = some, 0 = clear, -0.5 = de-emphasise.",
    schema: z.object({ key: z.string(), weight: z.number().min(-0.9).max(2) }),
    mutates: true,
    async run(a, ctx) {
      const prefs = await ctx.store.prefs();
      const focus = { ...prefs.focus };
      if (a.weight === 0) delete focus[a.key];
      else focus[a.key] = a.weight;
      await ctx.store.setPrefs({ focus }, who(ctx, "Focus"));
      ctx.mutated = true;
      return { ok: true, focus };
    },
  }),
  tool({
    name: "ask_question",
    description:
      "Record something ambiguous you need the user to confirm later (e.g. 'What time is the catch-up with Sam?'). Use instead of guessing. relevantBy = when the answer starts to matter.",
    schema: z.object({ question: z.string(), context: z.string().optional(), relevantBy: isoDT.optional(), options: z.array(z.string()).optional(), relatedId: z.string().optional() }),
    mutates: true,
    async run(a, ctx) {
      const q = { id: newId("q_"), ...a, source: ctx.source, status: "open" as const, createdAt: new Date().toISOString() };
      await ctx.store.create("question", q, { ...who(ctx, "Question"), propose: false });
      return { ok: true, id: q.id };
    },
  }),
  tool({
    name: "answer_question",
    description: "Mark an open question as answered (then apply the answer with other tools).",
    schema: z.object({ id: z.string(), answer: z.string() }),
    mutates: true,
    async run(a, ctx) {
      const c = await ctx.store.update("question", a.id, { status: "answered", answer: a.answer }, who(ctx, "Answered"));
      return c ? { ok: true } : { ok: false };
    },
  }),
  tool({
    name: "remember",
    description:
      "Save a durable fact about the user's life to long-term memory: people (who Sam is), preferences ('does deep work best before noon'), project state, recurring patterns. Don't save transient details.",
    schema: z.object({
      subject: z.string().describe("Who/what it's about, e.g. 'Sam Lee' or 'Robot arm project'"),
      kind: z.string().describe("person, organisation, project, preference, habit, place, ..."),
      text: z.string(),
      type: z.enum(["world", "experience", "observation"]).optional(),
    }),
    mutates: false,
    async run(a, ctx) {
      await ctx.memory.remember(a);
      return { ok: true };
    },
  }),
  tool({
    name: "recall",
    description: "Look up long-term memory about people, projects, preferences and past decisions.",
    schema: z.object({ query: z.string() }),
    mutates: false,
    async run(a, ctx) {
      return ctx.memory.recall(a.query, { maxTokens: 1200, limit: 10 });
    },
  }),
  tool({
    name: "undo_last_turn",
    description: "Undo everything changed in the previous assistant turn ('undo that').",
    schema: z.object({}),
    mutates: true,
    async run(_a, ctx) {
      const batch = await ctx.store.lastChatBatch();
      if (!batch) return { ok: false, error: "Nothing to undo" };
      const n = await ctx.store.revertBatch(batch);
      return { ok: true, reverted: n };
    },
  }),
];

async function completeParentIfFinished(t: Task, ctx: ToolContext) {
  if (!t.parentId) return;
  const siblings = (await ctx.store.list("task")).filter((x) => x.parentId === t.parentId);
  if (siblings.every((s) => s.status === "done" || s.status === "dropped")) {
    await ctx.store.update("task", t.parentId, { status: "done", completedAt: new Date().toISOString() }, who(ctx, "All steps done"));
  }
}

export type AnyTool = (typeof tools)[number];

export function toolsFor(names?: string[]): AnyTool[] {
  return names ? tools.filter((t) => names.includes(t.name)) : tools;
}

/** Anthropic tool definitions (deterministic order so the prompt prefix caches). */
export function anthropicTools(list: AnyTool[]): Anthropic.Beta.BetaTool[] {
  return list.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.schema, { target: "draft-7" }) as Anthropic.Beta.BetaTool["input_schema"],
  }));
}

/** Validate input against the tool's schema and run it. Errors come back as tool errors, not crashes. */
export async function runTool(list: AnyTool[], name: string, input: unknown, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
  const t = list.find((x) => x.name === name);
  if (!t) return { content: `Unknown tool ${name}`, isError: true };
  const parsed = (t.schema as z.ZodTypeAny).safeParse(input ?? {});
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (t.run as any)(parsed.data, ctx);
    if (t.mutates) ctx.mutated = true;
    return { content: JSON.stringify(out), isError: false };
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true };
  }
}
