import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { newId, type Signal, type Source } from "@life/core";
import type { LLM } from "../llm/provider";
import { textOf } from "../llm/provider";
import type { MemoryStore } from "../memory";
import type { Planner } from "../planner";
import type { Store } from "../store";
import { anthropicTools, runTool, toolsFor, type ToolContext } from "./tools";

/** Frozen prompt (cached). */
const TRIAGE_SYSTEM = `You extract what matters for one person's plans from an incoming item (an email, a chat message, a team Discord/Notion item, or screenshots of messages, rosters or timetables).

Look for: deadlines, events/plans (social, work shifts, uni), things someone asked the user to do, things the user promised, things the user is waiting on, and changes/cancellations to existing plans.

Rules:
- Only act on things relevant to the user. Ignore marketing, receipts, newsletters and chit-chat.
- Check existing tasks/events first (list_tasks / list_events) and update instead of duplicating.
- Plans that aren't confirmed are certainty "maybe"; a day without a time is "unknown-time" with "day". Never invent times or dates.
- Work shifts from a roster are lock "hard" certainty "confirmed". Social plans with others are lock "soft".
- Tasks are concrete next actions starting with a verb, with realistic estimates.
- If something important is ambiguous, call ask_question.
- Everything you create goes to the user's Review queue for one-tap approval, so be decisive but accurate.
- Finish with one short line summarising what you found (or "Nothing actionable").`;

const TRIAGE_TOOLS = ["list_tasks", "list_events", "add_task", "update_task", "add_event", "update_event", "ask_question"];

/** Cheap rule prefilter: drop obvious noise before spending any tokens. */
export function prefilter(s: Pick<Signal, "title" | "body">): boolean {
  const text = `${s.title}\n${s.body ?? ""}`.toLowerCase();
  const noise = [
    /unsubscribe/,
    /no-?reply@/,
    /\breceipt\b/,
    /order (confirmation|#)/,
    /your (weekly|daily) (digest|summary)/,
    /newsletter/,
    /% off\b/,
    /verification code/,
    /sale ends/,
  ];
  const keep = [/due|deadline|submit|assignment|quiz|exam|shift|roster|meeting|tomorrow|tonight|can you|could you|reminder|invite|rsvp|catch up|dinner|party/];
  if (keep.some((r) => r.test(text))) return true;
  return !noise.some((r) => r.test(text));
}

export class TriageAgent {
  constructor(
    private store: Store,
    private planner: Planner,
    private memory: MemoryStore,
    private llm: LLM,
  ) {}

  /**
   * Process one signal (text and/or images). All resulting changes are *proposed* into the Review
   * queue under one batch id.
   */
  async process(input: {
    source: Source;
    title: string;
    body?: string;
    url?: string;
    externalId?: string;
    images?: { mediaType: string; data: string }[];
    hint?: string;
  }): Promise<{ signalId: string; batchId: string; summary: string; proposed: number }> {
    const signal: Signal = {
      id: newId("sig_"),
      source: input.source,
      receivedAt: new Date().toISOString(),
      title: input.title,
      body: input.body?.slice(0, 20_000),
      url: input.url,
      externalId: input.externalId,
      status: "new",
    };
    await this.store.create("signal", signal, { actor: "connector" });
    const batchId = newId("tri_");

    if (!input.images?.length && !prefilter(signal)) {
      await this.store.update("signal", signal.id, { status: "ignored", summary: "Filtered as noise" }, { actor: "system" });
      return { signalId: signal.id, batchId, summary: "Filtered as noise", proposed: 0 };
    }

    const prefs = await this.store.prefs();
    const now = DateTime.now().setZone(prefs.timezone);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...(input.images ?? []).map(
        (img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data } }) as Anthropic.Beta.BetaImageBlockParam,
      ),
      {
        type: "text",
        text: [
          `Current time: ${now.toFormat("cccc d LLLL yyyy, h:mma")} (${prefs.timezone}, ${now.toISO()})`,
          `Source: ${input.source}`,
          input.hint ? `What the user said this is: ${input.hint}` : "",
          `Title: ${input.title}`,
          input.url ? `Link: ${input.url}` : "",
          input.body ? `Content:\n${input.body.slice(0, 12_000)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
    const list = toolsFor(TRIAGE_TOOLS);
    const ctx: ToolContext = {
      store: this.store,
      planner: this.planner,
      memory: this.memory,
      batchId,
      actor: "connector",
      propose: true,
      source: input.source,
      mutated: false,
    };
    let summary = "";
    for (let i = 0; i < 8; i++) {
      const res = await this.llm.create({
        purpose: `triage:${input.source}`,
        tier: input.images?.length ? "smart" : "fast",
        system: TRIAGE_SYSTEM,
        messages,
        tools: anthropicTools(list),
        maxTokens: 4000,
        effort: "low",
      });
      messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !uses.length) {
        summary = textOf(res) || "Done";
        break;
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const r = await runTool(list, u.name, u.input, ctx);
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.content, is_error: r.isError || undefined });
      }
      messages.push({ role: "user", content: results });
    }
    const proposed = (await this.store.listChanges({ status: "proposed", limit: 200 })).filter((c) => c.batchId === batchId).length;
    await this.store.update(
      "signal",
      signal.id,
      { status: proposed ? "needs-review" : "triaged", summary },
      { actor: "system" },
    );
    return { signalId: signal.id, batchId, summary, proposed };
  }
}
