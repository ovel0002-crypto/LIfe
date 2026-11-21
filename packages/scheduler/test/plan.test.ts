import { describe, expect, it } from "vitest";
import { defaultPreferences, inverseOf, makeChange, type CalEvent, type Preferences, type Task } from "@life/core";
import {
  buildToday,
  closeOut,
  freshStart,
  learnEstimateFactors,
  ms,
  plan,
  recordProgress,
  remainingMinutes,
  shouldCheckIn,
} from "../src";

const prefs: Preferences = { ...defaultPreferences, timezone: "Australia/Melbourne" };
// Monday 24 Nov 2026, 8:00am Melbourne (AEDT, +11:00)
const NOW = "2026-11-24T08:00:00+11:00";

let n = 0;
function task(p: Partial<Task>): Task {
  n++;
  return {
    id: p.id ?? `t${n}`,
    title: p.title ?? `Task ${n}`,
    area: p.area ?? "uni",
    status: p.status ?? "todo",
    estimateMinutes: p.estimateMinutes ?? 60,
    source: p.source ?? "you",
    createdAt: p.createdAt ?? "2026-11-20T09:00:00+11:00",
    ...p,
  };
}

function ev(p: Partial<CalEvent> & { start: string; end: string }): CalEvent {
  n++;
  return {
    id: p.id ?? `e${n}`,
    title: p.title ?? `Event ${n}`,
    lock: p.lock ?? "hard",
    certainty: p.certainty ?? "confirmed",
    source: p.source ?? "gcal",
    ...p,
  };
}

const minutesOf = (blocks: { start: string; end: string }[]) =>
  blocks.reduce((s, b) => s + (ms(b.end) - ms(b.start)) / 60_000, 0);

describe("deadline back-scheduling", () => {
  it("spreads a 10h assignment across days before the deadline, finishing early", () => {
    const a2 = task({ id: "a2", title: "FIT2004 A2", estimateMinutes: 600, due: "2026-11-28T23:55:00+11:00" });
    const r = plan({ now: NOW, tasks: [a2], events: [], prefs });
    const blocks = r.blocks.filter((b) => b.taskId === "a2");
    expect(minutesOf(blocks)).toBe(600);
    // Spread: no single day over the per-day cap.
    const perDay = new Map<string, number>();
    for (const b of blocks) {
      const d = b.start.slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + (ms(b.end) - ms(b.start)) / 60_000);
    }
    expect(perDay.size).toBeGreaterThanOrEqual(4);
    for (const m of perDay.values()) expect(m).toBeLessThanOrEqual(prefs.maxTaskMinutesPerDay);
    // Finishes before the buffered deadline.
    const last = Math.max(...blocks.map((b) => ms(b.end)));
    expect(last).toBeLessThanOrEqual(ms(a2.due!) - prefs.deadlineBufferHours * 3600_000);
    // Blocks respect max block length.
    for (const b of blocks) expect((ms(b.end) - ms(b.start)) / 60_000).toBeLessThanOrEqual(prefs.maxBlockMinutes);
    expect(r.conflicts).toHaveLength(0);
  });

  it("prioritises the tighter deadline", () => {
    const soon = task({ id: "soon", estimateMinutes: 120, due: "2026-11-25T12:00:00+11:00" });
    const later = task({ id: "later", estimateMinutes: 120, due: "2026-12-05T12:00:00+11:00" });
    const r = plan({ now: NOW, tasks: [later, soon], events: [], prefs });
    const first = [...r.blocks].sort((a, b) => ms(a.start) - ms(b.start))[0];
    expect(first.taskId).toBe("soon");
  });
});

