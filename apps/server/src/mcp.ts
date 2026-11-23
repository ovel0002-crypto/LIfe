import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { newId, type Source } from "@life/core";
import type { Services } from "./app";
import { runTool, toolsFor, type ToolContext } from "./agent/tools";
import { config } from "./config";

/**
 * Life as an MCP server. Lets Claude Desktop (with Claude in Chrome), claude.ai chats and
 * `claude -p` use the same tools as the in-app chat, plus capture tools for weekly browser jobs.
 *
 * Auth:
 *  - `Authorization: Bearer <LIFE_API_TOKEN>` or the URL form `/mcp/<LIFE_API_TOKEN>` (for connector
 *    setups that only take a URL). Full access; changes apply immediately and are undoable.
 *  - Short-lived scoped tokens minted by the server for its own `claude -p` runs: they can be
 *    restricted to some tools and forced to *propose* (Review queue) instead of apply.
 */
export interface Scope {
  propose: boolean;
  source: Source;
  batchId: string;
  tools?: string[];
  expires: number;
  /** Set when the run mutates something, so the caller knows to re-plan. */
  mutated?: boolean;
}

const scoped = new Map<string, Scope>();

export function mintScopedToken(s: Omit<Scope, "expires">, ttlMs = 15 * 60_000): string {
  const token = `scp_${randomBytes(24).toString("hex")}`;
  scoped.set(token, { ...s, expires: Date.now() + ttlMs });
  return token;
}

export function scopeOf(token: string): Scope | undefined {
  return scoped.get(token);
}

export function revokeScopedToken(token: string) {
  scoped.delete(token);
}

export const COLLECTOR_RULES = `Rules for weekly collection runs (Instagram DMs, rosters, any logged-in page):
- READ ONLY. Never type into the page, send, reply, react, like, follow, accept, delete, or click buttons that change anything. Only open pages, scroll, and open conversations to read them.
- Once per run. Don't refresh repeatedly or open more than ~25 conversations.
- If you see a login page, a "suspicious activity"/checkpoint/captcha page, or anything asking you to confirm it's you: STOP immediately and call capture_page with source "browser" and hint "LOGIN NEEDED: <site>" so the user gets a to-do.
- Only collect what matters for planning: invitations, plans (who/what/when/where), questions to the user, things the user promised, changes/cancellations, deadlines, shifts. Skip memes, reels, small talk.
- Pass message text verbatim-ish with sender first names and the time/date shown. Don't summarise away dates or times.
- Finish by calling capture_messages (for chats) or capture_page (for a page like a roster) once.`;

type Resolved = { kind: "full" } | { kind: "scoped"; token: string; scope: Scope };

function resolve(req: FastifyRequest): Resolved | undefined {
  const fromPath = (req.params as { token?: string } | undefined)?.token;
  const fromHeader = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const token = fromPath ?? fromHeader;
  if (token?.startsWith("scp_")) {
    const scope = scoped.get(token);
    if (!scope || scope.expires < Date.now()) return undefined;
    return { kind: "scoped", token, scope };
  }
  if (!config.apiToken) {
    // Dev without a token: only allow loopback callers.
    const ip = req.ip;
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" ? { kind: "full" } : undefined;
  }
  return token === config.apiToken ? { kind: "full" } : undefined;
}

