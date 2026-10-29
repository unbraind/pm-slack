# Review a queued destination transition

Enable the existing outbox before producing lifecycle events. Keep both routes
configured during review; webhook credentials belong in your existing protected
configuration. The following example assumes `default` identifies the old route
and the `close` selector in `PM_SLACK_ROUTES` identifies the new one.

```bash
pm slack outbox --action enable
pm slack migrate --action bindings --json
pm slack migrate --action bind --alias old --route default --binding-revision 0
pm slack migrate --action bind --alias new --route close --binding-revision 1
pm slack migrate --from old --to new --limit 20 --json
```

Review `counts.movable`, `counts.uncertain`, `counts.held`, `counts.foreign`, the
alias inventory and every paged receipt. `foreign_bindings` reports ignored binding
records. `omitted` counts all receipts outside the selected page; `next_cursor`
is null at completion. A fresh outbox typically returns binding revision 2 after
these two writes; use the actual returned revision on an existing tracker.

```bash
pm slack migrate --action apply --from old --to new \
  --binding-revision 2 --plan-revision <exact-reviewed-plan_revision>
pm slack outbox --action drain --json
```

Apply itself never sends. It commits all eligible moves and its replay journal
in one SQLite transaction. A competing claim wins before migration or sees the
committed new route afterward. Coalesced drains recheck their destination at claim
time. If a peer changed either binding or queue state, review another preview.
After an interrupted apply, retry the exact request: uncommitted SQLite changes
roll back; committed targets are read again. A later peer change is `superseded`
and is never overwritten. No separate saved plan file is imported or trusted.

```ts
import { migrateSlackDestinations, slackDestination } from "pm-slack";

const inventory = migrateSlackDestinations(pmRoot, { action: "bindings" });
migrateSlackDestinations(pmRoot, {
  action: "bind", alias: "new",
  destination: slackDestination(configuredWebhook, configuredChannel),
  channel: configuredChannel ?? null,
  bindingRevision: inventory.binding_revision,
});
const preview = migrateSlackDestinations(pmRoot, {
  action: "preview", from: "old", to: "new", limit: 20, after: 0,
});
// Save these two revisions only after reviewing the complete preview.
const reviewed = { bindingRevision: preview.binding_revision, planRevision: preview.plan_revision! };
const result = migrateSlackDestinations(pmRoot, {
  action: "apply", from: "old", to: "new", ...reviewed,
});
```

To inspect delivery evidence without recovering unfinished attempts, open a
read-only SDK handle and close it after reading:

```ts
import { SlackOutbox } from "pm-slack";

const evidence = new SlackOutbox(pmRoot, { readOnly: true });
try {
  console.log(evidence.status(20));
} finally {
  evidence.close();
}
```

CLI previews and inventories use the same read-only policy through their
after-command hooks. An interrupted sender's evidence and database permissions
stay unchanged; use an explicit writable operation when recovery is intended.

`OutboxError` carries `code`, `exitCode: 2` and `remedy`. `invalid_input` names
the input domains; `disabled` requires enabling the outbox; `not_found` requires
binding both aliases; `binding_changed` and `plan_changed` require review again;
`capacity_exceeded` names the bound; `storage_unavailable` asks to preserve and
restore runtime evidence. The CLI returns `ok: false`, `exit_code`, `code` and
`remediation`. A refusal moves no events and sends no requests. Every operation
works in an initialized non-git tracker.
