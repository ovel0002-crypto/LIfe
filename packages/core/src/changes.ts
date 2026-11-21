import type { Change, EntityType, ID } from "./types";

let counter = 0;
/** Short, sortable, collision-resistant id. */
export function newId(prefix = ""): ID {
  counter = (counter + 1) % 1_000_000;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${t}${counter.toString(36)}${r}`;
}

export function makeChange(input: {
  actor: Change["actor"];
  entityType: EntityType;
  entityId: ID;
  op: Change["op"];
  before?: unknown;
  after?: unknown;
  reason?: string;
  status?: Change["status"];
  batchId?: ID;
  at?: string;
}): Change {
  return {
    id: newId("chg_"),
    at: input.at ?? new Date().toISOString(),
    status: input.status ?? "applied",
    ...input,
  } as Change;
}

/**
 * Inverse of a change: applying it restores the `before` state.
 * create -> delete, delete -> create(before), update -> update(before).
 */
export function inverseOf(change: Change): Pick<Change, "op" | "before" | "after" | "entityId" | "entityType"> {
  switch (change.op) {
    case "create":
      return { op: "delete", entityType: change.entityType, entityId: change.entityId, before: change.after, after: undefined };
    case "delete":
      return { op: "create", entityType: change.entityType, entityId: change.entityId, before: undefined, after: change.before };
    case "update":
      return { op: "update", entityType: change.entityType, entityId: change.entityId, before: change.after, after: change.before };
  }
}
