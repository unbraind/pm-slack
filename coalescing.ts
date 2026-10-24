/** Deterministic delivery planning, independent of tracker state and webhook transport. */
import { createHash } from "node:crypto";
import type { OutboxEvent } from "./outbox.ts";

/** A committed lifecycle intent; destinations are opaque hashes, never credentials. */
export interface CoalescingEvent {
  /** Original durable outbox key. */
  key: string;
  /** Item whose transitions are related. */
  item: string;
  /** Canonical lifecycle transition. */
  event: OutboxEvent;
  /** Committed item-history revision. */
  revision: string;
  /** Frozen destination identity. */
  destination: string;
  /** Committed timestamp in epoch milliseconds; zero denotes legacy intents. */
  at: number;
  /** Priority at the transition, not the item's current priority. */
  priority: number;
}

/** Explicit attention budget for one drain; urgent events do not consume it. */
export interface CoalescingOptions {
  /** Maximum routine notifications, from zero to one hundred; default five. */
  budget?: number;
  /** Fixed UTC window width in milliseconds, from one second to one day; default one minute. */
  windowMs?: number;
  /** Observation clock; default current time. Fixed clocks make previews reproducible. */
  now?: number;
}

/** Why an original event did or did not get its own notification. */
export type CoalescingDisposition = "bypass" | "coalesced" | "deferred" | "waiting";

/** Complete item-level evidence for one original event. */
export interface CoalescingReceipt {
  /** Original durable event key. */
  key: string;
  /** Original item identity. */
  item: string;
  /** Original lifecycle event. */
  event: OutboxEvent;
  /** Original committed revision. */
  revision: string;
  /** Bypass, grouped, over budget, or still in an open window. */
  disposition: CoalescingDisposition;
  /** Stable group identity, including for deferred and waiting groups. */
  notification: string;
}

/** One bounded notification with a complete list of contributing event keys. */
export interface CoalescedNotification {
  /** Hash of canonical member keys, independent of arrival order. */
  key: string;
  /** Frozen destination; groups never cross route boundaries. */
  destination: string;
  /** All original events, sorted by their durable keys. */
  keys: string[];
  /** True means preserve the original payload and bypass every routine bound. */
  urgent: boolean;
  /** Bounded, credential-free summary; urgent delivery uses the original payload. */
  text: string;
}

/** Complete SDK plan; CLI inspection pages the evidence rather than losing it. */
export interface CoalescingPlan {
  /** Exact number of original lifecycle events. */
  events: number;
  /** Urgent notifications outside the routine budget. */
  urgent: number;
  /** Original events represented by selected routine summaries. */
  coalesced: number;
  /** Original events retained pending because the budget was exhausted. */
  deferred: number;
  /** Original events retained pending until their fixed window closes. */
  waiting: number;
  /** Urgent notifications first, followed by oldest eligible routine groups. */
  notifications: CoalescedNotification[];
  /** Exactly one receipt per input event, sorted by durable key. */
  receipts: CoalescingReceipt[];
}

/** Stable, public refusal with a concrete recovery action and host-compatible shape. */
export class CoalescingError extends Error {
  /** Expected usage refusal status. */
  readonly exitCode = 2;
  /** Stable machine-readable refusal category. */
  readonly code = "invalid_coalescing_input";
  /** Operator action without private paths or input content. */
  readonly remedy = "Use unique canonical lifecycle events (at most 10000), safe identifiers, priorities 0..4, budget 0..100, windowMs 1000..86400000 and a nonnegative integer clock.";
  /** Host JSON refusal renderer's recovery field. */
  readonly remediation = this.remedy;
  /** Structured expected-error context. */
  readonly context = { code: this.code, nextSteps: [this.remedy] };
  /** Construct a safe refusal without reflecting input data. */
  constructor() { super("Invalid coalescing input; inspect remedy."); this.name = "PmCliError"; }
}

const events: readonly string[] = ["create", "close", "block", "cancel", "open", "start", "unblock", "reopen"];

/** Compare identifiers by code point without depending on the process locale. */
function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}

/** Plan same-item, same-destination bursts without sending, reading git, or mutating inputs. */
export function planSlackCoalescing(input: readonly CoalescingEvent[], options: CoalescingOptions = {}): CoalescingPlan {
  const budget = options.budget ?? 5;
  const windowMs = options.windowMs ?? 60000;
  const now = options.now ?? Date.now();
  const identifier = /^[a-zA-Z0-9_.:-]{1,160}$/;
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 100 || !Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 86400000 || !Number.isSafeInteger(now) || now < 0 || input.length > 10000 || new Set(input.map((row) => row.key)).size !== input.length || input.some((row) =>
    ![row.key, row.item, row.revision, row.destination].every((value) => typeof value === "string" && identifier.test(value)) || !events.includes(row.event) || !Number.isSafeInteger(row.at) || row.at < 0 || !Number.isInteger(row.priority) || row.priority < 0 || row.priority > 4)) {
    throw new CoalescingError();
  }
  const ordered = [...input].sort((a, b) => compareText(a.key, b.key));
  const groups = new Map<string, CoalescingEvent[]>();
  for (const row of ordered) {
    const urgent = row.event === "block" || row.priority <= 1;
    const group = JSON.stringify(urgent ? [row.key] : [Math.floor(row.at / windowMs), row.item, row.destination]);
    const members = groups.get(group) ?? [];
    members.push(row);
    groups.set(group, members);
  }
  const result: CoalescingPlan = { events: input.length, urgent: 0, coalesced: 0, deferred: 0, waiting: 0, notifications: [], receipts: [] };
  let routine = 0;
  const sorted = [...groups.values()].sort((a, b) => {
    const first = a[0]!; const second = b[0]!;
    const urgentA = first.event === "block" || first.priority <= 1;
    const urgentB = second.event === "block" || second.priority <= 1;
    return Number(urgentB) - Number(urgentA) || Math.floor(first.at / windowMs) - Math.floor(second.at / windowMs) || compareText(first.item, second.item) || compareText(first.key, second.key);
  });
  for (const members of sorted) {
    const first = members[0]!;
    const urgent = first.event === "block" || first.priority <= 1;
    const keys = members.map((row) => row.key);
    const key = createHash("sha256").update(JSON.stringify(keys)).digest("hex");
    const ready = (Math.floor(first.at / windowMs) + 1) * windowMs <= now;
    const disposition: CoalescingDisposition = urgent ? "bypass" : !ready ? "waiting" : routine >= budget ? "deferred" : "coalesced";
    if (disposition === "coalesced") routine += 1;
    if (disposition === "bypass") result.urgent += 1; else result[disposition] += members.length;
    for (const row of members) result.receipts.push({ key: row.key, item: row.item, event: row.event, revision: row.revision, disposition, notification: key });
    if (disposition === "coalesced" || urgent) {
      const counts = events.map((event) => [event, members.filter((row) => row.event === event).length] as const).filter(([, count]) => count > 0);
      result.notifications.push({ key, destination: first.destination, keys, urgent, text: `pm lifecycle ${first.item}: ${members.length} event(s) (${counts.map(([event, count]) => `${event}:${count}`).join(", ")})` });
    }
  }
  result.receipts.sort((a, b) => compareText(a.key, b.key));
  return result;
}