describe("locks", () => {
  it("never moves hard events and never schedules over them", () => {
    const shift = ev({ id: "shift", title: "Shift", lock: "hard", start: "2026-11-24T09:00:00+11:00", end: "2026-11-24T17:00:00+11:00" });
    const t = task({ id: "x", estimateMinutes: 240, due: "2026-11-25T20:00:00+11:00" });
    const r = plan({ now: NOW, tasks: [t], events: [shift], prefs });
    expect(r.eventMoves.find((m) => m.eventId === "shift")).toBeUndefined();
    for (const b of r.blocks) {
      const overlap = ms(b.start) < ms(shift.end) && ms(shift.start) < ms(b.end);
      expect(overlap).toBe(false);
    }
  });

  it("moves only the flexible event when a hard event lands on it", () => {
    const review = ev({
      id: "review",
      title: "Weekly admin hour",
      lock: "flexible",
      start: "2026-11-24T16:00:00+11:00",
      end: "2026-11-24T17:00:00+11:00",
    });
    const dinner = ev({ id: "dinner", title: "Family dinner", lock: "hard", start: "2026-11-24T15:30:00+11:00", end: "2026-11-24T18:00:00+11:00" });
    const r = plan({ now: NOW, tasks: [], events: [review, dinner], prefs });
    expect(r.eventMoves).toHaveLength(1);
    expect(r.eventMoves[0].eventId).toBe("review");
    const moved = r.eventMoves[0].to;
    expect(ms(moved.end) <= ms(dinner.start) || ms(moved.start) >= ms(dinner.end)).toBe(true);
  });

  it("falls back to the short version of a flexible event when the full one won't fit", () => {
    const review = ev({
      id: "review",
      title: "Weekly admin hour",
      lock: "flexible",
      shortVersionMinutes: 15,
      start: "2026-11-24T12:00:00+11:00",
      end: "2026-11-24T13:00:00+11:00",
      window: { earliest: "2026-11-24T12:00:00+11:00", latest: "2026-11-24T13:30:00+11:00" },
    });
    const lunch = ev({ title: "Lunch", lock: "hard", start: "2026-11-24T12:00:00+11:00", end: "2026-11-24T13:10:00+11:00" });
    const r = plan({ now: NOW, tasks: [], events: [review, lunch], prefs });
    expect(r.eventMoves[0]?.shortened).toBe(true);
  });

  it("surfaces hard/soft overlaps as a question instead of resolving them", () => {
    const exam = ev({ title: "Exam", lock: "hard", start: "2026-11-25T10:00:00+11:00", end: "2026-11-25T12:00:00+11:00" });
    const coffee = ev({ title: "Coffee w/ Sam", lock: "soft", start: "2026-11-25T11:00:00+11:00", end: "2026-11-25T12:00:00+11:00" });
    const r = plan({ now: NOW, tasks: [], events: [exam, coffee], prefs });
    expect(r.conflicts.some((c) => c.kind === "event-overlap")).toBe(true);
    expect(r.eventMoves).toHaveLength(0);
  });
});

describe("slack and tentative plans", () => {
  it("never plans more than the capacity ratio of free time", () => {
    const big = Array.from({ length: 10 }, (_, i) => task({ id: `b${i}`, area: "personal", estimateMinutes: 600 }));
    const r = plan({ now: NOW, tasks: big, events: [], prefs, horizonDays: 3 });
    for (const d of r.days) {
      expect(d.plannedMinutes).toBeLessThanOrEqual(Math.floor(d.freeMinutes * prefs.capacityRatio));
    }
  });

  it("reserves a buffer around maybe-events without committing", () => {
    const maybe = ev({
      id: "m",
      title: "Dinner with Sam?",
      lock: "soft",
      certainty: "maybe",
      start: "2026-11-24T18:00:00+11:00",
      end: "2026-11-24T20:00:00+11:00",
    });
    const t = task({ id: "w", area: "personal", estimateMinutes: 900 });
    const r = plan({ now: NOW, tasks: [t], events: [maybe], prefs, horizonDays: 1 });
    const pad = prefs.maybeBufferMinutes * 60_000;
    for (const b of r.blocks) {
      const overlap = ms(b.start) < ms(maybe.end) + pad && ms(maybe.start) - pad < ms(b.end);
      expect(overlap).toBe(false);
    }
    const today = buildToday({ now: NOW, tasks: [t], events: [maybe], blocks: r.blocks, prefs });
    expect(today.tentative.map((i) => i.eventId)).toContain("m");
  });

  it("holds back capacity for an event whose time is unknown", () => {
    const tbc = ev({ title: "Catch up with Jo", certainty: "unknown-time", day: "2026-11-24", start: "2026-11-24T12:00:00+11:00", end: "2026-11-24T13:00:00+11:00" });
    const r1 = plan({ now: NOW, tasks: [], events: [], prefs, horizonDays: 1 });
    const r2 = plan({ now: NOW, tasks: [], events: [tbc], prefs, horizonDays: 1 });
    expect(r1.days[0].capacityMinutes - r2.days[0].capacityMinutes).toBe(prefs.unknownTimeReserveMinutes);
  });
});

