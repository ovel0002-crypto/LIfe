/**
 * Core domain model for Life.
 *
 * Design rule: change is normal. Almost everything is `flexible` by default,
 * plans can be tentative (`certainty`), progress can be partial, and every
 * mutation is recorded as a revertible `Change`.
 */

export type ID = string;
/** ISO-8601 timestamp with offset, e.g. 2026-11-21T09:00:00+11:00 */
export type ISODateTime = string;
/** Local calendar date, e.g. 2026-11-21 */
export type ISODate = string;

export type AreaKind = "uni" | "work" | "social" | "personal" | "admin" | "health";

/** hard = never moved by the system; soft = ask before moving; flexible = system may move. */
export type Lock = "hard" | "soft" | "flexible";

/** How sure we are an event is happening (and when). */
export type Certainty = "confirmed" | "likely" | "maybe" | "unknown-time";

export type Energy = "low" | "medium" | "high";

export type DayMode = "normal" | "low-energy" | "sick" | "busy" | "free";

export type Source =
  | "you"
  | "chat"
  | "moodle"
  | "timetable"
  | "gmail"
  | "uni-gmail"
  | "gcal"
  | "notion"
  | "discord"
  | "screenshot"
  | "telegram"
  | "claude"
  | "system";

export type TaskStatus = "todo" | "doing" | "waiting" | "done" | "dropped";

export interface Goal {
  id: ID;
  title: string;
  area: AreaKind;
  /** Relative weight 0..2 (1 = normal). */
  weight: number;
  why?: string;
}

export interface Project {
  id: ID;
  title: string;
  area: AreaKind;
  goalId?: ID;
  /** Free-text current stage, e.g. "Stage 2: prototype". */
  stage?: string;
  stages?: string[];
  status: "active" | "paused" | "done";
  notes?: string;
  source?: Source;
  sourceUrl?: string;
}

export interface Task {
  id: ID;
  title: string;
  area: AreaKind;
  projectId?: ID;
  /** Parent task when produced by breakdown. */
  parentId?: ID;
  status: TaskStatus;
  /** Original estimate in minutes. */
  estimateMinutes: number;
  /** Minutes actually spent so far. */
  actualMinutes?: number;
  /** 0..1 fraction complete (partial progress is first-class). */
  progress?: number;
  /** Explicit remaining override (set by re-estimation). */
  remainingMinutes?: number;
  due?: ISODateTime;
  /** Don't schedule before this. */
  earliestStart?: ISODateTime;
  /** "Not today" / push to tomorrow: hidden from planning until then. */
  deferredUntil?: ISODateTime;
  energy?: Energy;
  /** 1 (low) .. 5 (critical). Default 3. */
  importance?: number;
  /** User said this must happen today, regardless of deadline. */
  mustToday?: ISODate;
  /** Manual ordering hint from drag-to-reorder (lower = earlier). */
  manualRank?: number;
  /** Concrete definition of done. */
  doneWhen?: string;
  /** Who/what we're waiting on (status=waiting). */
  waitingOn?: string;
  source: Source;
  sourceUrl?: string;
  createdAt: ISODateTime;
  completedAt?: ISODateTime;
  notes?: string;
}

export interface CalEvent {
  id: ID;
  title: string;
  start: ISODateTime;
  end: ISODateTime;
  lock: Lock;
  certainty: Certainty;
  area?: AreaKind;
  source: Source;
  externalId?: string;
  location?: string;
  /** For `unknown-time` events: the day it happens on. */
  day?: ISODate;
  /**
   * For flexible events (gym, weekly review): where the system may move it.
   * If absent, a flexible event can move anywhere within its own day.
   */
  window?: { earliest: ISODateTime; latest: ISODateTime };
  /** Optional: a short, skippable version (e.g. 15 min weekly review). */
  shortVersionMinutes?: number;
  notes?: string;
}

/** A planned work session for a task (lives on the "Life – Plan" calendar). */
export interface Block {
  id: ID;
  taskId: ID;
  start: ISODateTime;
  end: ISODateTime;
}

export interface Preferences {
  timezone: string;
  /** Local "HH:mm" */
  dayStart: string;
  dayEnd: string;
  quietStart: string;
  quietEnd: string;
  /** Fraction of free time the planner may fill (rest is slack). */
  capacityRatio: number;
  minBlockMinutes: number;
  maxBlockMinutes: number;
  /** Max minutes of a single task per day (spreads work out). */
  maxTaskMinutesPerDay: number;
  /** Plan to finish this many hours before a deadline. */
  deadlineBufferHours: number;
  /** Extra buffer reserved around `maybe` events. */
  maybeBufferMinutes: number;
  /** Capacity reserved on the day of an `unknown-time` event. */
  unknownTimeReserveMinutes: number;
  /** Focus weights keyed by area or project id: 0 = neutral, 1 = strong boost, -0.5 = de-emphasise. */
  focus: Record<string, number>;
  /** Learned ratio actual/estimate by area (1 = estimates are accurate). */
  estimateFactor: Partial<Record<AreaKind, number>>;
  /** When are you sharpest. */
  energyByHour: { morning: Energy; afternoon: Energy; evening: Energy };
}

export const defaultPreferences: Preferences = {
  timezone: "Australia/Melbourne",
  dayStart: "08:00",
  dayEnd: "22:00",
  quietStart: "22:30",
  quietEnd: "07:30",
  capacityRatio: 0.65,
  minBlockMinutes: 25,
  maxBlockMinutes: 90,
  maxTaskMinutesPerDay: 180,
  deadlineBufferHours: 12,
  maybeBufferMinutes: 30,
  unknownTimeReserveMinutes: 120,
  focus: {},
  estimateFactor: {},
  energyByHour: { morning: "high", afternoon: "medium", evening: "low" },
};

/** An ambiguity waiting on the user, batched into one "few things to confirm" card. */
export interface OpenQuestion {
  id: ID;
  question: string;
  /** Why it matters / what it affects. */
  context?: string;
  /** When the answer starts to matter (ask before then). */
  relevantBy?: ISODateTime;
  options?: string[];
  relatedId?: ID;
  source: Source;
  status: "open" | "answered" | "dismissed";
  answer?: string;
  createdAt: ISODateTime;
}

/** Any raw input from any connector. */
export interface Signal {
  id: ID;
  source: Source;
  receivedAt: ISODateTime;
  title: string;
  body?: string;
  url?: string;
  externalId?: string;
  status: "new" | "triaged" | "ignored" | "needs-review";
  summary?: string;
}

export type EntityType =
  | "task"
  | "project"
  | "goal"
  | "event"
  | "question"
  | "signal"
  | "checkin"
  | "preferences"
  | "daymode";

/** Every mutation is a Change so it can be reviewed and undone. */
export interface Change {
  id: ID;
  at: ISODateTime;
  actor: "you" | "assistant" | "system" | "connector";
  entityType: EntityType;
  entityId: ID;
  op: "create" | "update" | "delete";
  before?: unknown;
  after?: unknown;
  reason?: string;
  /** proposed = waiting in Review; applied = live; reverted = undone. */
  status: "proposed" | "applied" | "rejected" | "reverted";
  /** Groups changes made together (one re-flow, one chat turn). */
  batchId?: ID;
}

export interface CheckIn {
  id: ID;
  blockId?: ID;
  taskId?: ID;
  askedAt: ISODateTime;
  response?: "on-it" | "doing-other" | "snooze" | "done" | "partial" | "ignored";
  respondedAt?: ISODateTime;
  note?: string;
}
