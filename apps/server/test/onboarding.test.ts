import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, createServices, type Services } from "../src/app";
import { syncFeed } from "../src/connectors/ical";
import { defaultNotionConfig, syncNotion, type NotionConfig } from "../src/connectors/notion";
import { openDb } from "../src/db";

const roster = readFileSync(new URL("./fixtures/humanforce-roster.ics", import.meta.url), "utf8");
let s: Services;
let app: FastifyInstance;

beforeEach(async () => {
  s = createServices(await openDb({ memory: true }));
  await s.store.setPrefs({ timezone: "Australia/Melbourne" }, { actor: "system" });
  app = await buildApp(s);
});

const page = (id: string, title: string, status: string, due: string, team = "team1") => ({
  id,
  url: `https://notion.so/${id}`,
  last_edited_time: "2026-11-20T00:00:00Z",
  properties: {
    Name: { type: "title", title: [{ plain_text: title }] },
    Assignee: { type: "people", people: [{ id: "u1", name: "Oscar Veldhoven" }] },
    Status: { type: "status", status: { name: status } },
    Due: { type: "date", date: { start: due } },
    Project: { type: "relation", relation: [{ id: team }] },
  },
});

describe("Notion board tuning", () => {
  it("maps team relations to projects, Cancelled to dropped, and holds overdue items", async () => {
    const cfg: NotionConfig = { ...defaultNotionConfig, databaseId: "db", me: "Oscar", relationNames: { team1: "Executive Admin" } };
    await s.store.setKv("notion", cfg);
    const r = await syncNotion(s.store, [
      page("p1", "Leadership Nomination Form", "Not started", "2026-10-30"),
      page("p2", "Storyboards for each scene", "In progress", DateTime.now().plus({ days: 5 }).toISODate()!),
      page("p3", "Old idea", "Cancelled", "2026-12-30"),
    ] as never);
    expect(r).toMatchObject({ created: 2, overdue: 1 });
    const tasks = await s.store.list("task");
    const overdue = tasks.find((t) => t.title === "Leadership Nomination Form")!;
    expect(overdue.status).toBe("waiting");
    expect(overdue.waitingOn).toMatch(/overdue/);
    expect(tasks.find((t) => t.title === "Old idea")).toBeUndefined();
    const projects = await s.store.list("project");
    expect(projects.map((p) => p.title)).toContain("Executive Admin");
    expect(tasks.every((t) => t.projectId === projects[0].id)).toBe(true);
    // Overdue items aren't in Must; they show up for a decision in onboarding.
    const today = (await app.inject({ url: "/api/today" })).json();
    expect(today.must.map((i: { taskId?: string }) => i.taskId)).not.toContain(overdue.id);
    const ob = (await app.inject({ url: "/api/onboarding" })).json();
    const inf = ob.inferences.find((i: { kind: string }) => i.kind === "overdue");
    expect(inf.items[0]).toMatchObject({ title: "Leadership Nomination Form", project: "Executive Admin" });
    await app.inject({ method: "POST", url: "/api/onboarding/overdue", payload: { taskId: overdue.id, action: "keep" } });
    const kept = (await s.store.get("task", overdue.id))!;
    expect(kept.status).toBe("todo");
    expect(Date.parse(kept.due!)).toBeGreaterThan(Date.now());
  });
});

describe("onboarding", () => {
  it("infers your work pattern from the roster and saves it to memory when confirmed", async () => {
    await syncFeed(s.store, { id: "hf", name: "Humanforce", url: "upload:Humanforce", kind: "roster", lock: "hard" }, { text: roster, now: new Date("2026-11-20T00:00:00Z") });
    const ob = (await app.inject({ url: "/api/onboarding" })).json();
    expect(ob.banner).toBe("setup");
    expect(ob.sources.find((x: { id: string }) => x.id === "roster").ok).toBe(true);
    const work = ob.inferences.find((i: { kind: string }) => i.kind === "work-pattern");
    expect(work.text).toMatch(/Luna Park/);
    expect(work.text).toMatch(/Saturdays|Sundays/);
    await app.inject({ method: "POST", url: "/api/onboarding/verdict", payload: { id: work.id, verdict: "confirmed" } });
    const mem = (await app.inject({ url: "/api/memory" })).json();
    expect(mem.items.some((m: { text: string }) => /Luna Park/.test(m.text))).toBe(true);
    // Confirmed inferences don't come back.
    const again = (await app.inject({ url: "/api/onboarding" })).json();
    expect(again.inferences.find((i: { kind: string }) => i.kind === "work-pattern")).toBeUndefined();
  });

  it("steps are skippable, finishing clears the banner, and setup can be re-run", async () => {
    for (const step of ["connect", "inferences", "projects", "rhythm", "matters"]) {
      await app.inject({ method: "POST", url: "/api/onboarding/step", payload: { step, outcome: "skipped" } });
    }
    await app.inject({ method: "POST", url: "/api/onboarding/step", payload: { step: "plan", outcome: "done" } });
    expect((await app.inject({ url: "/api/onboarding" })).json().banner).toBeNull();
    await app.inject({ method: "POST", url: "/api/onboarding/restart" });
    expect((await app.inject({ url: "/api/onboarding" })).json().state.steps).toEqual({});
  });
});
