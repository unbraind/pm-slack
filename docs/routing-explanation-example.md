# Diagnose a suppressed event

```sh
pm slack explain --item demo-task --event create --revision "$REVISION" --event-version "$EVENT_VERSION" --json
```

`REVISION` is the committed SDK history `after_hash`, available through
`listMutationEvents({ full: true })`. `EVENT_VERSION` is the feed event's one-based
`version`, which disambiguates repeated state hashes. The command returns a complete ordered path, even when
filters withheld an event. Route rules appear only as zero-based indices with
`no_match`, `selected`, or `shadowed` decisions. No message content or destination
is disclosed. Omitting `--json` renders the same fields as compact TOON.

```ts
import { explainSlackRouting, SlackRoutingError, OutboxError } from "pm-slack";
import type { SlackRoutingIdentity } from "pm-slack";

/** Diagnose exactly the transition selected from a verified mutation feed. */
async function diagnose(pmRoot: string, identity: SlackRoutingIdentity) {
  try {
    const report = await explainSlackRouting(pmRoot, identity);
    return { outcome: report.outcome, decisions: report.path, uncertainty: report.uncertainty };
  } catch (error) {
    if (error instanceof SlackRoutingError || error instanceof OutboxError) {
      return { code: error.code, remedy: error.remedy };
    }
    throw error;
  }
}
```

A retained event/priority exclusion yields `withheld`. Complete attempt evidence
with a Slack success and no unresolved attempts yields `delivered`, even if today's
configuration differs. A timeout followed by `resolve(key, "skip")` remains
`uncertain`: the operator stopped retries without proving non-delivery. A legacy event
without a retained receipt yields `uncertain`; current routing alone cannot prove
what happened in the past. Urgent policies identify blocker or critical-priority
bypasses, without claiming that an unrecorded bypass was actually executed.

There is no import, export, sync, journaled plan, retry, or state mutation on this
path. Historical replay is an SDK read; repeated diagnoses of older revisions
leave the current SDK document, relationships and history unchanged.
