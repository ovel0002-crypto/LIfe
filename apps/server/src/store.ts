import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  defaultPreferences,
  inverseOf,
  makeChange,
  newId,
  type CalEvent,
  type Change,
  type CheckIn,
  type DayMode,
  type EntityType,
  type Goal,
  type ID,
  type OpenQuestion,
  type Preferences,
  type Project,
  type Signal,
  type Task,
} from "@life/core";
import type { DB } from "./db";
import { changes, chatMessages, entities, kv, usage } from "./db/schema";

type EntityMap = {
  task: Task;
  project: Project;
  goal: Goal;
  event: CalEvent;
  question: OpenQuestion;
  signal: Signal;
  checkin: CheckIn;
  memory: { id: ID; subject: string; kind: string; text: string; type: string; at: string };
};
export type StoredType = keyof EntityMap;

export interface Actor {
  actor: Change["actor"];
  reason?: string;
  batchId?: string;
  /** "proposed" puts the change in the Review queue instead of applying it. */
  propose?: boolean;
}

/**
 * All reads/writes go through here. Every write produces a Change so anything can be reviewed
 * or undone ("undo that").
 */
export class Store {
  constructor(readonly db: DB) {}

  // ---------- generic entities ----------
  async list<T extends StoredType>(type: T): Promise<EntityMap[T][]> {
    const rows = await this.db.select().from(entities).where(eq(entities.type, type));
    return rows.map((r) => r.data as EntityMap[T]);
  }

  async get<T extends StoredType>(type: T, id: ID): Promise<EntityMap[T] | undefined> {
    const rows = await this.db
      .select()
      .from(entities)
      .where(and(eq(entities.type, type), eq(entities.id, id)));
    return rows[0]?.data as EntityMap[T] | undefined;
  }

  private async rawPut(type: string, id: ID, data: unknown) {
    await this.db
      .insert(entities)
      .values({ id, type, data, updatedAt: new Date() })
      .onConflictDoUpdate({ target: entities.id, set: { data, updatedAt: new Date() } });
  }

  private async rawDelete(id: ID) {
    await this.db.delete(entities).where(eq(entities.id, id));
  }

  private async recordChange(c: Change) {
    await this.db.insert(changes).values({ id: c.id, at: new Date(c.at), batchId: c.batchId ?? null, status: c.status, data: c });
  }

  async create<T extends StoredType>(type: T, data: EntityMap[T], who: Actor): Promise<Change> {
    const c = makeChange({
      actor: who.actor,
      entityType: type as EntityType,
      entityId: data.id,
      op: "create",
      after: data,
      reason: who.reason,
      batchId: who.batchId,
      status: who.propose ? "proposed" : "applied",
    });
    if (!who.propose) await this.rawPut(type, data.id, data);
    await this.recordChange(c);
    return c;
  }

  async update<T extends StoredType>(type: T, id: ID, patch: Partial<EntityMap[T]>, who: Actor): Promise<Change | undefined> {
    const before = await this.get(type, id);
    if (!before) return undefined;
    const after = { ...before, ...patch, id } as EntityMap[T];
    const c = makeChange({
      actor: who.actor,
      entityType: type as EntityType,
      entityId: id,
      op: "update",
      before,
      after,
      reason: who.reason,
      batchId: who.batchId,
      status: who.propose ? "proposed" : "applied",
    });
    if (!who.propose) await this.rawPut(type, id, after);
    await this.recordChange(c);
    return c;
  }

  async remove(type: StoredType, id: ID, who: Actor): Promise<Change | undefined> {
    const before = await this.get(type, id);
    if (!before) return undefined;
    const c = makeChange({
      actor: who.actor,
      entityType: type as EntityType,
      entityId: id,
      op: "delete",
      before,
      reason: who.reason,
      batchId: who.batchId,
      status: who.propose ? "proposed" : "applied",
    });
    if (!who.propose) await this.rawDelete(id);
    await this.recordChange(c);
    return c;
  }

  // ---------- changes: review & undo ----------
  async listChanges(opts: { status?: Change["status"]; limit?: number; since?: Date } = {}): Promise<Change[]> {
    const conds = [];
    if (opts.status) conds.push(eq(changes.status, opts.status));
    if (opts.since) conds.push(gte(changes.at, opts.since));
    const rows = await this.db
      .select()
      .from(changes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(changes.at))
      .limit(opts.limit ?? 100);
    return rows.map((r) => r.data as Change);
  }

  async getChange(id: ID): Promise<Change | undefined> {
    const rows = await this.db.select().from(changes).where(eq(changes.id, id));
    return rows[0]?.data as Change | undefined;
  }

  private async setChangeStatus(c: Change, status: Change["status"]) {
    const next = { ...c, status };
    await this.db.update(changes).set({ status, data: next }).where(eq(changes.id, c.id));
  }

  private async applyRaw(op: Change["op"], type: string, id: ID, after: unknown) {
    if (op === "delete") await this.rawDelete(id);
    else await this.rawPut(type, id, after);
  }

