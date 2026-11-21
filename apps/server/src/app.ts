import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DateTime } from "luxon";
import { z } from "zod";
import { newId, type CalEvent, type DayMode, type Task } from "@life/core";
import { recordProgress } from "@life/scheduler";
import { ChatAgent } from "./agent/chat";
import { TriageAgent } from "./agent/triage";
import { runTool, toolsFor, type ToolContext } from "./agent/tools";
import { CheckIns, type CheckInResponse } from "./checkins";
import { config } from "./config";
import { listFeeds, saveFeeds, syncFeed, type Feed } from "./connectors/ical";
import * as google from "./connectors/google";
import { defaultNotionConfig, syncNotion, type NotionConfig } from "./connectors/notion";
import type { DB } from "./db";
import { BudgetExceededError, LLM } from "./llm/provider";
import { createMemory } from "./memory";
import { Notifier } from "./notify";
import { Planner } from "./planner";
import { REVIEW_STEPS, WeeklyReview } from "./review";
import { Store } from "./store";

export interface Services {
  store: Store;
  planner: Planner;
  llm: LLM;
  chat: ChatAgent;
  triage: TriageAgent;
  checkins: CheckIns;
  notifier: Notifier;
  review: WeeklyReview;
  memory: ReturnType<typeof createMemory>;
}

export function createServices(db: DB): Services {
  const store = new Store(db);
  const planner = new Planner(store);
  const llm = new LLM(store);
  const memory = createMemory(store);
  const notifier = new Notifier(store);
  return {
    store,
    planner,
    llm,
    memory,
    notifier,
    chat: new ChatAgent(store, planner, memory, llm),
    triage: new TriageAgent(store, planner, memory, llm),
    checkins: new CheckIns(store, planner, notifier),
    review: new WeeklyReview(store, planner),
  };
}

