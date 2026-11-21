import { DateTime } from "luxon";
import { fmtMins } from "@life/scheduler";
import type { Services } from "./app";
import type { CheckInResponse } from "./checkins";
import { config } from "./config";
import { startDiscord } from "./connectors/discord";
import * as google from "./connectors/google";
import { syncAllFeeds } from "./connectors/ical";
import { syncNotion } from "./connectors/notion";

/**
 * Background loop. Everything is idempotent and safe to miss — if the server was asleep,
 * the next tick just catches up.
 */
export function startJobs(s: Services) {
  const log = (msg: string, e?: unknown) => console.log(`[jobs] ${msg}`, e instanceof Error ? e.message : (e ?? ""));
  const every = (minutes: number, name: string, fn: () => Promise<unknown>) => {
    const run = () => fn().catch((e) => log(`${name} failed`, e));
    setTimeout(run, 5_000);
    return setInterval(run, minutes * 60_000);
  };

  const timers = [
    every(1, "checkins", () => s.checkins.tick()),
    every(5, "replan", () => s.planner.replan()),
    every(30, "ical", async () => {
      const r = await syncAllFeeds(s.store);
      if (Object.keys(r).length) await s.planner.replan();
    }),
    every(15, "google", async () => {
      const accounts = await google.connectedAccounts(s.store);
      if (!accounts.length) return;
      for (const a of accounts) await google.pullCalendar(s.store, a);
      const plan = await s.planner.replan();
      const tasks = await s.store.list("task");
      const title = (id: string) => tasks.find((t) => t.id === id)?.title ?? "Work block";
      // Write plan blocks + Life-created events to the personal account's calendar.
      const main = accounts.includes("personal") ? "personal" : accounts[0];
      await google.pushPlan(s.store, main, plan.blocks, title);
      await google.pushEvents(s.store, main);
    }),
    every(15, "gmail", async () => {
      if (!s.llm.available) return;
      for (const a of await google.connectedAccounts(s.store)) {
        for (const m of await google.pullGmail(s.store, a)) {
          await s.triage.process({
            source: a === "uni" ? "uni-gmail" : "gmail",
            title: m.subject || "(no subject)",
            body: `From: ${m.from}\nDate: ${m.date}\n\n${m.body || m.snippet}`,
            externalId: m.id,
          });
        }
      }
    }),
    every(10, "notion", async () => {
      if (!config.notion.token) return;
      const r = await syncNotion(s.store);
      if ("created" in r && (r.created || r.updated)) await s.planner.replan();
    }),
    every(60, "weekly-review", () => s.review.ensureEvent()),
    every(30, "collectors", () => s.collectors.runDue()),
    every(1, "daily-nudges", () => dailyNudges(s)),
  ];

  if (config.discord.botToken) startDiscord(s.store, s.triage, config.discord.botToken).catch((e) => log("discord failed", e));
  if (config.telegram.botToken) pollTelegram(s).catch((e) => log("telegram failed", e));
  return () => timers.forEach(clearInterval);
}

/** Morning brief (~7:30) and evening close-out (~21:00), once per day each. */
async function dailyNudges(s: Services) {
  const prefs = await s.store.prefs();
  const now = DateTime.now().setZone(prefs.timezone);
  const date = now.toISODate()!;
  const hm = now.hour * 60 + now.minute;
  const sent = (await s.store.getKv<Record<string, string>>("nudgesSent")) ?? {};
  if (hm >= 7 * 60 + 30 && hm < 11 * 60 && sent.morning !== date) {
    const t = await s.planner.today();
    const musts = t.must.slice(0, 3).map((i) => `• ${i.title}${i.timeLabel ? ` (${i.timeLabel})` : ""}`);
    const first = t.now ?? t.should[0];
    await s.notifier.send({
      title: musts.length ? `Today: ${musts.length} must${musts.length > 1 ? "s" : ""}` : "Today's plan is ready",
      body: [...musts, first ? `First up: ${first.title}` : "Light day — pick something from Could do."].join("\n"),
      url: "/",
    });
    await s.store.setKv("nudgesSent", { ...sent, morning: date });
  }
  if (hm >= 21 * 60 && hm < 22 * 60 + 15 && sent.evening !== date) {
    const items = await s.planner.closeOut();
    if (items.length) {
      await s.notifier.send({ title: "1-minute close-out", body: `${items.length} thing${items.length > 1 ? "s" : ""} to move on — one tap each.`, url: "/closeout" });
    }
    await s.store.setKv("nudgesSent", { ...sent, evening: date });
  }
}

/** Telegram: check-in buttons + quick capture ("dinner with Sam moved to 8"). */
async function pollTelegram(s: Services) {
  const base = `https://api.telegram.org/bot${config.telegram.botToken}`;
  let offset = (await s.store.getKv<number>("telegram:offset")) ?? 0;
  for (;;) {
    try {
      const res = await fetch(`${base}/getUpdates?timeout=50&offset=${offset}`);
      const body = (await res.json()) as { result?: TgUpdate[] };
      for (const u of body.result ?? []) {
        offset = u.update_id + 1;
        await s.store.setKv("telegram:offset", offset);
        const chatId = String(u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? "");
        if (config.telegram.chatId && chatId !== config.telegram.chatId) continue; // only you
        if (u.callback_query) {
          const [action, blockId] = u.callback_query.data.split("|");
          await s.checkins.respond(blockId, action as CheckInResponse);
          await fetch(`${base}/answerCallbackQuery`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ callback_query_id: u.callback_query.id, text: "Got it — plan updated" }),
          });
        } else if (u.message?.text) {
          if (u.message.text === "/today") {
            const t = await s.planner.today();
            const lines = [...t.must, ...t.should].slice(0, 8).map((i) => `• ${i.title}${i.minutes ? ` (${fmtMins(i.minutes)})` : ""}`);
            await reply(base, chatId, lines.join("\n") || "Nothing planned.");
          } else if (s.llm.available) {
            const r = await s.chat.send(u.message.text);
            await reply(base, chatId, r.reply);
          }
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

async function reply(base: string, chatId: string, text: string) {
  await fetch(`${base}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) });
}

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data: string; message?: { chat: { id: number } } };
}