  /** Accept a proposed change from the Review queue. */
  async accept(id: ID): Promise<Change | undefined> {
    const c = await this.getChange(id);
    if (!c || c.status !== "proposed") return undefined;
    await this.applyRaw(c.op, c.entityType, c.entityId, c.after);
    await this.setChangeStatus(c, "applied");
    return { ...c, status: "applied" };
  }

  async reject(id: ID): Promise<void> {
    const c = await this.getChange(id);
    if (c && c.status === "proposed") await this.setChangeStatus(c, "rejected");
  }

  /** Undo an applied change by applying its inverse. */
  async revert(id: ID): Promise<boolean> {
    const c = await this.getChange(id);
    if (!c || c.status !== "applied") return false;
    const inv = inverseOf(c);
    await this.applyRaw(inv.op, c.entityType, c.entityId, inv.after);
    await this.setChangeStatus(c, "reverted");
    return true;
  }

  /** Undo a whole batch (one chat turn / one re-flow), newest first. */
  async revertBatch(batchId: ID): Promise<number> {
    const rows = await this.db.select().from(changes).where(eq(changes.batchId, batchId)).orderBy(desc(changes.at));
    let n = 0;
    for (const r of rows) if (await this.revert(r.id)) n++;
    return n;
  }

  async acceptBatch(batchId: ID): Promise<number> {
    const rows = await this.db
      .select()
      .from(changes)
      .where(and(eq(changes.batchId, batchId), eq(changes.status, "proposed")));
    for (const r of rows) await this.accept(r.id);
    return rows.length;
  }

  // ---------- key/value: preferences, day modes, plan cache, cursors ----------
  async getKv<T>(key: string): Promise<T | undefined> {
    const rows = await this.db.select().from(kv).where(eq(kv.key, key));
    return rows[0]?.value as T | undefined;
  }

  async setKv(key: string, value: unknown) {
    await this.db
      .insert(kv)
      .values({ key, value: value as object, updatedAt: new Date() })
      .onConflictDoUpdate({ target: kv.key, set: { value: value as object, updatedAt: new Date() } });
  }

  async prefs(): Promise<Preferences> {
    const p = await this.getKv<Partial<Preferences>>("prefs");
    return { ...defaultPreferences, ...p, focus: { ...(p?.focus ?? {}) }, estimateFactor: { ...(p?.estimateFactor ?? {}) } };
  }

  async setPrefs(patch: Partial<Preferences>, who: Actor) {
    const before = await this.prefs();
    const after = { ...before, ...patch };
    await this.setKv("prefs", after);
    await this.recordChange(
      makeChange({ actor: who.actor, entityType: "preferences", entityId: "prefs", op: "update", before, after, reason: who.reason, batchId: who.batchId }),
    );
    return after;
  }

  async dayModes(): Promise<Record<string, DayMode>> {
    return (await this.getKv<Record<string, DayMode>>("dayModes")) ?? {};
  }

  async setDayMode(date: string, mode: DayMode, who: Actor) {
    const before = await this.dayModes();
    const after = { ...before, [date]: mode };
    if (mode === "normal") delete after[date];
    await this.setKv("dayModes", after);
    await this.recordChange(
      makeChange({ actor: who.actor, entityType: "daymode", entityId: date, op: "update", before: before[date] ?? "normal", after: mode, reason: who.reason, batchId: who.batchId }),
    );
  }

  // ---------- usage & spend cap ----------
  async recordUsage(u: { purpose: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }) {
    await this.db.insert(usage).values({
      id: newId("use_"),
      purpose: u.purpose,
      model: u.model,
      inputTokens: u.input,
      outputTokens: u.output,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
      costUsd: u.costUsd,
    });
  }

  async spendSince(since: Date): Promise<{ total: number; byPurpose: Record<string, number>; calls: number }> {
    const rows = await this.db.select().from(usage).where(gte(usage.at, since));
    const byPurpose: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      total += r.costUsd;
      byPurpose[r.purpose] = (byPurpose[r.purpose] ?? 0) + r.costUsd;
    }
    return { total, byPurpose, calls: rows.length };
  }

  // ---------- chat history ----------
  async addChat(role: "user" | "assistant", text: string, batchId?: string) {
    const id = newId("msg_");
    await this.db.insert(chatMessages).values({ id, role, text, batchId: batchId ?? null });
    return id;
  }

  async recentChat(limit = 20) {
    const rows = await this.db.select().from(chatMessages).orderBy(desc(chatMessages.at)).limit(limit);
    return rows.reverse();
  }

  async lastChatBatch(): Promise<string | undefined> {
    const rows = await this.db.select().from(chatMessages).where(eq(chatMessages.role, "assistant")).orderBy(desc(chatMessages.at)).limit(10);
    return rows.find((r) => r.batchId)?.batchId ?? undefined;
  }

  async listByIds(ids: ID[]) {
    if (!ids.length) return [];
    return this.db.select().from(entities).where(inArray(entities.id, ids));
  }
}
