import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { buildApp, createServices, type Services } from "../src/app";
import { Collectors, looksLoggedOut } from "../src/collectors";
import { decrypt, encrypt } from "../src/collectors/secret";
import { config } from "../src/config";
import { openDb } from "../src/db";
import { mintScopedToken } from "../src/mcp";

let s: Services;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  (config as { apiToken?: string }).apiToken = "test-token";
  (config as { secret: string }).secret = "unit-test-secret-1234567890";
  s = createServices(await openDb({ memory: true }));
  await s.store.setPrefs({ timezone: "Australia/Melbourne" }, { actor: "system" });
  app = await buildApp(s);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  (config as { apiToken?: string }).apiToken = undefined;
});

async function mcp(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "test-client", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

describe("Life MCP server", () => {
  it("rejects calls without the token", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("works with a bearer token and lists the tool layer + capture tools", async () => {
    const c = await mcp(`${base}/mcp`, { Authorization: "Bearer test-token" });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_overview", "add_task", "set_focus", "capture_messages", "capture_page", "get_collector_instructions"]));
    const r = await c.callTool({ name: "add_task", arguments: { title: "Email tutor", area: "uni", estimateMinutes: 15 } });
    expect(JSON.parse(text(r)).ok).toBe(true);
    expect((await s.store.list("task")).some((t) => t.title === "Email tutor" && t.source === "claude")).toBe(true);
    await c.close();
  });

  it("works with the secret-path URL form (for URL-only connector setups)", async () => {
    const c = await mcp(`${base}/mcp/test-token`);
    const r = await c.callTool({ name: "get_collector_instructions", arguments: {} });
    expect(text(r)).toMatch(/READ ONLY/);
    await c.close();
  });

  it("scoped tokens are propose-only and limited to their tools", async () => {
    const token = mintScopedToken({ propose: true, source: "gmail", batchId: "scoped1", tools: ["add_event", "list_events"] });
    const c = await mcp(`${base}/mcp`, { Authorization: `Bearer ${token}` });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual(["add_event", "list_events"]);
    await c.callTool({ name: "add_event", arguments: { title: "BBQ at Jess's", day: "2026-11-28", certainty: "unknown-time" } });
    expect((await s.store.list("event")).some((e) => e.title === "BBQ at Jess's")).toBe(false);
    const proposed = await s.store.listChanges({ status: "proposed" });
    expect(proposed.some((p) => p.batchId === "scoped1")).toBe(true);
    await c.close();
  });

  it("LOGIN NEEDED from a browser run creates one human to-do", async () => {
    const c = await mcp(`${base}/mcp`, { Authorization: "Bearer test-token" });
    for (let i = 0; i < 2; i++) await c.callTool({ name: "capture_page", arguments: { source: "instagram", text: "", hint: "LOGIN NEEDED: instagram" } });
    const todos = (await s.store.list("task")).filter((t) => t.notes?.includes("[login:instagram]"));
    expect(todos).toHaveLength(1);
    expect(todos[0].notes).toMatch(/normal Chrome/);
    await c.close();
  });
});

describe("saved sessions", () => {
  it("encrypts and decrypts", () => {
    const blob = encrypt('{"cookies":[1]}', "a-very-long-secret-key");
    expect(blob).not.toContain("cookies");
    expect(decrypt(blob, "a-very-long-secret-key")).toBe('{"cookies":[1]}');
    expect(() => decrypt(blob, "wrong-secret-key-xxxx")).toThrow();
  });

  it("detects logged-out pages", () => {
    expect(looksLoggedOut("https://x.humanforce.com/Account/Login?ReturnUrl=/", false)).toBe(true);
    expect(looksLoggedOut("https://x.humanforce.com/roster", true)).toBe(true);
    expect(looksLoggedOut("https://x.humanforce.com/roster/my-shifts", false)).toBe(false);
  });
});

describe("browser collector (real Chromium, local pages)", () => {
  let site: FastifyInstance;
  let siteBase: string;
  beforeAll(async () => {
    site = Fastify();
    site.get("/roster", async (req, reply) => {
      const loggedIn = (req.headers.cookie ?? "").includes("sid=ok");
      if (!loggedIn) return reply.redirect("/login");
      return reply.type("text/html").send("<meta charset=\"utf-8\"><h1>My shifts</h1><table><tr><td>Mon 24 Nov</td><td>5:00pm–10:00pm</td><td>Grill'd Clayton</td></tr></table>");
    });
    site.get("/login", async (_req, reply) => reply.type("text/html").send('<form><input type="password"></form>'));
    await site.listen({ port: 0, host: "127.0.0.1" });
    siteBase = `http://127.0.0.1:${(site.server.address() as { port: number }).port}`;
  });
  afterAll(() => site.close());

  function collectors(seen: unknown[]) {
    const fakeTriage = { process: async (i: unknown) => (seen.push(i), { signalId: "s", batchId: "b", summary: "2 shifts", proposed: 1 }) };
    return new Collectors(s.store, fakeTriage as never, s.notifier);
  }

  it("reads the roster with a saved session and hands text + screenshot to triage", async () => {
    const seen: { body?: string; images?: unknown[]; hint?: string }[] = [];
    const c = collectors(seen);
    await c.save({ id: "hf", name: "Humanforce", startUrl: `${siteBase}/roster`, kind: "roster", schedule: { weekday: 7, hour: 18 } });
    await c.saveSession("hf", { cookies: [{ name: "sid", value: "ok", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] });
    const r = await c.run("hf");
    expect(r.status).toBe("captured");
    expect(seen[0].body).toMatch(/5:00pm–10:00pm/);
    expect(seen[0].images).toHaveLength(1);
    expect(seen[0].hint).toMatch(/hard/);
  }, 60_000);

  it("an expired session creates a 'log back in' to-do instead of an error", async () => {
    const seen: unknown[] = [];
    const c = collectors(seen);
    await c.save({ id: "hf2", name: "Humanforce", startUrl: `${siteBase}/roster`, kind: "roster", schedule: { weekday: 7, hour: 18 } });
    await c.saveSession("hf2", { cookies: [], origins: [] });
    const r = await c.run("hf2");
    expect(r.status).toBe("login-needed");
    expect(seen).toHaveLength(0);
    const todo = (await s.store.list("task")).find((t) => t.notes?.includes("[login:hf2]"));
    expect(todo?.title).toBe("Log back into Humanforce");
    expect(todo?.notes).toMatch(/login-site hf2/);
    // Saving a new login ticks the to-do off.
    await c.saveSession("hf2", { cookies: [], origins: [] });
    expect((await s.store.get("task", todo!.id))!.status).toBe("done");
  }, 60_000);
});

describe("Humanforce-style auto-login + roster download", () => {
  let site: FastifyInstance;
  let siteBase: string;
  const ics = readFileSync(new URL("./fixtures/humanforce-roster.ics", import.meta.url), "utf8");
  beforeAll(async () => {
    site = Fastify();
    await site.register(import("@fastify/formbody"));
    site.get("/Account/Login", async (_req, reply) =>
      reply.type("text/html").send('<meta charset="utf-8"><form method="post" action="/Account/Login"><input name="UserName" type="text"><input name="Password" type="password"><button type="submit">Log in</button></form>'),
    );
    site.post("/Account/Login", async (req, reply) => {
      const b = req.body as { UserName?: string; Password?: string };
      if (b.UserName === "oscar" && b.Password === "right-pass") return reply.header("set-cookie", "hf=ok; Path=/").redirect("/Roster");
      return reply.redirect("/Account/Login?error=1");
    });
    site.get("/Roster", async (req, reply) => {
      if (!(req.headers.cookie ?? "").includes("hf=ok")) return reply.redirect("/Account/Login");
      return reply.type("text/html").send('<meta charset="utf-8"><h1>My Roster</h1><a href="/Roster/Download">Roster download</a>');
    });
    site.get("/Roster/Download", async (req, reply) => {
      if (!(req.headers.cookie ?? "").includes("hf=ok")) return reply.code(401).send();
      return reply.header("content-type", "text/calendar").header("content-disposition", 'attachment; filename="Roster.ics"').send(ics);
    });
    await site.listen({ port: 0, host: "127.0.0.1" });
    siteBase = `http://127.0.0.1:${(site.server.address() as { port: number }).port}`;
    await s.store.setPrefs({ timezone: "Australia/Melbourne" }, { actor: "system" });
  });
  afterAll(() => site.close());

  it("logs in with the stored password, downloads the roster file and imports shifts (no AI)", async () => {
    const triageCalls: unknown[] = [];
    const c = new Collectors(s.store, { process: async (i: unknown) => (triageCalls.push(i), { summary: "", proposed: 0 }) } as never, s.notifier);
    await c.save({ id: "luna", name: "Humanforce", startUrl: `${siteBase}/Roster`, kind: "roster", download: true, schedule: { weekday: 7, hour: 18 } });
    await c.saveCredentials("luna", { username: "oscar", password: "right-pass" });
    const r = await c.run("luna");
    expect(r.status).toBe("imported");
    expect(triageCalls).toHaveLength(0);
    const shifts = (await s.store.list("event")).filter((e) => e.externalId?.startsWith("luna:"));
    expect(shifts.length).toBeGreaterThan(3);
    expect(shifts.every((e) => e.lock === "hard" && e.area === "work")).toBe(true);
    // The stored password is never kept in plain text.
    expect(JSON.stringify(await s.store.getKv("cred:luna"))).not.toContain("right-pass");
  }, 90_000);

  it("a wrong password becomes a 'check your password' to-do", async () => {
    const c = new Collectors(s.store, { process: async () => ({ summary: "", proposed: 0 }) } as never, s.notifier);
    await c.save({ id: "luna2", name: "Humanforce", startUrl: `${siteBase}/Roster`, kind: "roster", download: true, schedule: { weekday: 7, hour: 18 } });
    await c.saveCredentials("luna2", { username: "oscar", password: "wrong" });
    const r = await c.run("luna2");
    expect(r.status).toBe("bad-password");
    const todo = (await s.store.list("task")).find((t) => t.notes?.includes("[login:luna2]"));
    expect(todo?.title).toBe("Check your Humanforce password in Life");
  }, 90_000);
});

describe("Tamarin webhook", () => {
  const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  it("verifies the signature and keeps only messages relevant to you", async () => {
    (config as { tamarinSecret?: string }).tamarinSecret = "whsec";
    await s.store.setKv("discord", { channels: ["c1"], myUserId: "42", myNames: ["oscar"], digestMinutes: 30 });
    const post = (payload: object, sig?: string) => {
      const body = JSON.stringify(payload);
      return fetch(`${base}/api/hooks/tamarin`, { method: "POST", headers: { "content-type": "application/json", "x-signature": sig ?? sign(body, "whsec"), "x-webhook-event": "message" }, body });
    };
    const msg = (content: string, extra: object = {}) => ({ event: "message", message_id: "m", channel_id: "c1", author: { id: "7", username: "alex" }, content, ...extra });
    expect((await post(msg("hi"), "sha256=deadbeef")).status).toBe(401);
    expect(await (await post(msg("lol nice"))).json()).toMatchObject({ result: "ignored" });
    expect(await (await post(msg("<@42> can you finish the conveyor CAD by Friday?"))).json()).toMatchObject({ result: "kept" });
    expect(await (await post(msg("oscar we need the governance docs read"))).json()).toMatchObject({ result: "kept" });
    expect(await (await post(msg("sounds good", { reference_author_id: "42" }))).json()).toMatchObject({ result: "kept" });
    expect(await (await post({ ...msg("<@42> hey"), channel_id: "other" })).json()).toMatchObject({ result: "ignored" });
    expect(s.tamarin.pending()).toBe(3);
  });
});
