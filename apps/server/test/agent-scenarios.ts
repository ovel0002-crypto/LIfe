/**
 * Live scenarios for the Claude parts (chat, triage, breakdown, vision), checking outcomes in the
 * database rather than wording. Uses whichever engine is configured:
 *
 *   LIFE_LLM_PROVIDER=claude-cli pnpm --filter @life/server scenarios     # your Claude plan via `claude -p`
 *   ANTHROPIC_API_KEY=... pnpm --filter @life/server scenarios            # Claude API
 *
 * Runs against a fresh in-memory database seeded with demo data. Real model calls: costs
 * (plan usage or API credit) apply.
 */
process.env.PORT ??= "8791";
process.env.LIFE_DISABLE_JOBS = "1";
process.env.LOG_LEVEL ??= "warn";

import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
const { buildApp, createServices } = await import("../src/app");
const { openDb } = await import("../src/db");
const { seedDemo } = await import("../src/seed");
const { config } = await import("../src/config");

const fx = (n: string) => new URL(`./fixtures/${n}`, import.meta.url);
const s = createServices(await openDb({ memory: true }));
const app = await buildApp(s);
await app.listen({ port: config.port, host: "127.0.0.1" });
const TZ = "Australia/Melbourne";
await seedDemo(s, TZ);
const only = process.argv.slice(2);

type Check = { name: string; run: () => Promise<string | true> };
const results: { name: string; ok: boolean; detail: string; secs: number }[] = [];

const task = async (re: RegExp) => (await s.store.list("task")).find((t) => re.test(t.title));
const proposedIn = async (batchId: string) => (await s.store.listChanges({ status: "proposed", limit: 500 })).filter((c) => c.batchId === batchId);
const local = (iso: string) => DateTime.fromISO(iso).setZone(TZ);
let lastReply = "";
const chat = async (m: string) => {
  const r = await s.chat.send(m);
  lastReply = r.reply;
  return r;
};

