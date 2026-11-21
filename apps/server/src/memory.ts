import { newId } from "@life/core";
import { config } from "./config";
import type { Store } from "./store";

export interface MemoryHit {
  text: string;
  subject?: string;
  at?: string;
  score?: number;
}

export type MemoryType = "world" | "experience" | "observation";

/**
 * Long-term memory about you: people, preferences, project state, recurring patterns.
 * Only durable facts are written (never raw emails) — that's the main cost lever.
 */
export interface MemoryStore {
  remember(input: { subject: string; kind: string; text: string; type?: MemoryType }): Promise<void>;
  recall(query: string, opts?: { maxTokens?: number; limit?: number }): Promise<MemoryHit[]>;
}

/** Built-in fallback: keyword recall over facts stored in Postgres. No external services. */
export class LocalMemory implements MemoryStore {
  constructor(private store: Store) {}

  async remember(input: { subject: string; kind: string; text: string; type?: MemoryType }) {
    await this.store.create(
      "memory",
      { id: newId("mem_"), subject: input.subject, kind: input.kind, text: input.text, type: input.type ?? "world", at: new Date().toISOString() },
      { actor: "assistant", reason: "Remembered" },
    );
  }

  async recall(query: string, opts: { limit?: number } = {}) {
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    const all = await this.store.list("memory");
    const scored = all
      .map((m) => {
        const hay = `${m.subject} ${m.text}`.toLowerCase();
        const hits = words.filter((w) => hay.includes(w)).length;
        // Mild recency preference.
        const ageDays = (Date.now() - Date.parse(m.at)) / 86_400_000;
        return { m, score: hits === 0 ? 0 : hits + Math.max(0, 1 - ageDays / 365) * 0.5 };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 12);
    return scored.map(({ m, score }) => ({ text: m.text, subject: m.subject, at: m.at, score }));
  }
}

/**
 * Eunomia adapter (https://github.com/Qyrhal/Eunomia) via its REST tool endpoint
 * `POST /api/tools/:name` with a personal access token (scopes memory:read, memory:write).
 *
 * Cost tuning — configure Eunomia itself with:
 *  - OPENAI_CHAT_MODEL / server chat model UNSET → no server-side extraction, consolidation or
 *    supersession LLM jobs (the expensive part). Recall still works (keyword + full-text + graph).
 *  - No Eunomia connectors (Gmail etc.) — Life already triages those once.
 *  - Optional: embeddings via text-embedding-3-small (1536-dim) for semantic recall; pennies/month.
 * And from here we always pass `max_tokens` on recall to bound context size.
 */
export class EunomiaMemory implements MemoryStore {
  constructor(
    private url: string,
    private token: string,
    private vault?: string,
  ) {}

  private async call(name: string, args: Record<string, unknown>) {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/api/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Eunomia ${name} failed: ${res.status} ${await res.text().catch(() => "")}`);
    return res.json() as Promise<unknown>;
  }

  async remember(input: { subject: string; kind: string; text: string; type?: MemoryType }) {
    await this.call("memory_write", {
      subject_name: input.subject,
      subject_kind: input.kind,
      text: input.text,
      type: input.type ?? "world",
      ...(this.vault ? { vault_id: this.vault } : {}),
    });
  }

  async recall(query: string, opts: { maxTokens?: number; limit?: number } = {}) {
    const out = (await this.call("recall", {
      query: query.slice(0, 2000),
      limit: opts.limit ?? 12,
      max_tokens: opts.maxTokens ?? 1500,
      ...(this.vault ? { vault_id: this.vault } : {}),
    })) as Record<string, unknown>;
    // Be tolerant of result shape: look for an array of hits with text-like fields.
    const arr = (Array.isArray(out) ? out : (out.results ?? out.hits ?? out.memories ?? out.items ?? [])) as Record<string, unknown>[];
    return arr.map((h) => ({
      text: String(h.text ?? h.content ?? h.summary ?? JSON.stringify(h)),
      subject: (h.subject_name ?? h.subject ?? h.entity) as string | undefined,
      at: (h.occurred_at ?? h.at) as string | undefined,
      score: typeof h.score === "number" ? h.score : undefined,
    }));
  }
}

export function createMemory(store: Store): MemoryStore {
  if (config.eunomia.url && config.eunomia.token) return new EunomiaMemory(config.eunomia.url, config.eunomia.token);
  return new LocalMemory(store);
}