describe("day modes", () => {
  it("sick mode keeps only true musts and reports what slips", () => {
    const urgent = task({ id: "u", estimateMinutes: 60, due: "2026-11-24T23:00:00+11:00" });
    const project = task({ id: "p", area: "personal", estimateMinutes: 120 });
    const r = plan({ now: NOW, tasks: [urgent, project], events: [], prefs, dayModes: { "2026-11-24": "sick" }, horizonDays: 1 });
    expect(r.blocks.filter((b) => b.taskId === "u").length).toBeGreaterThan(0);
    expect(r.blocks.filter((b) => b.taskId === "p")).toHaveLength(0);
    expect(r.unscheduled.find((u) => u.taskId === "p")?.reason).toBe("day-mode");
  });

  it("low-energy mode lowers capacity", () => {
    const t = task({ area: "personal", estimateMinutes: 2000 });
    const normal = plan({ now: NOW, tasks: [t], events: [], prefs, horizonDays: 1 });
    const low = plan({ now: NOW, tasks: [t], events: [], prefs, horizonDays: 1, dayModes: { "2026-11-24": "low-energy" } });
    expect(low.days[0].capacityMinutes).toBeLessThan(normal.days[0].capacityMinutes);
  });
});

describe("focus and manual priority", () => {
  it("focus weighting changes what comes first", () => {
    const uni = task({ id: "uni", area: "uni", estimateMinutes: 90 });
    const robot = task({ id: "robot", area: "personal", projectId: "robot", estimateMinutes: 90 });
    const base = plan({ now: NOW, tasks: [uni, robot], events: [], prefs, horizonDays: 1 });
    const focused = plan({ now: NOW, tasks: [uni, robot], events: [], prefs: { ...prefs, focus: { robot: 1 } }, horizonDays: 1 });
    const first = (r: typeof base) => [...r.blocks].sort((a, b) => ms(a.start) - ms(b.start))[0].taskId;
    expect(first(focused)).toBe("robot");
    expect(focused.reasons["robot"]).toMatch(/focus/);
    expect(base.blocks.length).toBeGreaterThan(0);
  });
});

describe("overload", () => {
  it("produces a conflict report with options rather than cramming", () => {
    const shifts = [24, 25, 26].map((d) =>
      ev({ title: "Shift", lock: "hard", start: `2026-11-${d}T08:00:00+11:00`, end: `2026-11-${d}T20:00:00+11:00` }),
    );
    const a = task({ id: "a", title: "Assignment A", estimateMinutes: 600, due: "2026-11-26T23:00:00+11:00" });
    const r = plan({ now: NOW, tasks: [a], events: shifts, prefs });
    const c = r.conflicts.find((x) => x.kind === "overload");
    expect(c).toBeDefined();
    expect(c!.options.length).toBeGreaterThanOrEqual(2);
    expect(c!.options.join(" ")).toMatch(/extension/);
    for (const d of r.days) expect(d.plannedMinutes).toBeLessThanOrEqual(d.capacityMinutes);
  });
});

describe("re-flow", () => {
  it("re-plans after a missed block while keeping started work", () => {
    const t = task({ id: "t", estimateMinutes: 180, due: "2026-11-26T18:00:00+11:00" });
    const r1 = plan({ now: NOW, tasks: [t], events: [], prefs });
    const missed = r1.blocks[0];
    // 2 hours later, nothing done; plan again from now.
    const later = "2026-11-24T10:30:00+11:00";
    const r2 = plan({ now: later, tasks: [t], events: [], prefs });
    expect(minutesOf(r2.blocks)).toBe(180);
    for (const b of r2.blocks) expect(ms(b.start)).toBeGreaterThanOrEqual(ms(later));
    expect(r2.blocks[0].start).not.toBe(missed.start);
  });

  it("counts kept in-progress blocks against remaining work", () => {
    const t = task({ id: "t", estimateMinutes: 120, due: "2026-11-26T18:00:00+11:00" });
    const keep = [{ id: "k", taskId: "t", start: "2026-11-24T08:00:00+11:00", end: "2026-11-24T09:00:00+11:00" }];
    const r = plan({ now: "2026-11-24T08:30:00+11:00", tasks: [t], events: [], prefs, keepBlocks: keep });
    // 30 min of the kept block is still ahead → 90 left to place.
    expect(minutesOf(r.blocks)).toBe(90);
  });
});

