import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { newId } from "@life/core";
import type { LLM } from "../llm/provider";
import { textOf } from "../llm/provider";
import type { MemoryStore } from "../memory";
import type { Planner } from "../planner";
import type { Store } from "../store";
import { anthropicTools, runTool, toolsFor, type ToolContext } from "./tools";

/**
 * Frozen system prompt: never interpolate dates or data into this string (it would break
 * prompt caching). Per-turn context goes in the user message instead.
 */
export const ASSISTANT_SYSTEM = `You are Life, a personal chief-of-staff for one university student. You organise, remind and break things down. You do not do the user's work for them, and you never contact anyone on their behalf.

How the system works:
- A deterministic scheduler places work blocks on the calendar and builds the Today list (Now / Must / Should / Could / Waiting / Tentative). You change the inputs (tasks, events, focus, day modes); the scheduler re-flows automatically after your turn. Never try to place blocks yourself.
- Locks: hard = never moved; soft = ask the user before moving; flexible = the system may move it. Default to flexible/soft. Only use hard when the user says something can't move, or it's an exam or rostered shift.
- Certainty: confirmed / likely / maybe / unknown-time. Plans are often half-formed — record them as maybe or unknown-time instead of inventing details. If a detail matters and is missing, call ask_question rather than guessing.
- Partial progress is normal: use log_progress for "did 30 min" or "half done".
- If the user is tired, sick or slammed, set the day mode instead of piling on.

How to act:
- Be brief and warm, like a good friend who's very organised. No guilt, no lectures.
- Make the change, then say in one or two short lines what changed and what it means for today. Don't ask permission for routine changes — everything is undoable ("undo that").
- Task titles are concrete next actions starting with a verb, sized 25–90 min. Break big or vague things down (break_down_task). If they're stuck, the first step is a 10-minute starter.
- Use the user's timezone for all times. Resolve "Friday", "tonight", "next week" against the current time given in the context.
- When something important about the user's life comes up (a person, a preference, a project milestone, a pattern), call remember. Use recall when people or past decisions come up.
- If the plan shows conflicts, mention the most important one and its options in plain words.`;

export interface ChatResult {
  reply: string;
  batchId: string;
  changed: boolean;
}

export class ChatAgent {
  constructor(
    private store: Store,
    private planner: Planner,
    private memory: MemoryStore,
    private llm: LLM,
  ) {}

  private async contextBlock(): Promise<string> {
    const prefs = await this.store.prefs();
    const now = DateTime.now().setZone(prefs.timezone);
    const today = await this.planner.today();
    const line = (i: { title: string; timeLabel?: string; taskId?: string; eventId?: string }) =>
      `- ${i.title}${i.timeLabel ? ` (${i.timeLabel})` : ""} [${i.taskId ?? i.eventId}]`;
    const sec = (name: string, items: Parameters<typeof line>[0][]) => (items.length ? `${name}:\n${items.map(line).join("\n")}` : "");
    return [
      `Current time: ${now.toFormat("cccc d LLLL yyyy, h:mma")} (${prefs.timezone}, ${now.toISO()})`,
      today.now ? `Now/next: ${today.now.title} (${today.now.timeLabel ?? ""}) [${today.now.taskId ?? today.now.eventId}]` : "",
      sec("Must", today.must),
      sec("Should", today.should),
      sec("Could", today.could),
      sec("Waiting", today.waiting),
      sec("Tentative / questions", today.tentative),
      today.conflicts.length ? `Conflicts:\n${today.conflicts.map((c) => `- ${c.message} Options: ${c.options.join(" | ")}`).join("\n")}` : "",
      Object.keys(prefs.focus).length ? `Focus weights: ${JSON.stringify(prefs.focus)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async send(userText: string, opts: { images?: { mediaType: string; data: string }[] } = {}): Promise<ChatResult> {
    const batchId = newId("turn_");
    const history = await this.store.recentChat(12);
    await this.store.addChat("user", userText);

    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const m of history) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const last = messages[messages.length - 1];
      // Merge consecutive same-role messages to keep strict alternation.
      if (last && last.role === role && typeof last.content === "string") last.content += `\n\n${m.text}`;
      else messages.push({ role, content: m.text });
    }
    if (messages[0]?.role === "assistant") messages.shift();

    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...(opts.images ?? []).map(
        (img) =>
          ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data },
          }) as Anthropic.Beta.BetaImageBlockParam,
      ),
      { type: "text", text: `<context>\n${await this.contextBlock()}\n</context>\n\n${userText}` },
    ];
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "user") {
      lastMsg.content = [{ type: "text", text: String(lastMsg.content) }, ...content];
    } else messages.push({ role: "user", content });

    const list = toolsFor();
    const ctx: ToolContext = {
      store: this.store,
      planner: this.planner,
      memory: this.memory,
      batchId,
      actor: "assistant",
      propose: false,
      source: "chat",
      mutated: false,
    };

    let reply = "";
    for (let i = 0; i < 10; i++) {
      const res = await this.llm.create({
        purpose: "chat",
        tier: "smart",
        system: ASSISTANT_SYSTEM,
        messages,
        tools: anthropicTools(list),
        maxTokens: 8000,
        effort: "medium",
      });
      if (res.stop_reason === "refusal") {
        reply = "I can't help with that one.";
        break;
      }
      messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || uses.length === 0) {
        reply = textOf(res);
        break;
      }
      // Run all tool calls, return all results in one user message.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const r = await runTool(list, u.name, u.input, ctx);
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.content, is_error: r.isError || undefined });
      }
      messages.push({ role: "user", content: results });
    }

    if (ctx.mutated) await this.planner.replan({ reason: "chat" });
    if (!reply) reply = ctx.mutated ? "Done — I've updated your plan." : "Okay.";
    await this.store.addChat("assistant", reply, ctx.mutated ? batchId : undefined);
    return { reply, batchId, changed: ctx.mutated };
  }
}
