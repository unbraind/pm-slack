# Recover a queued lifecycle notification through the SDK

Use a local initialized tracker. Configure notification routing through the usual
environment variables; keep credentials outside source control.

```ts
import {
  SlackOutbox, captureSlackOutbox, OutboxError, slackDestination,
  type OutboxOutcome,
} from "pm-slack";

const tracker = ".agents/pm";
const outbox = new SlackOutbox(tracker);
try {
  outbox.enable(); // Call before the lifecycle changes you want to retain.
  const recovered = await captureSlackOutbox(tracker, outbox);
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
    const response = await fetch(webhook, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return "acknowledged";
    if (response.status === 429) return "retry";
    return response.status < 500 ? "rejected" : "ambiguous";
  }, 10);
  console.log(result);
} catch (error) {
  if (error instanceof OutboxError) console.error({ code: error.code, remedy: error.remedy });
  else throw error;
} finally {
  outbox.close();
}
```

Thrown transport failures become `ambiguous`; they are not automatically retried.
Throw `OutboxError` only for refusals before a request starts; these leave the
receipt pending without counting a remote attempt and are rethrown to the caller.
Use `pm slack outbox --action drain` for the built-in transport and bounded TOON/JSON.
After checking Slack, reconcile uncertainty with the receipt key and an explicit
`acknowledged` or `retry` decision. Preserve runtime receipts and retained history
across restarts so acknowledged and recovered events keep the same identity.