describe("partial progress & learning", () => {
  it("re-estimates from partial progress", () => {
    const t = task({ estimateMinutes: 90 });
    const after = recordProgress(t, { minutesSpent: 60, fractionDone: 0.5 });
    expect(after.status).toBe("doing");
    expect(remainingMinutes(after)).toBe(60); // took 60 for half → ~60 more
    const burned = recordProgress(t, { minutesSpent: 30 });
    expect(remainingMinutes(burned)).toBe(60);
    const done = recordProgress(t, { minutesSpent: 20, finished: true });
    expect(done.status).toBe("done");
    expect(remainingMinutes(done)).toBe(0);
  });

  it("learns that estimates run long", () => {
    const done = [1, 2, 3].map((i) =>
      task({ area: "uni", status: "done", estimateMinutes: 60, actualMinutes: 90, completedAt: `2026-11-1${i}T10:00:00+11:00` }),
    );
    const f = learnEstimateFactors(done);
    expect(f.uni!).toBeGreaterThan(1);
    const t = task({ area: "uni", estimateMinutes: 60 });
    expect(remainingMinutes(t, { estimateFactor: f })).toBeGreaterThan(60);
  });
});

describe("today list", () => {
  it("groups into now / must / should / could / waiting", () => {
    const quiz = task({ id: "quiz", title: "Quiz 3", estimateMinutes: 30, due: "2026-11-24T23:59:00+11:00", source: "moodle" });
    const a2 = task({ id: "a2", title: "A2 intro", estimateMinutes: 90, due: "2026-11-28T23:55:00+11:00" });
    const quick = task({ id: "q", title: "Pay phone bill", area: "admin", estimateMinutes: 10 });
    const wait = task({ id: "w", title: "Notion: API spec", status: "waiting", waitingOn: "Alex", source: "notion" });
    const shift = ev({ title: "Shift", lock: "hard", start: "2026-11-24T17:00:00+11:00", end: "2026-11-24T22:00:00+11:00", source: "you" });
    const tasks = [quiz, a2, quick, wait];
    const r = plan({ now: NOW, tasks, events: [shift], prefs });
    const t = buildToday({ now: NOW, tasks, events: [shift], blocks: r.blocks, prefs, reasons: r.reasons });
    expect(t.must.map((i) => i.title)).toEqual(expect.arrayContaining(["Quiz 3", "Shift"]));
    expect(t.should.map((i) => i.taskId)).toContain("a2");
    expect(t.could.map((i) => i.taskId)).toContain("q");
    expect(t.waiting.map((i) => i.taskId)).toContain("w");
    expect(t.now).toBeDefined();
    expect(t.should.find((i) => i.taskId === "a2")!.why).toMatch(/Due/);
  });
});

describe("adaptive behaviour", () => {
  it("backs off check-ins after two ignored, and respects quiet hours", () => {
    const h = [
      { id: "1", askedAt: "2026-11-24T09:00:00+11:00", response: "ignored" as const },
      { id: "2", askedAt: "2026-11-24T10:00:00+11:00" },
    ];
    expect(shouldCheckIn("2026-11-24T11:00:00+11:00", h, prefs).ok).toBe(false);
    expect(shouldCheckIn("2026-11-24T11:00:00+11:00", [h[0]], prefs).ok).toBe(true);
    expect(shouldCheckIn("2026-11-24T23:30:00+11:00", [], prefs).reason).toBe("quiet-hours");
  });

  it("offers a fresh start instead of a pile of overdue items", () => {
    const overdue = [1, 2, 3, 4, 5].map((i) => task({ due: `2026-11-1${i}T10:00:00+11:00` }));
    const f = freshStart(NOW, "2026-11-14T10:00:00+11:00", overdue);
    expect(f.needed).toBe(true);
    expect(f.overdue).toHaveLength(5);
  });

  it("close-out suggests a next step for unfinished planned work", () => {
    const t = task({ id: "c", estimateMinutes: 60, due: "2026-11-25T12:00:00+11:00" });
    const r = plan({ now: NOW, tasks: [t], events: [], prefs });
    const items = closeOut("2026-11-24T21:00:00+11:00", [t], r.blocks, prefs);
    expect(items[0]).toMatchObject({ taskId: "c", suggestion: "tomorrow" });
  });

  it("change revert restores prior state", () => {
    const before = { id: "t", title: "Old" };
    const after = { id: "t", title: "New" };
    const c = makeChange({ actor: "assistant", entityType: "task", entityId: "t", op: "update", before, after });
    expect(inverseOf(c)).toMatchObject({ op: "update", after: before });
    const created = makeChange({ actor: "assistant", entityType: "task", entityId: "t", op: "create", after });
    expect(inverseOf(created).op).toBe("delete");
  });
});
