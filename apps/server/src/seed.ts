/**
 * Demo data so you can see the app working before connecting anything:
 *   LIFE_DATA_DIR=./data-demo pnpm --filter @life/server seed
 * Everything is relative to "now", so it always looks current.
 */
import { DateTime } from "luxon";
import { newId, type CalEvent, type Project, type Task } from "@life/core";
import { createServices } from "./app";
import { openDb } from "./db";

const db = await openDb();
const s = createServices(db);
const sys = { actor: "system" as const, reason: "Demo data" };
const prefs = await s.store.setPrefs({ timezone: process.env.TZ_DEMO ?? "Australia/Melbourne" }, sys);
const now = DateTime.now().setZone(prefs.timezone);
const at = (days: number, h: number, m = 0) => now.plus({ days }).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toISO()!;
const created = now.minus({ days: 3 }).toISO()!;

const projects: Project[] = [
  { id: "prj_robot", title: "Robot arm", area: "personal", status: "active", stage: "Stage 2: wiring", stages: ["Stage 1: design", "Stage 2: wiring", "Stage 3: firmware", "Stage 4: demo"] },
  { id: "prj_fit", title: "FIT2004 Algorithms", area: "uni", status: "active", stage: "Week 11" },
  { id: "prj_team", title: "Monash Motorsport — electronics", area: "uni", status: "active", source: "notion" },
];
for (const p of projects) await s.store.create("project", p, sys);

const tasks: Task[] = [
  { id: newId("tsk_"), title: "Finish FIT2004 Assignment 2", area: "uni", projectId: "prj_fit", status: "doing", progress: 0.3, estimateMinutes: 480, due: at(4, 23, 55), source: "moodle", energy: "high", importance: 4, createdAt: created },
  { id: newId("tsk_"), title: "Do Week 12 Quiz", area: "uni", projectId: "prj_fit", status: "todo", estimateMinutes: 45, due: at(0, 23, 59), source: "moodle", importance: 4, createdAt: created },
  { id: newId("tsk_"), title: "Solder the shoulder servo harness", area: "personal", projectId: "prj_robot", status: "todo", estimateMinutes: 90, energy: "medium", source: "you", createdAt: created },
  { id: newId("tsk_"), title: "Write motor driver test plan", area: "uni", projectId: "prj_team", status: "todo", estimateMinutes: 60, due: at(3, 17), source: "notion", sourceUrl: "https://notion.so", createdAt: created },
  { id: newId("tsk_"), title: "Pay phone bill", area: "admin", status: "todo", estimateMinutes: 10, source: "gmail", createdAt: created },
  { id: newId("tsk_"), title: "Reply to Jess about Saturday", area: "social", status: "todo", estimateMinutes: 5, source: "screenshot", createdAt: created },
  { id: newId("tsk_"), title: "PCB order confirmation", area: "uni", projectId: "prj_team", status: "waiting", waitingOn: "Alex (Discord)", estimateMinutes: 15, source: "discord", createdAt: created },
];
for (const t of tasks) await s.store.create("task", t, sys);

const events: CalEvent[] = [
  { id: newId("evt_"), title: "Shift at Grill'd", start: at(1, 17), end: at(1, 22), lock: "hard", certainty: "confirmed", area: "work", source: "screenshot" },
  { id: newId("evt_"), title: "FIT2004 Lecture", start: at(0, 10), end: at(0, 12), lock: "hard", certainty: "confirmed", area: "uni", source: "timetable", location: "Clayton LTB" },
  { id: newId("evt_"), title: "Dinner with Sam?", start: at(0, 19), end: at(0, 21), lock: "soft", certainty: "maybe", area: "social", source: "chat" },
  { id: newId("evt_"), title: "Gym", start: at(0, 7), end: at(0, 8), lock: "flexible", certainty: "confirmed", area: "health", source: "you" },
];
for (const e of events) await s.store.create("event", e, sys);

await s.store.create(
  "question",
  { id: newId("q_"), question: "What time is Jess's BBQ on Saturday?", context: "Affects your Saturday study block", source: "screenshot", status: "open", createdAt: created, relevantBy: at(2, 9) },
  sys,
);
await s.store.create(
  "task",
  { id: newId("tsk_"), title: "Book lab bench for Thursday", area: "uni", projectId: "prj_team", status: "todo", estimateMinutes: 10, due: at(2, 12), source: "discord", createdAt: created },
  { ...sys, actor: "connector", propose: true, batchId: "demo_discord" },
);

await s.review.ensureEvent();
const plan = await s.planner.replan();
console.log(`Seeded: ${tasks.length} tasks, ${events.length} events, ${plan.blocks.length} planned blocks, ${plan.conflicts.length} conflicts.`);
process.exit(0);
