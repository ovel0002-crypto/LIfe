import webpush from "web-push";
import { inQuietHours, ms } from "@life/scheduler";
import { config } from "./config";
import type { Store } from "./store";

export interface Nudge {
  title: string;
  body: string;
  /** Deep link inside the app, e.g. /today */
  url?: string;
  /** Buttons (web push actions / Telegram inline keyboard). */
  actions?: { id: string; label: string }[];
  /** Opaque payload returned with the action (e.g. block id). */
  tag?: string;
  /** Bypass quiet hours (never used for routine nudges). */
  urgent?: boolean;
}

let vapidReady = false;
function ensureVapid() {
  if (vapidReady || !config.webPush.publicKey || !config.webPush.privateKey) return vapidReady;
  webpush.setVapidDetails(config.webPush.subject, config.webPush.publicKey, config.webPush.privateKey);
  vapidReady = true;
  return true;
}

/**
 * Sends nudges to every channel you've set up: Web Push (home-screen app on iOS 16.4+) and
 * Telegram (reliable fallback, since iOS web push can be flaky).
 */
export class Notifier {
  constructor(private store: Store) {}

  async subscribe(sub: webpush.PushSubscription) {
    const subs = (await this.store.getKv<webpush.PushSubscription[]>("pushSubs")) ?? [];
    if (!subs.some((s) => s.endpoint === sub.endpoint)) subs.push(sub);
    await this.store.setKv("pushSubs", subs);
  }

  async send(n: Nudge): Promise<{ sent: number; skipped?: string }> {
    const prefs = await this.store.prefs();
    if (!n.urgent && inQuietHours(Date.now(), prefs)) return { sent: 0, skipped: "quiet-hours" };
    let sent = 0;
    if (ensureVapid()) {
      const subs = (await this.store.getKv<webpush.PushSubscription[]>("pushSubs")) ?? [];
      const alive: webpush.PushSubscription[] = [];
      for (const s of subs) {
        try {
          await webpush.sendNotification(s, JSON.stringify(n), { TTL: 3600 });
          alive.push(s);
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code !== 404 && code !== 410) alive.push(s); // drop only expired subscriptions
        }
      }
      await this.store.setKv("pushSubs", alive);
    }
    if (config.telegram.botToken && config.telegram.chatId) {
      const keyboard = n.actions?.length
        ? { inline_keyboard: [n.actions.map((a) => ({ text: a.label, callback_data: `${a.id}|${n.tag ?? ""}`.slice(0, 64) }))] }
        : undefined;
      const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: config.telegram.chatId, text: `*${n.title}*\n${n.body}`, parse_mode: "Markdown", reply_markup: keyboard }),
      }).catch(() => undefined);
      if (res?.ok) sent++;
    }
    await this.store.setKv("lastNudge", { ...n, at: new Date().toISOString() });
    return { sent };
  }
}

export function isRecent(iso: string | undefined, minutes: number) {
  return iso ? Date.now() - ms(iso) < minutes * 60_000 : false;
}
