import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, createServices, type Services } from "../src/app";
import { prefilter } from "../src/agent/triage";
import { runTool, toolsFor, type ToolContext } from "../src/agent/tools";
import { isRelevant } from "../src/connectors/discord";
import { moodleTaskFrom, occurrences, syncFeed, type Feed } from "../src/connectors/ical";
import { defaultNotionConfig, pageToTask, syncNotion, type NotionConfig } from "../src/connectors/notion";
import { costOf } from "../src/llm/provider";
import { openDb } from "../src/db";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

let s: Services;
let app: FastifyInstance;

beforeEach(async () => {
  const db = await openDb({ memory: true });
  s = createServices(db);
  await s.store.setPrefs({ timezone: "Australia/Melbourne" }, { actor: "system" });
  app = await buildApp(s);
});

function ctx(): ToolContext {
  return { store: s.store, planner: s.planner, memory: s.memory, batchId: "b1", actor: "assistant", propose: false, source: "chat", mutated: false };
}

describe("iCal import", () => {
  it("turns Moodle deadlines into uni tasks and ignores 'opens' events", async () => {
    const feed: Feed = { id: "f1", name: "Moodle", url: "x", kind: "moodle", lock: "soft" };
    const r = await syncFeed(s.store, feed, { text: fixture("moodle.ics"), now: new Date("2026-11-21T00:00:00Z") });
    expect(r.created).toBe(2);
    const tasks = await s.store.list("task");
    expect(tasks.map((t) => t.title).sort()).toEqual(["Do Week 12 Quiz", "Finish FIT2004 Assignment 2"]);
    expect(tasks.every((t) => t.area === "uni" && t.source === "moodle" && t.due)).toBe(true);
    // Idempotent: re-sync creates nothing new.
    const again = await syncFeed(s.store, feed, { text: fixture("moodle.ics"), now: new Date("2026-11-21T00:00:00Z") });
    expect(again.created).toBe(0);
  });

  it("expands recurring timetable classes with the feed's lock", async () => {
    const feed: Feed = { id: "f2", name: "Timetable", url: "x", kind: "timetable", lock: "hard" };
    await syncFeed(s.store, feed, { text: fixture("timetable.ics"), now: new Date("2026-11-21T00:00:00Z") });
    const events = await s.store.list("event");
    expect(events.filter((e) => e.title === "FIT2004 Lecture")).toHaveLength(4);
    expect(events.every((e) => e.lock === "hard")).toBe(true);
  });

  it("classifies Moodle summaries", () => {
    const o = occurrences(fixture("moodle.ics"), new Date("2026-11-01"), new Date("2026-12-31"));
    expect(o).toHaveLength(3);
    expect(moodleTaskFrom({ ...o[0], summary: "Final exam" })?.title).toMatch(/Revise/);
  });
});

describe("Notion & Discord", () => {
  const cfg: NotionConfig = { ...defaultNotionConfig, databaseId: "db", me: "Oscar" };
  const page = (id: string, assignee: string, status = "In progress") => ({
    id,
    url: `https://notion.so/${id}`,
    last_edited_time: "2026-11-20T00:00:00Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: "Write motor driver test plan" }] },
      Assignee: { type: "people", people: [{ id: "u1", name: assignee }] },
      Status: { type: "status", status: { name: status } },
      Due: { type: "date", date: { start: "2026-11-27" } },
    },
  });

  it("imports only action items assigned to you", async () => {
    await s.store.setKv("notion", cfg);
    const r = await syncNotion(s.store, [page("p1", "Oscar Smith"), page("p2", "Alex")] as never);
    expect(r).toMatchObject({ created: 1 });
    const t = (await s.store.list("task"))[0];
    expect(t).toMatchObject({ source: "notion", title: "Write motor driver test plan", sourceUrl: "https://notion.so/p1" });
    // Marked done in Notion → done here.
    await syncNotion(s.store, [page("p1", "Oscar Smith", "Done")] as never);
    expect((await s.store.get("task", t.id))!.status).toBe("done");
  });

  it("maps Notion pages", () => {
    expect(pageToTask(page("p3", "Alex") as never, cfg).mine).toBe(false);
  });

  it("filters Discord messages for relevance", () => {
    const d = { channels: ["c"], myUserId: "me", myNames: ["oscar"], digestMinutes: 30 };
    expect(isRelevant("lol nice", false, d)).toBe(false);
    expect(isRelevant("anything", true, d)).toBe(true);
    expect(isRelevant("Oscar can you push the CAD by Friday", false, d)).toBe(true);
    expect(isRelevant("team we need someone to book the lab by tomorrow", false, d)).toBe(true);
  });

  it("prefilters noisy email before any LLM call", () => {
    expect(prefilter({ title: "50% off everything", body: "unsubscribe here" })).toBe(false);
    expect(prefilter({ title: "Assignment 2 extension", body: "due date moved; unsubscribe" })).toBe(true);
  });
});

