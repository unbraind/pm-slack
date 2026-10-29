# Compile Slack payloads with loss receipts

The compiler is offline and read-only. It accepts **unclipped source** and returns a
wire payload plus an exact loss ledger. It never queues, imports, syncs or sends.

```sh
pm slack compile --item task-1 --link https://example.com/items/task-1 --json
pm slack compile --input slack-source.json --payload --json
pm slack compile --input slack-source.json --limit 20 --after 20
```

Default JSON and TOON show at most 20 receipts, sizes, applied bounds,
`total_losses`, `omitted`, `next_cursor` and `source_sha256`. Request `--payload`
to include the bounded wire payload. Bind pages to the same source digest; if it
changes, start again. Neither format echoes excluded bodies. A receipt points
into the **original** wire source, before block indices shift:

```json
{
  "payload": {
    "text": "task-1 is blocked",
    "blocks": [
      {"type":"section","fields":[{"type":"plain_text","text":"task-1: blocked"}]},
      {"type":"section","text":{"type":"plain_text","text":"Full source body goes here"}}
    ]
  },
  "item": "task-1",
  "link": "https://example.com/items/task-1",
  "preserve": ["/text", "/blocks/0/fields/0/text"],
  "bounds": {"blocks": 50, "text": 4000, "bytes": 65536}
}
```

Replace the source body with more than 3,000 UTF-16 units to see a receipt with
`path: /blocks/1/text/text`, `start: 2999`, `end: <original length>` and
`reason: text_limit`. The omitted interval is `[start,end)` in the unchanged
source. The inserted ellipsis is output, not source. Surrogate pairs are never
split. Whole omitted fields have `start: 0`; an omitted divider uses a structural
receipt with a zero-length range. Each lost text field has exactly one receipt,
even when a clipped block is subsequently omitted.

The source schema accepts static header, section, context, divider and URL-button
actions blocks. Unknown properties, interactive callbacks, attachments, duplicate
block/action IDs, sparse arrays, malformed Unicode/URLs and nonfinite/out-of-range
numbers refuse with `invalid_input`, exit 2 and a remedy. This is a deliberately
bounded subset of Block Kit, not a general Slack validator or redaction policy.
Input is capped at 2 MiB of UTF-8 JSON, 500 blocks and 100 entries per field/element
array. There is no whitespace, CRLF or URL normalization.

| Wire dimension | Limit |
| --- | ---: |
| Package JSON UTF-8 bytes | 65,536 |
| Package fallback text, UTF-16 units | 4,000 |
| Blocks | 50 |
| Header / section / section field text | 150 / 3,000 / 2,000 |
| Section fields / context elements / action buttons | 10 / 10 / 25 |
| Context text / button label / button URL | 3,000 / 75 / 3,000 |

These byte/fallback budgets are conservative package policies. Slack documents
[50 message blocks](https://docs.slack.dev/reference/block-kit/blocks/),
[section and field limits](https://docs.slack.dev/reference/block-kit/blocks/section-block/),
and [header limits](https://docs.slack.dev/reference/block-kit/blocks/header-block/).
UTF-16 counting is conservative for supplementary Unicode characters.

Protected blocks are admitted first; optional blocks retain source order. The
compiler clips text, removes excess elements/blocks, then drops optional blocks
from the end to meet the byte budget. Finally it can shorten unprotected fallback
text. It refuses `protected_overflow` if protected content cannot fit. Split the
message or raise the selected budget instead of losing identity/status.

For raw input, **declare every identity, priority, urgent status and other
critical text path in `preserve`**. Recovery buttons are always protected. The
SDK-backed item producer does this automatically for the fallback and its item,
type, status, priority, assignee, parent and complete dependency fields. It makes
no status-name comparisons: every configured status, including custom active,
blocked and terminal statuses, receives the same protection. It reads through
the injected SDK with full, unbounded source output, so core projection loss
cannot masquerade as Slack compilation loss.

```ts
import { compileSlackPayload, compileSlackItem } from "pm-slack";

const compiled = compileSlackPayload(sourceEnvelope);
// Inside an extension command, use the host-injected client:
const fromItem = await compileSlackItem(ctx.sdk.client, "task-1", itemURL);
// Only compiled.payload is Slack wire data. Archive the source and loss ledger
// together if exact recovery of that source revision is needed later.
```

`source_sha256` identifies the schema-validated, unmodified source payload; the
URL is caller supplied and may resolve a newer revision. Retain the original
source with the ledger for exact historic reconstruction. Receipts describe
source exclusions, not a reversible import format.

All existing transport paths now validate outbound payloads through the same
wire schema **before creating a request**. They refuse oversized/malformed
payloads rather than silently compiling an already-truncated renderer result.
Existing renderer previews and persisted outbox records remain readable. To
obtain a complete loss ledger, call the compiler with unclipped source first.

Compilation adds no shared mutable state or retry journal. It observes an SDK
snapshot; the item may change after that read. It makes no lock/isolation claim
and never applies a frozen plan (`commitWorkspaceTransaction` does not exclude
ordinary SDK writers). There are no new import/sync or compensation paths.

Without git, file compilation, item compilation and TOON/JSON receipts work in
a plain SDK-initialized tracker, with no git executable on PATH. Webhook sending
still needs an explicitly configured destination; compilation never does.
