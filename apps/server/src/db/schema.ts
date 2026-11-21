import { index, integer, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Single-user system: domain objects live in one typed-JSON table so that every entity
 * can share one generic Change/undo mechanism. Hot fields are indexed via `type`.
 */
export const entities = pgTable(
  "entities",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("entities_type_idx").on(t.type)],
);

export const changes = pgTable(
  "changes",
  {
    id: text("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    batchId: text("batch_id"),
    status: text("status").notNull(),
    data: jsonb("data").notNull(),
  },
  (t) => [index("changes_batch_idx").on(t.batchId), index("changes_at_idx").on(t.at)],
);

export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usage = pgTable("usage", {
  id: text("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  purpose: text("purpose").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
});

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  role: text("role").notNull(),
  /** Display text */
  text: text("text").notNull(),
  /** Change batch produced by this turn (for "undo that"). */
  batchId: text("batch_id"),
});

export const bootstrapSql = `
CREATE TABLE IF NOT EXISTS entities (id text PRIMARY KEY, type text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS entities_type_idx ON entities(type);
CREATE TABLE IF NOT EXISTS changes (id text PRIMARY KEY, at timestamptz NOT NULL, batch_id text, status text NOT NULL, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS changes_batch_idx ON changes(batch_id);
CREATE INDEX IF NOT EXISTS changes_at_idx ON changes(at);
CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS usage (id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), purpose text NOT NULL, model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0, cache_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0, cost_usd real NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_messages (id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), role text NOT NULL, text text NOT NULL, batch_id text);
`;
