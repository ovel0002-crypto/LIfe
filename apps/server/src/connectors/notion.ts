import { newId, type AreaKind, type Task } from "@life/core";
import { config } from "../config";
import type { Store } from "../store";

/**
 * Notion: your engineering team's action items → tasks (read-only).
 * Needs an integration token (internal integration made by a workspace owner, or a public
 * integration you authorise on just the action-items database). Share the database with it.
 *
 * Property names differ between teams, so they're configurable.
 */
export interface NotionConfig {
  databaseId: string;
  /** Your name or Notion user id as it appears in the assignee property. */
  me: string;
  titleProp: string;
  assigneeProp: string;
  statusProp: string;
  dueProp: string;
  projectProp?: string;
  doneValues: string[];
  /** Also import unassigned items? */
  includeUnassigned: boolean;
  area: AreaKind;
  lastSync?: string;
}

export const defaultNotionConfig: Omit<NotionConfig, "databaseId" | "me"> = {
  titleProp: "Name",
  assigneeProp: "Assignee",
  statusProp: "Status",
  dueProp: "Due",
  projectProp: "Project",
  doneValues: ["Done", "Complete", "Completed", "Shipped"],
  includeUnassigned: false,
  area: "uni",
};

type NotionProp = Record<string, unknown> & { type: string };
type NotionPage = { id: string; url: string; last_edited_time: string; properties: Record<string, NotionProp> };

function text(p?: NotionProp): string {
  if (!p) return "";
  const arr = (p[p.type] as { plain_text?: string }[] | undefined) ?? [];
  if (p.type === "title" || p.type === "rich_text") return arr.map((x) => x.plain_text ?? "").join("");
  if (p.type === "select" || p.type === "status") return (p[p.type] as { name?: string } | null)?.name ?? "";
  if (p.type === "multi_select") return (p.multi_select as { name: string }[]).map((x) => x.name).join(", ");
  if (p.type === "relation") return (p.relation as { id: string }[]).map((x) => x.id).join(",");
  return "";
}

function people(p?: NotionProp): { id: string; name: string }[] {
  if (!p) return [];
  if (p.type === "people") return (p.people as { id: string; name?: string }[]).map((x) => ({ id: x.id, name: x.name ?? "" }));
  const t = text(p);
  return t ? t.split(",").map((s) => ({ id: s.trim(), name: s.trim() })) : [];
}

function date(p?: NotionProp): string | undefined {
  if (!p || p.type !== "date") return undefined;
  const d = p.date as { start?: string; end?: string } | null;
  const v = d?.end ?? d?.start;
  if (!v) return undefined;
  // Date-only → end of that day local-ish
  return v.length === 10 ? `${v}T17:00:00` : v;
}

export function pageToTask(page: NotionPage, cfg: NotionConfig): { task: Omit<Task, "id" | "createdAt">; mine: boolean; done: boolean } {
  const props = page.properties;
  const title = text(props[cfg.titleProp]) || "Untitled action item";
  const assignees = people(props[cfg.assigneeProp]);
  const me = cfg.me.toLowerCase();
  const mine = assignees.some((a) => a.id.toLowerCase() === me || a.name.toLowerCase().includes(me));
  const status = text(props[cfg.statusProp]);
  const done = cfg.doneValues.map((v) => v.toLowerCase()).includes(status.toLowerCase());
  const project = cfg.projectProp ? text(props[cfg.projectProp]) : "";
  return {
    mine: mine || (cfg.includeUnassigned && assignees.length === 0),
    done,
    task: {
      title: /^[A-Z][a-z]+\b/.test(title) ? title : `Do: ${title}`,
      area: cfg.area,
      status: done ? "done" : "todo",
      estimateMinutes: 60,
      due: date(props[cfg.dueProp]),
      importance: 3,
      source: "notion",
      sourceUrl: page.url,
      notes: [project && `Project: ${project}`, status && `Notion status: ${status}`, `[notion:${page.id}]`].filter(Boolean).join("\n"),
    },
  };
}

async function notionFetch(path: string, body?: unknown) {
  if (!config.notion.token) throw new Error("NOTION_TOKEN not set");
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${config.notion.token}`, "Notion-Version": "2022-06-28", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<{ results: NotionPage[]; has_more: boolean; next_cursor: string | null }>;
}

/** Incremental sync using last_edited_time; updates titles/dues/status, never your estimates. */
export async function syncNotion(store: Store, pages?: NotionPage[]) {
  const cfg = await store.getKv<NotionConfig>("notion");
  if (!cfg) return { skipped: true };
  if (!pages) {
    pages = [];
    let cursor: string | undefined;
    do {
      const r = await notionFetch(`/databases/${cfg.databaseId}/query`, {
        page_size: 100,
        start_cursor: cursor,
        ...(cfg.lastSync ? { filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: cfg.lastSync } } } : {}),
      });
      pages.push(...r.results);
      cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
    } while (cursor);
  }
  const tasks = await store.list("task");
  const batchId = newId("notion_");
  let created = 0;
  let updated = 0;
  for (const page of pages) {
    const { task, mine, done } = pageToTask(page, cfg);
    const existing = tasks.find((t) => t.notes?.includes(`[notion:${page.id}]`));
    if (existing) {
      const patch: Partial<Task> = {};
      if (existing.title !== task.title) patch.title = task.title;
      if (existing.due !== task.due) patch.due = task.due;
      if (done && existing.status !== "done") Object.assign(patch, { status: "done", completedAt: new Date().toISOString() });
      if (!mine && existing.status !== "done") patch.status = "dropped"; // reassigned away from you
      if (Object.keys(patch).length) {
        await store.update("task", existing.id, patch, { actor: "connector", reason: "Changed in Notion", batchId });
        updated++;
      }
      continue;
    }
    if (!mine || done) continue;
    await store.create("task", { id: newId("tsk_"), createdAt: new Date().toISOString(), ...task }, { actor: "connector", reason: "Assigned to you in Notion", batchId });
    created++;
  }
  await store.setKv("notion", { ...cfg, lastSync: new Date().toISOString() });
  return { created, updated, seen: pages.length };
}
