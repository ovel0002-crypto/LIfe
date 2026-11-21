import type { Store } from "../store";
import type { TriageAgent } from "../agent/triage";

/**
 * Discord team-server bot (read-only).
 *
 * This is a normal Discord *bot*, invited to the server by an admin, with the Message Content
 * intent. Automating your personal account ("self-bot") breaks Discord's ToS, so we don't.
 *
 * Cost control: messages aren't triaged one by one. Relevant ones (mentions of you, direct asks,
 * dates/deadlines) are buffered per channel and sent to triage as one digest every 30 minutes.
 */
export interface DiscordConfig {
  /** Channel ids the bot may read. Nothing else is read. */
  channels: string[];
  /** Your Discord user id (to detect @mentions) and names people call you. */
  myUserId: string;
  myNames: string[];
  digestMinutes: number;
}

interface Buffered {
  channelName: string;
  lines: string[];
  urls: string[];
}

const ASK = /\b(can you|could you|would you|pls|please|todo|to-do|action item|assigned|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|tonight|next week)|deadline|due|meeting|standup|sync)\b/i;

export function isRelevant(content: string, mentionsMe: boolean, cfg: DiscordConfig): boolean {
  if (mentionsMe) return true;
  const lower = content.toLowerCase();
  if (cfg.myNames.some((n) => n && new RegExp(`\\b${n.toLowerCase()}\\b`).test(lower))) return true;
  return ASK.test(content) && /\b(everyone|team|all|we need|who can)\b/i.test(content);
}

export async function startDiscord(store: Store, triage: TriageAgent, token: string) {
  const cfg = await store.getKv<DiscordConfig>("discord");
  if (!cfg || !cfg.channels.length) return undefined;
  const { Client, Events, GatewayIntentBits } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });
  const buffers = new Map<string, Buffered>();

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    // DMs to the bot = quick capture straight into triage.
    if (!msg.guildId) {
      if (msg.author.id !== cfg.myUserId) return;
      await triage.process({ source: "discord", title: "Note sent to Life bot", body: msg.content, hint: "The user sent this to themselves as a capture" });
      return;
    }
    if (!cfg.channels.includes(msg.channelId)) return;
    const mentionsMe = msg.mentions.users.has(cfg.myUserId);
    if (!isRelevant(msg.content, mentionsMe, cfg)) return;
    const channelName = "name" in msg.channel ? String(msg.channel.name) : msg.channelId;
    const b = buffers.get(msg.channelId) ?? { channelName, lines: [], urls: [] };
    b.lines.push(`${msg.member?.displayName ?? msg.author.username}${mentionsMe ? " (mentions you)" : ""}: ${msg.content}`);
    b.urls.push(msg.url);
    buffers.set(msg.channelId, b);
  });

  const flush = async () => {
    for (const [id, b] of buffers) {
      buffers.delete(id);
      if (!b.lines.length) continue;
      await triage
        .process({
          source: "discord",
          title: `Team Discord #${b.channelName}`,
          body: b.lines.join("\n"),
          url: b.urls[b.urls.length - 1],
          hint: `Messages from the user's engineering team channel. The user is ${cfg.myNames.join(" / ")}. Only create tasks for things asked of the user or they agreed to do; use status waiting for things others will do for the user.`,
        })
        .catch((e) => console.error("discord triage failed", e));
    }
  };
  const timer = setInterval(flush, (cfg.digestMinutes || 30) * 60_000);
  await client.login(token);
  return { client, stop: () => (clearInterval(timer), client.destroy()) };
}