const checks: Check[] = [
  {
    name: "chat: focus on the robot arm project",
    run: async () => {
      await chat("Can you focus on the robot arm project today? I want to get the wiring stage moving.");
      const p = await s.store.prefs();
      const ok = (p.focus["prj_robot"] ?? 0) > 0 || (p.focus["personal"] ?? 0) > 0;
      return ok || `focus=${JSON.stringify(p.focus)}`;
    },
  },
  {
    name: "chat: dinner with Sam confirmed and moved to 8pm",
    run: async () => {
      await chat("Dinner with Sam is happening for sure now, but it got moved to 8pm.");
      const e = (await s.store.list("event")).find((x) => /sam/i.test(x.title));
      if (!e) return "no Sam event";
      const h = local(e.start).hour;
      return (e.certainty === "confirmed" && h === 20) || `certainty=${e.certainty} start=${local(e.start).toFormat("ccc HH:mm")}`;
    },
  },
  {
    name: "chat: partial progress on A2",
    run: async () => {
      await chat("I did 30 minutes on assignment 2 just now, I reckon it's about half done overall.");
      const t = await task(/Assignment 2/);
      const ok = t && (t.progress ?? 0) >= 0.4 && (t.progress ?? 0) <= 0.65 && (t.actualMinutes ?? 0) >= 30;
      return ok || `progress=${t?.progress} actual=${t?.actualMinutes}`;
    },
  },
  {
    name: "chat: I'm sick → day mode",
    run: async () => {
      await chat("Ugh I woke up sick today, can't do much.");
      const today = DateTime.now().setZone(TZ).toISODate()!;
      const m = (await s.store.dayModes())[today];
      return m === "sick" || `mode=${m}`;
    },
  },
  {
    name: "chat: stuck → breakdown with a small starter step",
    run: async () => {
      const parent = await task(/servo harness/);
      await chat(`I'm stuck on "${parent!.title}" — I don't even know how to start. Break it down for me.`);
      const steps = (await s.store.list("task")).filter((t) => t.parentId === parent!.id);
      const min = Math.min(...steps.map((x) => x.estimateMinutes));
      return (steps.length >= 2 && min <= 15) || `steps=${steps.length} smallest=${min}`;
    },
  },
  {
    name: "chat: undo that",
    run: async () => {
      const parent = await task(/servo harness/);
      await chat("Actually undo that.");
      const steps = (await s.store.list("task")).filter((t) => t.parentId === parent!.id);
      return steps.length === 0 || `steps still there: ${steps.length}`;
    },
  },
  {
    name: "triage: extension email → proposed due-date update",
    run: async () => {
      const r = await s.triage.process({ source: "uni-gmail", title: "FIT2004 Assignment 2 - extension granted", body: readFileSync(fx("email-extension.txt"), "utf8") });
      const changes = await proposedIn(r.batchId);
      const upd = changes.find((c) => c.entityType === "task" && c.op === "update" && /2026-11-30|2026-11-29T1/.test(JSON.stringify(c.after)));
      return Boolean(upd) || `proposed=${changes.length} ${changes.map((c) => c.op + ":" + JSON.stringify((c.after as { due?: string })?.due)).join(",")} summary=${r.summary}`;
    },
  },
  {
    name: "triage: marketing email filtered with no model call",
    run: async () => {
      const before = (await s.store.spendSince(new Date(0))).calls;
      const r = await s.triage.process({ source: "gmail", title: "30% off knitwear this weekend only", body: readFileSync(fx("email-noise.txt"), "utf8") });
      const after = (await s.store.spendSince(new Date(0))).calls;
      return (r.summary === "Filtered as noise" && after === before) || `summary=${r.summary} calls ${before}->${after}`;
    },
  },
  {
    name: "vision: roster screenshot → proposed hard shifts",
    run: async () => {
      const r = await s.triage.process({
        source: "screenshot",
        title: "Roster screenshot",
        images: [{ mediaType: "image/png", data: readFileSync(fx("roster.png")).toString("base64") }],
        hint: "My Humanforce roster",
      });
      const evs = (await proposedIn(r.batchId)).filter((c) => c.entityType === "event" && c.op === "create").map((c) => c.after as { title: string; lock: string; start: string });
      // A shift that's already in the calendar should be skipped, not duplicated.
      const existing = (await s.store.list("event")).filter((e) => e.lock === "hard" && /shift/i.test(e.title)).map((e) => ({ title: e.title, lock: e.lock, start: e.start }));
      const all = [...evs.filter((e) => e.lock === "hard"), ...existing];
      const want = ["Mon 23 17:00", "Wed 25 11:00", "Fri 27 18:00", "Sun 29 10:00"];
      const have = new Set(all.map((e) => local(e.start).toFormat("ccc d HH:mm")));
      const dupes = evs.filter((e) => existing.some((x) => x.start === e.start)).length;
      const openShiftAdded = evs.some((e) => local(e.start).toFormat("ccc d HH:mm") === "Sat 28 12:00");
      return (want.every((w) => have.has(w)) && dupes === 0 && !openShiftAdded) || `events=${evs.map((e) => `${e.title}@${local(e.start).toFormat("ccc d HH:mm")}/${e.lock}`).join("; ")} summary=${r.summary}`;
    },
  },
  {
    name: "vision: Instagram DM screenshot → tentative BBQ + bring-speaker task",
    run: async () => {
      const qBefore = (await s.store.list("question")).length;
      const r = await s.triage.process({
        source: "screenshot",
        title: "Instagram DM screenshot",
        images: [{ mediaType: "image/png", data: readFileSync(fx("instagram-dm.png")).toString("base64") }],
        hint: "My Instagram DMs",
      });
      const ch = await proposedIn(r.batchId);
      const ev = ch.find((c) => c.entityType === "event" && /bbq|barbecue|jess/i.test(JSON.stringify(c.after)));
      const evData = ev?.after as { certainty?: string } | undefined;
      const speaker = ch.find((c) => c.entityType === "task" && /speaker/i.test(JSON.stringify(c.after)));
      const asked = (await s.store.list("question")).length > qBefore;
      const tentative = evData && evData.certainty !== "confirmed";
      return (Boolean(ev) && Boolean(tentative) && Boolean(speaker)) || `event=${JSON.stringify(evData)} speaker=${Boolean(speaker)} question=${asked} summary=${r.summary}`;
    },
  },
];

for (const c of checks) {
  if (only.length && !only.some((o) => c.name.includes(o))) continue;
  const t0 = Date.now();
  let ok = false;
  let detail = "";
  try {
    const r = await c.run();
    ok = r === true;
    detail = r === true ? "" : r;
  } catch (e) {
    detail = `threw: ${(e as Error).message}`;
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  results.push({ name: c.name, ok, detail, secs });
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  (${secs}s)${detail ? `\n      ${detail}` : ""}${c.name.startsWith("chat") ? `\n      reply: ${lastReply.replace(/\n/g, " ").slice(0, 220)}` : ""}`);
}

const usage = await s.store.spendSince(new Date(0));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed · engine=${config.llmProvider} · model calls=${usage.calls} · API $${usage.total.toFixed(3)}`);
await app.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
