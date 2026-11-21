import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { DateTime } from "luxon";
import { config } from "../config";
import type { Store } from "../store";

/** USD per 1M tokens (Claude API first-party rates). Cache reads ≈0.1×, writes ≈1.25× input. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`Monthly AI budget reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Planning still works; AI features resume next month or when you raise LIFE_MONTHLY_BUDGET_USD.`);
  }
}

export type Tier = "fast" | "smart";

export interface LLMRequest {
  purpose: string;
  tier: Tier;
  /** Static system prompt — keep it byte-stable so it caches. */
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools?: Anthropic.Beta.BetaToolUnion[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

export function costOf(model: string, u: Anthropic.Beta.BetaUsage): number {
  const p = PRICING[model] ?? PRICING["claude-sonnet-5-5"];
  const input = u.input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return (input * p.input + cacheRead * p.input * 0.1 + cacheWrite * p.input * 1.25 + output * p.output) / 1_000_000;
}

/**
 * One place every model call goes through: picks the model for the tier, enforces the monthly
 * spend cap, caches the system prompt, and records usage for the cost dashboard.
 */
export class LLM {
  private client?: Anthropic;
  constructor(private store: Store) {}

  get available(): boolean {
    return config.llmProvider === "claude-cli" || Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  }

  private anthropic(): Anthropic {
    this.client ??= new Anthropic();
    return this.client;
  }

  async monthSpend() {
    const start = DateTime.now().startOf("month").toJSDate();
    return this.store.spendSince(start);
  }

  private async checkBudget() {
    const { total } = await this.monthSpend();
    if (total >= config.monthlyBudgetUsd) throw new BudgetExceededError(total, config.monthlyBudgetUsd);
  }

  async create(req: LLMRequest): Promise<Anthropic.Beta.BetaMessage> {
    await this.checkBudget();
    const model = config.models[req.tier];
    const isSonnet = model.startsWith("claude-sonnet-5-5") || model.startsWith("claude-opus-5-5");
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: req.maxTokens ?? 8000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      output_config: { effort: req.effort ?? (req.tier === "fast" ? "low" : "medium") },
      // Server-side refusal fallback (Sonnet/Opus 5.5): if the main model declines, a fallback model continues.
      ...(isSonnet ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
    const res = await this.anthropic().beta.messages.create(params);
    await this.store.recordUsage({
      purpose: req.purpose,
      model: res.model ?? model,
      input: res.usage.input_tokens ?? 0,
      output: res.usage.output_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
      costUsd: costOf(model, res.usage),
    });
    return res;
  }

  /**
   * Plain text completion. With LIFE_LLM_PROVIDER=claude-cli this runs `claude -p` signed in with
   * your Claude plan (draws on your subscription limits instead of API credit) — used for
   * tool-free jobs like the weekly summary.
   */
  async text(req: Omit<LLMRequest, "tools">): Promise<string> {
    if (config.llmProvider === "claude-cli") {
      const prompt = req.messages
        .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => ("text" in b ? b.text : "")).join("\n")))
        .join("\n\n");
      return runClaudeCli(req.system, prompt);
    }
    const res = await this.create(req);
    return textOf(res);
  }
}

export function textOf(res: Anthropic.Beta.BetaMessage): string {
  return res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function runClaudeCli(system: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p", "--output-format", "json", "--append-system-prompt", system], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude -p failed (${code}): ${err.slice(0, 500)}`));
      try {
        resolve(String(JSON.parse(out).result ?? "").trim());
      } catch {
        resolve(out.trim());
      }
    });
    p.stdin.end(prompt);
  });
}