export async function buildApp(s: Services): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 25 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 10 } });

  // Single-user bearer auth.
  app.addHook("onRequest", async (req, reply) => {
    if (!config.apiToken || !req.url.startsWith("/api/")) return;
    if (req.url.startsWith("/api/health") || req.url.startsWith("/api/connect/google/callback")) return;
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const q = (req.query as Record<string, string> | undefined)?.token;
    if (header !== config.apiToken && q !== config.apiToken) return reply.code(401).send({ error: "unauthorized" });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BudgetExceededError) return reply.code(402).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.message });
    app.log.error(err);
    return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: (err as Error).message });
  });

  const you = (reason?: string) => ({ actor: "you" as const, reason, batchId: newId("ui_") });
  const after = async <T>(v: T) => {
    await s.planner.replan();
    return v;
  };

  app.get("/api/health", async () => ({ ok: true }));

  // ---------------- Today & plan ----------------
  app.get("/api/today", async () => s.planner.today());
  app.get("/api/plan", async () => s.planner.current());
  app.post("/api/replan", async () => s.planner.replan({ reason: "manual" }));
  app.get("/api/closeout", async () => s.planner.closeOut());

  // ---------------- Tasks ----------------
  app.get("/api/tasks", async () => s.store.list("task"));
  app.post("/api/tasks", async (req) => {
    const body = req.body as Partial<Task>;
    const t: Task = {
      id: newId("tsk_"),
      title: String(body.title ?? "Untitled"),
      area: body.area ?? "personal",
      status: body.status ?? "todo",
      estimateMinutes: body.estimateMinutes ?? 30,
      source: "you",
      createdAt: new Date().toISOString(),
      ...body,
    } as Task;
    await s.store.create("task", t, you("Added"));
    return after(t);
  });
  app.patch("/api/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    await s.store.update("task", id, req.body as Partial<Task>, you("Edited"));
    return after(await s.store.get("task", id));
  });
  app.delete("/api/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    await s.store.remove("task", id, you("Deleted"));
    return after({ ok: true });
  });
  app.post("/api/tasks/:id/done", async (req) => {
    const { id } = req.params as { id: string };
    const { minutesSpent } = (req.body ?? {}) as { minutesSpent?: number };
    const t = await s.store.get("task", id);
    if (!t) return { ok: false };
    const c = await s.store.update("task", id, recordProgress(t, { minutesSpent: minutesSpent ?? 0, finished: true }), you("Done"));
    return after({ ok: true, changeId: c?.id });
  });
  app.post("/api/tasks/:id/progress", async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ minutesSpent: z.number().min(0), fractionDone: z.number().min(0).max(1).optional() }).parse(req.body);
    const t = await s.store.get("task", id);
    if (!t) return { ok: false };
    await s.store.update("task", id, recordProgress(t, b), you("Progress"));
    return after({ ok: true });
  });
  app.post("/api/tasks/:id/defer", async (req) => {
    const { id } = req.params as { id: string };
    const { until } = (req.body ?? {}) as { until?: string };
    const ctx = toolCtx(s, "you");
    const r = await runTool(toolsFor(["defer_task"]), "defer_task", { id, until: until ?? "tomorrow" }, ctx);
    return after(JSON.parse(r.content));
  });
  /** Drag-to-reorder: ids in the order you want them. Feeds back into scheduler priority. */
  app.post("/api/tasks/reorder", async (req) => {
    const { ids } = z.object({ ids: z.array(z.string()) }).parse(req.body);
    const batchId = newId("ui_");
    for (const [i, id] of ids.entries()) await s.store.update("task", id, { manualRank: i }, { actor: "you", reason: "Reordered", batchId });
    return after({ ok: true });
  });
  /** "This is too big" / "I don't know how to start" → AI breakdown. */
  app.post("/api/tasks/:id/breakdown", async (req) => {
    const { id } = req.params as { id: string };
    const { stuck } = (req.body ?? {}) as { stuck?: boolean };
    const t = await s.store.get("task", id);
    if (!t) return { ok: false };
    const r = await s.chat.send(
      `Break down the task "${t.title}" [${t.id}] into concrete steps with break_down_task.${stuck ? " I'm stuck getting started — make the first step a 10-minute starter." : ""} Reply in one line.`,
    );
    return r;
  });

  // ---------------- Projects & events ----------------
  app.get("/api/projects", async () => s.store.list("project"));
  app.post("/api/projects", async (req) => {
    const p = { id: newId("prj_"), status: "active", source: "you", ...(req.body as object) } as never;
    await s.store.create("project", p, you("Added project"));
    return p;
  });
  app.patch("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    await s.store.update("project", id, req.body as object, you("Edited project"));
    return s.store.get("project", id);
  });
  app.get("/api/events", async () => s.store.list("event"));
  app.post("/api/events", async (req) => {
    const b = req.body as Partial<CalEvent>;
    const e = { id: newId("evt_"), lock: "soft", certainty: "confirmed", source: "you", ...b } as CalEvent;
    await s.store.create("event", e, you("Added event"));
    return after(e);
  });
  app.patch("/api/events/:id", async (req) => {
    const { id } = req.params as { id: string };
    await s.store.update("event", id, req.body as Partial<CalEvent>, you("Edited event"));
    return after(await s.store.get("event", id));
  });
  app.delete("/api/events/:id", async (req) => {
    const { id } = req.params as { id: string };
    await s.store.remove("event", id, you("Removed event"));
    return after({ ok: true });
  });

  // ---------------- Day mode, focus, prefs ----------------
  app.post("/api/daymode", async (req) => {
    const b = z.object({ date: z.string().optional(), mode: z.enum(["normal", "low-energy", "sick", "busy", "free"]) }).parse(req.body);
    const tz = (await s.store.prefs()).timezone;
    await s.store.setDayMode(b.date ?? DateTime.now().setZone(tz).toISODate()!, b.mode as DayMode, you("Day mode"));
    return after(await s.planner.today());
  });
  app.get("/api/prefs", async () => s.store.prefs());
  app.patch("/api/prefs", async (req) => after(await s.store.setPrefs(req.body as object, you("Settings"))));

  // ---------------- Questions ----------------
  app.post("/api/questions/:id/answer", async (req) => {
    const { id } = req.params as { id: string };
    const { answer } = z.object({ answer: z.string() }).parse(req.body);
    const q = await s.store.get("question", id);
    await s.store.update("question", id, { status: "answered", answer }, you("Answered"));
    // Let the assistant apply the answer (e.g. set the event time).
    if (q && s.llm.available) return s.chat.send(`Answer to "${q.question}": ${answer}. Apply it.`);
    return after({ ok: true });
  });
  app.post("/api/questions/:id/dismiss", async (req) => {
    const { id } = req.params as { id: string };
    await s.store.update("question", id, { status: "dismissed" }, you("Dismissed"));
    return { ok: true };
  });

  // ---------------- Review queue & undo ----------------
  app.get("/api/changes", async (req) => {
    const { status } = req.query as { status?: "proposed" | "applied" };
    return s.store.listChanges({ status, limit: 100 });
  });
  app.post("/api/changes/:id/accept", async (req) => after(await s.store.accept((req.params as { id: string }).id)));
  app.post("/api/changes/:id/reject", async (req) => {
    await s.store.reject((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post("/api/changes/:id/revert", async (req) => after({ ok: await s.store.revert((req.params as { id: string }).id) }));
  app.post("/api/batches/:id/revert", async (req) => after({ reverted: await s.store.revertBatch((req.params as { id: string }).id) }));
  app.post("/api/batches/:id/accept", async (req) => after({ accepted: await s.store.acceptBatch((req.params as { id: string }).id) }));

  // ---------------- Chat ----------------
  app.get("/api/chat", async () => s.store.recentChat(50));
  app.post("/api/chat", async (req) => {
    const { message } = z.object({ message: z.string().min(1).max(8000) }).parse(req.body);
    if (!s.llm.available) return { reply: "Chat needs ANTHROPIC_API_KEY (or LIFE_LLM_PROVIDER=claude-cli) to be set on the server.", changed: false };
    return s.chat.send(message);
  });

  // ---------------- Check-ins ----------------
  app.post("/api/checkins/:blockId", async (req) => {
    const { blockId } = req.params as { blockId: string };
    const b = z
      .object({ response: z.enum(["on-it", "doing-other", "snooze", "done", "partial"]), minutesSpent: z.number().optional(), fractionDone: z.number().optional() })
      .parse(req.body);
    return s.checkins.respond(blockId, b.response as CheckInResponse, b);
  });
  app.post("/api/push/subscribe", async (req) => {
    await s.notifier.subscribe(req.body as never);
    return { ok: true };
  });
  app.get("/api/push/key", async () => ({ publicKey: config.webPush.publicKey ?? null }));

  // ---------------- Capture: screenshots & quick notes ----------------
  app.post("/api/capture/screenshots", async (req) => {
    const images: { mediaType: string; data: string }[] = [];
    let hint: string | undefined;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const buf = await part.toBuffer();
        images.push({ mediaType: part.mimetype || "image/png", data: buf.toString("base64") });
      } else if (part.fieldname === "hint") hint = String(part.value);
    }
    if (!images.length) return { error: "No images" };
    return s.triage.process({ source: "screenshot", title: `Screenshots (${images.length})`, images, hint });
  });
  app.post("/api/capture/text", async (req) => {
    const b = z.object({ text: z.string().min(1), source: z.string().optional() }).parse(req.body);
    return s.triage.process({ source: (b.source as never) ?? "you", title: b.text.slice(0, 80), body: b.text });
  });

  // ---------------- Weekly review ----------------
  app.get("/api/review", async () => s.review.data());
  app.post("/api/review/step", async (req) => {
    const b = z.object({ step: z.enum(REVIEW_STEPS), outcome: z.enum(["done", "skipped", "nothing"]), short: z.boolean().optional() }).parse(req.body);
    return s.review.mark(b.step, b.outcome, { short: b.short });
  });

  // ---------------- Connectors ----------------
  app.get("/api/connectors", async () => ({
    google: await google.connectedAccounts(s.store),
    feeds: await listFeeds(s.store),
    notion: (await s.store.getKv("notion")) ?? null,
    discord: (await s.store.getKv("discord")) ?? null,
    llm: { available: s.llm.available, provider: config.llmProvider, models: config.models },
    memory: config.eunomia.url ? "eunomia" : "local",
    push: { webPush: Boolean(config.webPush.publicKey), telegram: Boolean(config.telegram.botToken) },
  }));
  app.post("/api/connectors/feeds", async (req) => {
    const b = z
      .object({ name: z.string(), url: z.string().url(), kind: z.enum(["moodle", "timetable", "calendar"]), lock: z.enum(["hard", "soft", "flexible"]).default("soft") })
      .parse(req.body);
    const feeds = await listFeeds(s.store);
    const feed: Feed = { id: newId("feed_"), ...b };
    feeds.push(feed);
    await saveFeeds(s.store, feeds);
    const result = await syncFeed(s.store, feed).catch((e) => ({ error: (e as Error).message }));
    return after({ feed, result });
  });
  app.delete("/api/connectors/feeds/:id", async (req) => {
    const { id } = req.params as { id: string };
    await saveFeeds(s.store, (await listFeeds(s.store)).filter((f) => f.id !== id));
    return { ok: true };
  });
  app.get("/api/connect/google", async (req, reply) => {
    const { account } = req.query as { account?: google.Account };
    return reply.redirect(google.authUrl(account === "uni" ? "uni" : "personal"));
  });
  app.get("/api/connect/google/callback", async (req, reply) => {
    const { code, state } = req.query as { code: string; state: google.Account };
    await google.handleCallback(s.store, code, state === "uni" ? "uni" : "personal");
    return reply.redirect("/settings?connected=google");
  });
  app.put("/api/connectors/notion", async (req) => {
    const b = req.body as Partial<NotionConfig>;
    const cfg = { ...defaultNotionConfig, ...b } as NotionConfig;
    await s.store.setKv("notion", cfg);
    return after(await syncNotion(s.store).catch((e) => ({ error: (e as Error).message })));
  });
  app.put("/api/connectors/discord", async (req) => {
    const b = z.object({ channels: z.array(z.string()), myUserId: z.string(), myNames: z.array(z.string()), digestMinutes: z.number().default(30) }).parse(req.body);
    await s.store.setKv("discord", b);
    return { ok: true, note: "Restart the server to (re)connect the bot." };
  });

  // ---------------- Usage / cost ----------------
  app.get("/api/usage", async () => ({ month: await s.llm.monthSpend(), budgetUsd: config.monthlyBudgetUsd }));

  // ---------------- Serve the PWA ----------------
  const appDir = resolve(config.appDir);
  if (existsSync(appDir)) {
    const { default: fstatic } = await import("@fastify/static");
    await app.register(fstatic, { root: appDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}

function toolCtx(s: Services, actor: ToolContext["actor"]): ToolContext {
  return { store: s.store, planner: s.planner, memory: s.memory, batchId: newId("ui_"), actor, propose: false, source: "you", mutated: false };
}
