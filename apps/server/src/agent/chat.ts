import { DateTime } from "luxon";
import { newId } from "@life/core";
import type { LLM } from "../llm/provider";
import { runAgent } from "../llm/agent";
import type { MemoryStore } from "../memory";
import type { Planner } from "../planner";
import type { Store } from "../store";

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
    const history = (await this.store.recentChat(12)).map((m) => ({ role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant", text: m.text }));
    await this.store.addChat("user", userText);
    const r = await runAgent(
      { store: this.store, planner: this.planner, memory: this.memory, llm: this.llm },
      {
        purpose: "chat",
        tier: "smart",
        system: ASSISTANT_SYSTEM,
        history,
        prompt: `<context>\n${await this.contextBlock()}\n</context>\n\n${userText}`,
        images: opts.images,
        propose: false,
        source: "chat",
        actor: "assistant",
        batchId,
        effort: "medium",
      },
    );
    if (r.mutated) await this.planner.replan({ reason: "chat" });
    const reply = r.text || (r.mutated ? "Done — I've updated your plan." : "Okay.");
    await this.store.addChat("assistant", reply, r.mutated ? batchId : undefined);
    return { reply, batchId, changed: r.mutated };
  }
}
