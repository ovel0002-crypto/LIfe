import { DateTime } from "luxon";
import { newId, type Signal, type Source } from "@life/core";
import type { LLM } from "../llm/provider";
import { runAgent } from "../llm/agent";
import type { MemoryStore } from "../memory";
import type { Planner } from "../planner";
import type { Store } from "../store";

/** Frozen prompt (cached). */
const TRIAGE_SYSTEM = `You extract what matters for one person's plans from an incoming item: an email, a chat message, a team Discord/Notion item, a page read by their weekly browser run (Moodle, roster), or screenshots of messages, rosters or timetables.

WHAT MATTERS (act on these):
1. Money owed — bill/payment reminders, overdue notices, direct debits, instalments (Afterpay etc.).
   → add_task with the payee and amount in the title ("Pay Afterpay $93.04"), area "admin", due = the due date at 9am local (or end of day if a time isn't given), importance 4 (5 if overdue/final notice), estimateMinutes 10. Put account/reference numbers and what happens if unpaid in notes. Never suggest paying from the email's links.
2. Things that belong in the calendar — bookings, appointments, tickets, interviews, classes, shifts, deadlines.
   → add_event with the exact date/time/location; lock "hard" for appointments/bookings/shifts/exams, "soft" for social plans. If the email lists things to bring or do beforehand, also add a prep task due the day before ("Gather roadworthy cert, rego form, ID and plate tools for VicRoads inspection").
3. Personal messages from real people (not companies) — if they ask something or expect a reply, add_task "Reply to <first name> about <topic>" (area "social" or as fits, estimate 5–10). Plans they mention follow rule 2.
4. Uni deadlines (Moodle pages, unit emails) — add or update a task per assessment: title "Do <quiz>" / "Finish <assignment>", area "uni", due exactly as shown. Check list_tasks first and update the due date of an existing task instead of duplicating it.
5. Asks and promises — things someone asked the user to do, things the user said they'd do, things the user is waiting on (status "waiting").

IGNORE: marketing, sales, newsletters, social-media notifications, receipts that need no action, automated notices with nothing to do. If nothing matters, change nothing.

RULES:
- Check existing tasks/events first (list_tasks / list_events) and update instead of duplicating.
- Plans that aren't confirmed are certainty "maybe"; a day without a time is "unknown-time" with "day". Never invent times or dates.
- Work shifts are lock "hard" certainty "confirmed" area "work". Open/offered shifts are not events — ask_question whether the user wants it.
- Tasks are concrete next actions starting with a verb, with realistic estimates.
- If something important is ambiguous, call ask_question.
- Everything you create goes to the user's Review queue for one-tap approval, so be decisive but accurate.
- Finish with one short line summarising what you found (or "Nothing actionable").`;

const TRIAGE_TOOLS = ["list_tasks", "list_events", "add_task", "update_task", "add_event", "update_event", "ask_question"];

/** Cheap rule prefilter: drop obvious noise before spending any tokens. */
export function prefilter(s: Pick<Signal, "title" | "body">, ignoredSenders: string[] = []): boolean {
  const text = `${s.title}\n${s.body ?? ""}`.toLowerCase();
  const from = senderOf(s.body);
  if (from && ignoredSenders.includes(from)) return false;
  // Anything about money, bookings or plans is kept even from no-reply senders.
  const keep = /\b(due|overdue|payment|pay(able)?|bill|invoice|instal?ment|direct debit|owing|outstanding|balance|deadline|submit|assignment|quiz|exam|extension|shift|roster|booking|booked|appointment|reservation|confirm(ed|ation)|reschedul|cancel(l)?ed|ticket|interview|meeting|tomorrow|tonight|can you|could you|would you|reminder|invite|rsvp|catch up|dinner|party|bbq)\b/;
  if (keep.test(text)) return true;
  const noise = [/unsubscribe/, /no-?reply@/, /\breceipt\b/, /order (confirmation|#)/, /your (weekly|daily) (digest|summary)/, /newsletter/, /% off\b/, /verification code/, /sale ends/];
  return !noise.some((r) => r.test(text));
}

/** "From: Afterpay <donotreply@afterpay.com>" → "donotreply@afterpay.com" */
export function senderOf(body?: string): string | undefined {
  const m = body?.match(/^From:.*?<?([\w.+-]+@[\w.-]+)>?/im);
  return m?.[1]?.toLowerCase();
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

    const ignored = (await this.store.getKv<string[]>("ignoredSenders")) ?? [];
    if (!input.images?.length && !prefilter(signal, ignored)) {
      await this.store.update("signal", signal.id, { status: "ignored", summary: "Filtered as noise" }, { actor: "system" });
      return { signalId: signal.id, batchId, summary: "Filtered as noise", proposed: 0 };
    }

    const sender = senderOf(input.body);
    if (sender) await this.store.setKv(`batchSender:${batchId}`, sender);
    const prefs = await this.store.prefs();
    const now = DateTime.now().setZone(prefs.timezone);
    const rules = prefs.emailImportance;
    const off = rules ? Object.entries(rules).filter(([, on]) => !on).map(([k]) => k) : [];
    const prompt = [
      off.length ? `The user turned OFF these categories, so ignore them: ${off.join(", ")}.` : "",
      `Current time: ${now.toFormat("cccc d LLLL yyyy, h:mma")} (${prefs.timezone}, ${now.toISO()})`,
      `Source: ${input.source}`,
      input.hint ? `What this is: ${input.hint}` : "",
      `Title: ${input.title}`,
      input.url ? `Link: ${input.url}` : "",
      input.body ? `Content:\n${input.body.slice(0, 12_000)}` : "",
      input.images?.length ? `${input.images.length} image(s) attached.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const r = await runAgent(
      { store: this.store, planner: this.planner, memory: this.memory, llm: this.llm },
      {
        purpose: `triage:${input.source}`,
        tier: input.images?.length ? "smart" : "fast",
        system: TRIAGE_SYSTEM,
        prompt,
        images: input.images,
        toolNames: TRIAGE_TOOLS,
        propose: true,
        source: input.source,
        actor: "connector",
        batchId,
        maxTurns: 8,
        effort: "low",
      },
    );
    const summary = r.text || "Done";
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
