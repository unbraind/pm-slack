# Recover a queued lifecycle notification through the SDK

Use a local initialized tracker. Configure notification routing through the usual
environment variables; keep credentials outside source control.

```ts
import {
  SlackOutbox, captureSlackOutbox, OutboxError, slackDestination,
  type OutboxOutcome, type OutboxRecoveryReport,
} from "pm-slack";

const tracker = ".agents/pm";
const outbox = new SlackOutbox(tracker);
try {
  outbox.enable({ events: ["create", "close", "block", "cancel", "open", "start", "unblock", "reopen"], minPriority: 1 }); // Snapshot before lifecycle changes.
  let recovered: OutboxRecoveryReport;
  try { recovered = await captureSlackOutbox(tracker, outbox); }
  catch (error) {
    if (!(error instanceof OutboxError) || error.code !== "history_unavailable") throw error;
    recovered = { inspected: 0, queued: 0, failed: 1 };
  }
  if (recovered.failed) process.exitCode = 2;
  console.log({ recovered, status: outbox.status(10) });
  // To supply your own transport, implement one attempt with explicit outcomes:
  const result = await outbox.drain(async (_destination, payload): Promise<OutboxOutcome> => {
    // Resolve _destination against a trusted credential source first.
    // The example uses one configured destination; applications with routes
    // must check slackDestination(webhook, payload.channel) against _destination.
    const webhook = process.env.PM_SLACK_WEBHOOK;
    if (!webhook) throw new OutboxError("destination_changed", "Restore the configured webhook.");
    if (slackDestination(webhook, payload.channel) !== _destination) {
      throw new OutboxError("destination_changed", "Restore the original webhook and channel.");
    }
    try {
      const response = await fetch(webhook, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (response.ok) return "acknowledged";
      if (response.status === 429) return "retry";
      return response.status < 500 ? "rejected" : "ambiguous";
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") return "retry";
      throw error;
    }
  }, 10);
  console.log(result);
  console.log(result.outcomes); // Delivery proof; counts contains work states only.
  if (result.counts.refused) process.exitCode = 2;
} catch (error) {
  if (error instanceof OutboxError) {
    console.error({ code: error.code, remedy: error.remedy });
    process.exitCode = error.exitCode;
  } else throw error;
} finally {
  outbox.close();
}
```

DNS and connection-refused failures return `retry` because the request never
left; classify them by the socket error code, not by error text. Other thrown
transport failures become `ambiguous` and are not automatically retried.
Redirects are refused without following their target and remain ambiguous because
the original endpoint already received the request.
Throw `OutboxError` only before a request starts. `destination_changed` parks the
receipt as `refused` and allows later destinations to proceed; other typed
refusals leave it pending and rethrow. No refused row counts a remote attempt.
Use `resolve(key, "skip")` to discard a refused row, or restore its original route
and explicitly resolve it for retry. Ambiguity holds later rows for that
destination during the current drain. A reused sender PID requires independent
verification before `resolve(key, decision, { force: true })`.

The enable filter and initial opt-in are committed atomically. If enabling
crashes or returns `storage_unavailable`, restore writable runtime storage and
retry `enable` before making lifecycle changes. The enable filter is snapshotted
once. Call `configureRecovery(filter)` before
future lifecycle changes to adopt new eligibility without backfilling stale
messages. Failed histories are counted separately; healthy queued receipts can
still drain. The example exits nonzero for incomplete recovery or parked refusals.
The example records a caught refusal as a nonzero process status so a scheduled
script does not report success.
Use `pm slack outbox --action drain` for the built-in transport and bounded TOON/JSON.
After checking Slack, reconcile uncertainty with the receipt key and an explicit
`acknowledged` or `retry` decision. Preserve runtime receipts and retained history
across restarts so acknowledged and recovered events keep the same identity.
