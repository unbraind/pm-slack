/** Deterministic delivery planning, independent of tracker state and webhook transport. */
import { createHash } from "node:crypto";
/** Stable, public refusal with a concrete recovery action and host-compatible shape. */
export class CoalescingError extends Error {
    /** Expected usage refusal status. */
    exitCode = 2;
    /** Stable machine-readable refusal category. */
    code = "invalid_coalescing_input";
    /** Operator action without private paths or input content. */
    remedy = "Use unique canonical lifecycle events (at most 10000), safe identifiers, priorities 0..4, budget 0..100, windowMs 1000..86400000 and a nonnegative integer clock.";
    /** Host JSON refusal renderer's recovery field. */
    remediation = this.remedy;
    /** Structured expected-error context. */
    context = { code: this.code, nextSteps: [this.remedy] };
    /** Construct a safe refusal without reflecting input data. */
    constructor() { super("Invalid coalescing input; inspect remedy."); this.name = "PmCliError"; }
}
const events = ["create", "close", "block", "cancel", "open", "start", "unblock", "reopen"];
/** Compare identifiers by code point without depending on the process locale. */
function compareText(left, right) {
    return Number(left > right) - Number(left < right);
}
/** Plan same-item, same-destination bursts without sending, reading git, or mutating inputs. */
export function planSlackCoalescing(input, options = {}) {
    const budget = options.budget ?? 5;
    const windowMs = options.windowMs ?? 60000;
    const now = options.now ?? Date.now();
    const identifier = /^[a-zA-Z0-9_.:-]{1,160}$/;
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > 100 || !Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 86400000 || !Number.isSafeInteger(now) || now < 0 || input.length > 10000 || new Set(input.map((row) => row.key)).size !== input.length || input.some((row) => ![row.key, row.item, row.revision, row.destination].every((value) => typeof value === "string" && identifier.test(value)) || !events.includes(row.event) || !Number.isSafeInteger(row.at) || row.at < 0 || !Number.isInteger(row.priority) || row.priority < 0 || row.priority > 4)) {
        throw new CoalescingError();
    }
    const ordered = [...input].sort((a, b) => compareText(a.key, b.key));
    const groups = new Map();
    for (const row of ordered) {
        const urgent = row.event === "block" || row.priority <= 1;
        const group = JSON.stringify(urgent ? [row.key] : [Math.floor(row.at / windowMs), row.item, row.destination]);
        const members = groups.get(group) ?? [];
        members.push(row);
        groups.set(group, members);
    }
    const result = { events: input.length, urgent: 0, coalesced: 0, deferred: 0, waiting: 0, notifications: [], receipts: [] };
    let routine = 0;
    const sorted = [...groups.values()].sort((a, b) => {
        const first = a[0];
        const second = b[0];
        const urgentA = first.event === "block" || first.priority <= 1;
        const urgentB = second.event === "block" || second.priority <= 1;
        return Number(urgentB) - Number(urgentA) || Math.floor(first.at / windowMs) - Math.floor(second.at / windowMs) || compareText(first.item, second.item) || compareText(first.key, second.key);
    });
    for (const members of sorted) {
        const first = members[0];
        const urgent = first.event === "block" || first.priority <= 1;
        const keys = members.map((row) => row.key);
        const key = createHash("sha256").update(JSON.stringify(keys)).digest("hex");
        const ready = (Math.floor(first.at / windowMs) + 1) * windowMs <= now;
        const disposition = urgent ? "bypass" : !ready ? "waiting" : routine >= budget ? "deferred" : "coalesced";
        if (disposition === "coalesced")
            routine += 1;
        if (disposition === "bypass")
            result.urgent += 1;
        else
            result[disposition] += members.length;
        for (const row of members)
            result.receipts.push({ key: row.key, item: row.item, event: row.event, revision: row.revision, disposition, notification: key });
        if (disposition === "coalesced" || urgent) {
            const counts = events.map((event) => [event, members.filter((row) => row.event === event).length]).filter(([, count]) => count > 0);
            result.notifications.push({ key, destination: first.destination, keys, urgent, text: `pm lifecycle ${first.item}: ${members.length} event(s) (${counts.map(([event, count]) => `${event}:${count}`).join(", ")})` });
        }
    }
    result.receipts.sort((a, b) => compareText(a.key, b.key));
    return result;
}
//# sourceMappingURL=coalescing.js.map