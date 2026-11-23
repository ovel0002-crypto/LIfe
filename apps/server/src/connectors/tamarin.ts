import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TriageAgent } from "../agent/triage";
import type { Store } from "../store";
import { isRelevant, type DiscordConfig } from "./discord";

/**
 * Team Discord via Tamarin (monashautomation/discordbot) instead of a second bot.
 * An admin adds an Outgoing Webhook in Tamarin's dashboard pointing at
 * https://LIFE_DOMAIN/api/hooks/tamarin with a shared secret, for the action-item channels.
 * Tamarin signs each POST with `X-Signature: sha256=<hex HMAC of body>` and `X-Webhook-Event`.
 */
export interface TamarinMessage {
  event: string;
  message_id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; display_name?: string };
  content: string;
  timestamp?: string;
  jump_url?: string;
  // Present once the proposed Tamarin PR is merged:
  mentions?: string[];
  role_mentions?: string[];
  mention_everyone?: boolean;
  reference_author_id?: string | null;
  channel_name?: string;
}

export function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

/** Is this message about the user? Uses the structured mentions when Tamarin sends them, else the text. */
export function relevantToMe(m: TamarinMessage, cfg: Pick<DiscordConfig, "myUserId" | "myNames">): boolean {
  if (m.author.id === cfg.myUserId) return /\b(i('|’)ll|i will|i can|on it|will do)\b/i.test(m.content); // your own promises
  const mentionsMe =
    Boolean(m.mentions?.includes(cfg.myUserId)) ||
    m.reference_author_id === cfg.myUserId ||
    m.content.includes(`<@${cfg.myUserId}>`) ||
    m.content.includes(`<@!${cfg.myUserId}>`);
  return isRelevant(m.content, mentionsMe, { channels: [], myUserId: cfg.myUserId, myNames: cfg.myNames, digestMinutes: 30 });
}

export class TamarinInbox {
  private buffers = new Map<string, { lines: string[]; url?: string }>();
  constructor(
    private store: Store,
    private triage: TriageAgent,
  ) {}

  async accept(m: TamarinMessage): Promise<"kept" | "ignored"> {
    const cfg = await this.store.getKv<DiscordConfig>("discord");
    if (!cfg?.myUserId) return "ignored";
    if (!["message", "message_edit"].includes(m.event)) return "ignored";
    if (cfg.channels.length && !cfg.channels.includes(m.channel_id)) return "ignored";
    if (!relevantToMe(m, cfg)) return "ignored";
    const who = m.author.display_name ?? m.author.username;
    const text = m.content.replace(new RegExp(`<@!?${cfg.myUserId}>`, "g"), "@me");
    const b = this.buffers.get(m.channel_id) ?? { lines: [] };
    b.lines.push(`${m.timestamp ? `(${m.timestamp}) ` : ""}${who}${m.author.id === cfg.myUserId ? " (me)" : ""}: ${text}${m.event === "message_edit" ? " [edited]" : ""}`);
    b.url = m.jump_url ?? b.url;
    this.buffers.set(m.channel_id, b);
    await this.store.setKv("tamarin:lastSeen", new Date().toISOString());
    return "kept";
  }

  /** Called every 30 min by the jobs loop: one triage call per channel with activity. */
  async flush() {
    const cfg = await this.store.getKv<DiscordConfig>("discord");
    for (const [channel, b] of this.buffers) {
      this.buffers.delete(channel);
      if (!b.lines.length) continue;
      await this.triage.process({
        source: "discord",
        title: `Team Discord (Tamarin) channel ${channel}`,
        body: b.lines.join("\n"),
        url: b.url,
        hint: `Messages from the user's engineering team Discord, forwarded by the team bot. "@me" is the user${cfg?.myNames?.length ? ` (${cfg.myNames.join(" / ")})` : ""}. Only create tasks for things asked of the user or that the user agreed to do; use status waiting for things others will do for the user.`,
      });
    }
  }

  pending() {
    return [...this.buffers.values()].reduce((n, b) => n + b.lines.length, 0);
  }
}

/** Registers POST /api/hooks/tamarin with its own raw-body JSON parser (needed for the HMAC). */
export async function registerTamarin(app: FastifyInstance, inbox: TamarinInbox, secret: () => string | undefined) {
  await app.register(async (sub) => {
    sub.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error, undefined);
      }
    });
    sub.post("/api/hooks/tamarin", async (req, reply) => {
      const key = secret();
      if (!key) return reply.code(503).send({ error: "TAMARIN_WEBHOOK_SECRET not set" });
      const raw = (req as { rawBody?: string }).rawBody ?? "";
      if (!verifySignature(raw, req.headers["x-signature"] as string | undefined, key)) return reply.code(401).send({ error: "bad signature" });
      const result = await inbox.accept(req.body as TamarinMessage);
      return { ok: true, result };
    });
  });
}