describe("tool layer", () => {
  it("adds a task, breaks it down, and completes the parent when steps are done", async () => {
    const add = await runTool(toolsFor(), "add_task", { title: "Write lab report", area: "uni", estimateMinutes: 240, due: "2026-11-30T17:00:00+11:00" }, ctx());
    const { id } = JSON.parse(add.content);
    const br = await runTool(
      toolsFor(),
      "break_down_task",
      { id, steps: [{ title: "Open the template (10 min starter)", estimateMinutes: 10 }, { title: "Write methods section", estimateMinutes: 60 }] },
      ctx(),
    );
    const { stepIds } = JSON.parse(br.content);
    expect(stepIds).toHaveLength(2);
    for (const sid of stepIds) await runTool(toolsFor(), "complete_task", { id: sid }, ctx());
    expect((await s.store.get("task", id))!.status).toBe("done");
  });

  it("rejects invalid tool input without throwing", async () => {
    const r = await runTool(toolsFor(), "add_task", { title: "x" }, ctx());
    expect(r.isError).toBe(true);
  });

  it("proposed changes wait for review and can be accepted", async () => {
    const c = { ...ctx(), propose: true, batchId: "tri1" };
    await runTool(toolsFor(), "add_event", { title: "Dinner with Sam", start: "2026-11-28T19:00:00+11:00", certainty: "maybe" }, c);
    expect(await s.store.list("event")).toHaveLength(0);
    expect(await s.store.acceptBatch("tri1")).toBe(1);
    expect((await s.store.list("event"))[0]).toMatchObject({ title: "Dinner with Sam", certainty: "maybe", lock: "soft" });
  });
});

describe("HTTP API", () => {
  it("today → add → done → undo round-trip", async () => {
    const created = await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "Email tutor about extension", area: "uni", estimateMinutes: 15 } });
    const task = created.json();
    let today = (await app.inject({ method: "GET", url: "/api/today" })).json();
    expect(today.could.map((i: { taskId: string }) => i.taskId)).toContain(task.id);

    const done = (await app.inject({ method: "POST", url: `/api/tasks/${task.id}/done`, payload: {} })).json();
    expect((await s.store.get("task", task.id))!.status).toBe("done");
    await app.inject({ method: "POST", url: `/api/changes/${done.changeId}/revert` });
    expect((await s.store.get("task", task.id))!.status).toBe("todo");
    today = (await app.inject({ method: "GET", url: "/api/today" })).json();
    expect(today).toHaveProperty("must");
  });

  it("day mode and reorder re-flow the plan", async () => {
    for (const title of ["A", "B"]) {
      await app.inject({ method: "POST", url: "/api/tasks", payload: { title, area: "personal", estimateMinutes: 60 } });
    }
    const tasks = await s.store.list("task");
    await app.inject({ method: "POST", url: "/api/tasks/reorder", payload: { ids: [tasks[1].id, tasks[0].id] } });
    expect((await s.store.get("task", tasks[1].id))!.manualRank).toBe(0);
    const r = await app.inject({ method: "POST", url: "/api/daymode", payload: { mode: "sick" } });
    expect(r.statusCode).toBe(200);
    const plan = (await app.inject({ method: "GET", url: "/api/plan" })).json();
    expect(plan.days[0].mode).toBe("sick");
  });

  it("weekly review is a flexible event and its steps are resumable", async () => {
    await s.review.ensureEvent();
    const ev = (await s.store.list("event")).find((e) => e.title === "Weekly admin hour");
    if (ev) expect(ev).toMatchObject({ lock: "flexible", shortVersionMinutes: 15 });
    await app.inject({ method: "POST", url: "/api/review/step", payload: { step: "screenshots", outcome: "skipped", short: true } });
    const data = (await app.inject({ method: "GET", url: "/api/review" })).json();
    expect(data.state.steps.screenshots).toBe("skipped");
    expect(data.steps).toEqual(["screenshots", "inbox", "commit"]);
  });

  it("chat explains how to enable AI when no key is set", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const r = (await app.inject({ method: "POST", url: "/api/chat", payload: { message: "hi" } })).json();
    expect(r.reply).toMatch(/ANTHROPIC_API_KEY/);
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });
});

describe("cost accounting", () => {
  it("prices cache reads at a tenth of input", () => {
    const full = costOf("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 } as never);
    const cached = costOf("claude-sonnet-5-5", { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 } as never);
    expect(full).toBeCloseTo(2);
    expect(cached).toBeCloseTo(0.2);
  });
});
