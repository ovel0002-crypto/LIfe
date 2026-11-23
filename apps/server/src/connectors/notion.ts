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
  /** Statuses meaning "won't happen" → dropped. */
  cancelValues?: string[];
  /** Resolved names for relation ids (filled in during sync). */
  relationNames?: Record<string, string>;
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
  cancelValues: ["Cancelled", "Canceled", "Won't do"],
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

export function pageToTask(
  page: NotionPage,
  cfg: NotionConfig,
): { task: Omit<Task, "id" | "createdAt">; mine: boolean; done: boolean; cancelled: boolean; project: string; parentPageId?: string } {
  const props = page.properties;
  const title = text(props[cfg.titleProp]) || "Untitled action item";
  const assignees = people(props[cfg.assigneeProp]);
  const me = cfg.me.toLowerCase();
  const mine = assignees.some((a) => a.id.toLowerCase() === me || a.name.toLowerCase().includes(me));
  const status = text(props[cfg.statusProp]);
  const done = cfg.doneValues.map((v) => v.toLowerCase()).includes(status.toLowerCase());
  const cancelled = (cfg.cancelValues ?? []).map((v) => v.toLowerCase()).includes(status.toLowerCase());
  // A team tag may be a select ("Executive Admin") or a relation to a Projects database (resolved by id).
  const rawProject = cfg.projectProp ? text(props[cfg.projectProp]) : "";
  const project = rawProject
    .split(",")
    .map((x) => cfg.relationNames?.[x.trim()] ?? x.trim())
    .filter(Boolean)
    .join(", ");
  const parentRel = Object.values(props).find((p) => p.type === "relation" && /parent/i.test(String((p as { name?: string }).name ?? "")));
  const parentPageId = parentRel ? text(parentRel).split(",")[0] || undefined : undefined;
  return {
    mine: mine || (cfg.includeUnassigned && assignees.length === 0),
    done,
    cancelled,
    project,
    parentPageId,
    task: {
      title: /^[A-Z][a-z]+\b/.test(title) ? title : `Do: ${title}`,
      area: cfg.area,
      status: done ? "done" : cancelled ? "dropped" : "todo",
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

async function pageTitle(id: string): Promise<string | undefined> {
  try {
    const p = (await notionFetch(`/pages/${id}`)) as unknown as NotionPage;
    const t = Object.values(p.properties ?? {}).find((x) => x.type === "title");
    return t ? text(t) : undefined;
  } catch {
    return undefined;
  }
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
  // Resolve relation ids (team/project tags) to names once, then cache them.
  const names = { ...(cfg.relationNames ?? {}) };
  if (cfg.projectProp && !pages.every((p) => !p.properties[cfg.projectProp!])) {
    for (const p of pages) {
      const prop = p.properties[cfg.projectProp];
      if (prop?.type !== "relation") continue;
      for (const id of text(prop).split(",").filter(Boolean)) if (!names[id]) names[id] = (await pageTitle(id)) ?? id;
    }
  }
  const cfgWithNames = { ...cfg, relationNames: names };

  const tasks = await store.list("task");
  const projects = await store.list("project");
  const batchId = newId("notion_");
  let created = 0;
  let updated = 0;
  let overdue = 0;
  const projectIdFor = async (name: string) => {
    if (!name) return undefined;
    const first = name.split(",")[0].trim();
    let p = projects.find((x) => x.title.toLowerCase() === first.toLowerCase());
    if (!p) {
      p = { id: newId("prj_"), title: first, area: cfg.area, status: "active", source: "notion" };
      await store.create("project", p, { actor: "connector", reason: "Team in Notion", batchId });
      projects.push(p);
    }
    return p.id;
  };
  const nowMs = Date.now();
  for (const page of pages) {
    const { task, mine, done, cancelled, project } = pageToTask(page, cfgWithNames);
    const existing = tasks.find((t) => t.notes?.includes(`[notion:${page.id}]`));
    if (existing) {
      const patch: Partial<Task> = {};
      if (existing.title !== task.title) patch.title = task.title;
      if (existing.due !== task.due) patch.due = task.due;
      if (done && existing.status !== "done") Object.assign(patch, { status: "done", completedAt: new Date().toISOString() });
      if (cancelled && existing.status !== "dropped") patch.status = "dropped";
      if (!mine && existing.status !== "done") patch.status = "dropped"; // reassigned away from you
      if (Object.keys(patch).length) {
        await store.update("task", existing.id, patch, { actor: "connector", reason: "Changed in Notion", batchId });
        updated++;
      }
      continue;
    }
    if (!mine || done || cancelled) continue;
    const projectId = await projectIdFor(project);
    // Already overdue when first seen → don't flood "Must do"; hold it for a quick keep/done/drop decision.
    const isOverdue = task.due !== undefined && Date.parse(task.due) < nowMs;
    await store.create(
      "task",
      {
        id: newId("tsk_"),
        createdAt: new Date().toISOString(),
        ...task,
        projectId,
        ...(isOverdue ? { status: "waiting" as const, waitingOn: "your decision — overdue in Notion", notes: `${task.notes}\n[overdue-import]` } : {}),
      },
      { actor: "connector", reason: "Assigned to you in Notion", batchId },
    );
    if (isOverdue) overdue++;
    created++;
  }
  await store.setKv("notion", { ...cfgWithNames, lastSync: new Date().toISOString() });
  return { created, updated, overdue, seen: pages.length };
}