function buildServer(s: Services, auth: Resolved, clientName: () => string) {
  const server = new McpServer({ name: "life", version: "0.2.0" });
  const scope = auth.kind === "scoped" ? auth.scope : undefined;
  const allowed = (name: string) => !scope?.tools || scope.tools.includes(name);
  const batchId = scope?.batchId ?? newId("mcp_");

  const ctx = (): ToolContext => ({
    store: s.store,
    planner: s.planner,
    memory: s.memory,
    batchId,
    actor: scope?.propose ? "connector" : "assistant",
    propose: scope?.propose ?? false,
    source: scope?.source ?? "claude",
    mutated: false,
  });

  for (const t of toolsFor()) {
    if (!allowed(t.name)) continue;
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: unknown) => {
      const c = ctx();
      const r = await runTool([t], t.name, args, c);
      if (c.mutated) {
        if (scope) scope.mutated = true;
        else await s.planner.replan({ reason: `mcp:${clientName()}` });
      }
      return { content: [{ type: "text" as const, text: r.content }], isError: r.isError };
    });
  }

  if (allowed("capture_messages")) {
    server.registerTool(
      "capture_messages",
      {
        description:
          "Hand chat messages you read (e.g. Instagram DMs, group chats) to Life. Life extracts plans, invites, asks and promises and puts them in the user's Review queue. Call once per run with everything relevant.",
        inputSchema: z.object({
          source: z.string().describe("Where these came from, e.g. 'instagram'"),
          messages: z
            .array(z.object({ thread: z.string().optional(), from: z.string(), text: z.string(), when: z.string().optional().describe("Date/time as shown") }))
            .max(400),
          note: z.string().optional(),
        }),
      },
      async (args: { source: string; messages: { thread?: string; from: string; text: string; when?: string }[]; note?: string }) => {
        const body = args.messages.map((m) => `[${m.thread ?? "chat"}] ${m.when ? `(${m.when}) ` : ""}${m.from}: ${m.text}`).join("\n");
        const r = await s.triage.process({
          source: "browser",
          title: `${args.source} messages (${args.messages.length})`,
          body,
          hint: `Messages from the user's ${args.source}, collected by their weekly read-only browser run. ${args.note ?? ""}`,
        });
        await s.store.setKv(`pull:${args.source.toLowerCase()}`, { at: new Date().toISOString(), count: args.messages.length, proposed: r.proposed, summary: r.summary });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, proposed: r.proposed, summary: r.summary }) }] };
      },
    );
  }

  if (allowed("capture_page")) {
    server.registerTool(
      "capture_page",
      {
        description:
          "Hand the contents of a page you read (e.g. a work roster) to Life. Include the visible text; a screenshot (base64 PNG/JPEG) is optional. If the page needed a login or showed a security check, set hint to 'LOGIN NEEDED: <site>'.",
        inputSchema: z.object({
          source: z.string().describe("e.g. 'humanforce'"),
          url: z.string().optional(),
          text: z.string().max(60_000),
          screenshotBase64: z.string().optional(),
          hint: z.string().optional(),
        }),
      },
      async (args: { source: string; url?: string; text: string; screenshotBase64?: string; hint?: string }) => {
        if (args.hint?.startsWith("LOGIN NEEDED")) {
          await s.collectors.loginNeeded(args.source, args.url);
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, todo: "created" }) }] };
        }
        const r = await s.triage.process({
          source: "browser",
          title: `${args.source} page`,
          body: args.text,
          url: args.url,
          images: args.screenshotBase64 ? [{ mediaType: args.screenshotBase64.startsWith("/9j") ? "image/jpeg" : "image/png", data: args.screenshotBase64 }] : undefined,
          hint:
            args.hint === "deadlines" || args.source.toLowerCase() === "moodle"
              ? `Upcoming uni deadlines read from the user's Moodle (Monash) by their browser run. For EACH line: find an existing uni task for that assessment with list_tasks (match by unit code + title); if found, update its due date if it changed; otherwise add_task (area "uni", title "Do <quiz>" / "Finish <assignment>" / "Revise for <exam>", due exactly as shown in the user's timezone, estimate quizzes 45, assignments 360, exams 480 unless the weighting suggests otherwise, sourceUrl = the link). Don't create events for these.`
              : (args.hint ?? `Page from ${args.source}, read by the user's weekly browser run.`),
        });
        await s.store.setKv(`pull:${args.source.toLowerCase()}`, { at: new Date().toISOString(), proposed: r.proposed, summary: r.summary });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, proposed: r.proposed, summary: r.summary }) }] };
      },
    );
  }

  if (allowed("get_collector_instructions")) {
    server.registerTool(
      "get_collector_instructions",
      { description: "Read the rules for weekly read-only browser collection runs before starting one.", inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text" as const, text: COLLECTOR_RULES }] }),
    );
  }
  return server;
}

export async function registerMcp(app: FastifyInstance, s: Services) {
  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = resolve(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    let name = "unknown";
    const body = req.body as { method?: string; params?: { clientInfo?: { name?: string } } } | undefined;
    if (body?.method === "initialize" && body.params?.clientInfo?.name) name = body.params.clientInfo.name;
    if (auth.kind === "full") {
      const seen = (await s.store.getKv<Record<string, string>>("mcpClients")) ?? {};
      if (body?.method === "initialize") await s.store.setKv("mcpClients", { ...seen, [name]: new Date().toISOString() });
    }
    // Stateless: a fresh server + transport per request.
    const server = buildServer(s, auth, () => name);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  for (const url of ["/mcp", "/mcp/:token"]) {
    app.post(url, handle);
    app.get(url, async (_req, reply) => reply.code(405).send({ error: "Use POST (stateless Streamable HTTP)" }));
    app.delete(url, async (_req, reply) => reply.code(405).send({ error: "stateless" }));
  }
}
