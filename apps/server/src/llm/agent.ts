import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Source } from "@life/core";
import { anthropicTools, runTool, toolsFor, type ToolContext } from "../agent/tools";
import { config } from "../config";
import { mintScopedToken, revokeScopedToken, scopeOf } from "../mcp";
import type { MemoryStore } from "../memory";
import type { Planner } from "../planner";
import type { Store } from "../store";
import { textOf, type LLM, type Tier } from "./provider";

export interface AgentRequest {
  purpose: string;
  tier: Tier;
  /** Frozen system prompt (cacheable). */
  system: string;
  /** Earlier turns as plain text (chat history). */
  history?: { role: "user" | "assistant"; text: string }[];
  /** This turn's text (already including any <context> block). */
  prompt: string;
  images?: { mediaType: string; data: string }[];
  /** Tool subset; all tools when omitted. */
  toolNames?: string[];
  /** Mutations go to the Review queue instead of being applied. */
  propose: boolean;
  source: Source;
  actor: ToolContext["actor"];
  batchId: string;
  maxTurns?: number;
  effort?: "low" | "medium" | "high";
}

export interface AgentResult {
  text: string;
  mutated: boolean;
  refused?: boolean;
}

export interface AgentDeps {
  store: Store;
  planner: Planner;
  memory: MemoryStore;
  llm: LLM;
}

/**
 * One agent loop for chat, triage and breakdown, with two engines:
 *  - "anthropic": Messages API tool loop (prompt caching, refusal fallback, spend cap)
 *  - "claude-cli": `claude -p` signed into your Claude plan, using Life's own MCP server for tools
 */
export async function runAgent(deps: AgentDeps, req: AgentRequest): Promise<AgentResult> {
  return config.llmProvider === "claude-cli" ? runViaCli(deps, req) : runViaApi(deps, req);
}

async function runViaApi(deps: AgentDeps, req: AgentRequest): Promise<AgentResult> {
  const list = toolsFor(req.toolNames);
  const ctx: ToolContext = {
    store: deps.store,
    planner: deps.planner,
    memory: deps.memory,
    batchId: req.batchId,
    actor: req.actor,
    propose: req.propose,
    source: req.source,
    mutated: false,
  };
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of req.history ?? []) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role && typeof last.content === "string") last.content += `\n\n${m.text}`;
    else messages.push({ role: m.role, content: m.text });
  }
  if (messages[0]?.role === "assistant") messages.shift();
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...(req.images ?? []).map(
      (img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data } }) as Anthropic.Beta.BetaImageBlockParam,
    ),
    { type: "text", text: req.prompt },
  ];
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "user") lastMsg.content = [{ type: "text", text: String(lastMsg.content) }, ...content];
  else messages.push({ role: "user", content });

  let text = "";
  for (let i = 0; i < (req.maxTurns ?? 10); i++) {
    const res = await deps.llm.create({ purpose: req.purpose, tier: req.tier, system: req.system, messages, tools: anthropicTools(list), maxTokens: 8000, effort: req.effort });
    if (res.stop_reason === "refusal") return { text: "I can't help with that one.", mutated: ctx.mutated, refused: true };
    messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || uses.length === 0) {
      text = textOf(res);
      break;
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      const r = await runTool(list, u.name, u.input, ctx);
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.content, is_error: r.isError || undefined });
    }
    messages.push({ role: "user", content: results });
  }
  return { text, mutated: ctx.mutated };
}

const CLI_MODEL: Record<Tier, string> = { fast: process.env.LIFE_CLI_MODEL_FAST ?? "haiku", smart: process.env.LIFE_CLI_MODEL_SMART ?? "sonnet" };

async function runViaCli(deps: AgentDeps, req: AgentRequest): Promise<AgentResult> {
  const dir = await mkdtemp(join(tmpdir(), "life-agent-"));
  const names = toolsFor(req.toolNames).map((t) => t.name);
  const token = mintScopedToken({ propose: req.propose, source: req.source, batchId: req.batchId, tools: names });
  try {
    const imagePaths: string[] = [];
    for (const [i, img] of (req.images ?? []).entries()) {
      const p = join(dir, `image${i}.${img.mediaType.includes("jpeg") ? "jpg" : "png"}`);
      await writeFile(p, Buffer.from(img.data, "base64"));
      imagePaths.push(p);
    }
    const base = (config.selfUrl ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, "");
    const mcpConfig = join(dir, "mcp.json");
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { life: { type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }));

    const transcript = (req.history ?? []).map((m) => `${m.role === "user" ? "User" : "You (Life)"}: ${m.text}`).join("\n\n");
    const prompt = [
      transcript ? `<earlier_conversation>\n${transcript}\n</earlier_conversation>` : "",
      imagePaths.length ? `Images for this turn (open each with the Read tool): ${imagePaths.join(", ")}` : "",
      req.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    const allowed = [...names.map((n) => `mcp__life__${n}`), ...(imagePaths.length ? ["Read"] : [])];
    const args = [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      CLI_MODEL[req.tier],
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig,
      "--system-prompt",
      `${req.system}\n\nYour tools are the "life" MCP tools (mcp__life__*). Use them to read and change the user's plan. Reply to the user in plain text when done.`,
      "--tools",
      imagePaths.length ? "Read" : "",
      "--allowedTools",
      ...allowed,
      "--add-dir",
      dir,
      "--max-turns",
      String((req.maxTurns ?? 10) * 2),
    ];
    const out = await spawnClaude(args, prompt, dir);
    const scope = scopeOf(token);
    await deps.store.recordUsage({
      purpose: `cli:${req.purpose}`,
      model: CLI_MODEL[req.tier],
      input: out.usage?.input_tokens ?? 0,
      output: out.usage?.output_tokens ?? 0,
      cacheRead: out.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: out.usage?.cache_creation_input_tokens ?? 0,
      costUsd: 0, // runs on your Claude plan, not API credit
    });
    return { text: out.result.trim(), mutated: Boolean(scope?.mutated) };
  } finally {
    revokeScopedToken(token);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface CliOutput {
  result: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function spawnClaude(args: string[], stdin: string, cwd: string): Promise<CliOutput> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.LIFE_CLAUDE_BIN ?? "claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGTERM"), 5 * 60_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as CliOutput;
        if (j.is_error) return reject(new Error(`claude -p error: ${j.result?.slice(0, 400)}`));
        resolve(j);
      } catch {
        reject(new Error(`claude -p failed (${code}): ${(err || out).slice(0, 500)}`));
      }
    });
    p.stdin.end(stdin);
  });
}
