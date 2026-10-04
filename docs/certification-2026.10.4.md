# PM CLI/SDK 2026.10.4 certification

Item: [pm-slack-c104](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-c104.toon).

Consolidates Dependabot #119, #122 and #123, including the exact proposed CodeQL init/analyze SHA. Pins published PM CLI/SDK, pm-ops and pm-changelog 2026.10.4 and current exact devDependencies; updates npm resolution and adds a Bun lock. Peer/manifest floor remains 2026.9.29. Canonical launcher is copied unchanged from the published pm-ops template; regressions cover broken directories, dangling links and inconclusive lookup.

```json
{
  "@types/node": "26.6.4",
  "@unbrained/pm-cli": "2026.10.4",
  "pm-changelog": "2026.10.4",
  "pm-ops": "2026.10.4",
  "typescript": "7.0.2"
}
```

## Validation

- `flock /tmp/claude-1000/heavy-gate.lock npm install` and `flock /tmp/claude-1000/heavy-gate.lock bun install`: pass.
- `flock /tmp/claude-1000/heavy-gate.lock npm run release:check`: pass, 273/273 tests, zero skipped; 100% lines/branches/functions across the enforced runtime source `index.ts`; seven files/51 declarations documented. Audit/pack/changelog/publish attestation/release date checks pass.
- `git diff --exit-code -- dist/` and `git ls-files --error-unmatch dist/`: pass after the fresh gate build; committed output remains current.
- `npm audit --omit=dev` and `npm audit`: zero vulnerabilities. Open Dependabot security alerts: none.
- `npx pm health --strict-exit --require-merge-drivers`: exit 0, ok true. Inherited advisory warnings: `stale_in_progress_items:1` and `provenance_value_domain_invalid:claude-code:role:single_digit:23`.
- `npx pm test pm-slack-c104 --run --only-last --progress`: linked snapshot launcher test passes 9/9. New regressions introduce no skip guards.

Independent statement coverage is unmeasured. The existing gate enforces three dimensions for one runtime source; it does not certify four dimensions or all operational scripts. Follow-up [pm-slack-stcv](https://github.com/unbraind/pm-slack/blob/main/.agents/pm/chores/pm-slack-stcv.toon) tracks independent statement measurement without weakening existing gates.

## Managed GitHub preview

`npx pm package install npm:pm-github@2026.10.4 --project` passed. Read-only `npx pm github sync --repo unbraind/pm-slack --dry-run` returned:

```text
No pm items linked to unbraind/pm-slack (no `gh:unbraind/pm-slack#N` provenance tags).
synced: 0
skipped: 0
planned: 0

```

No GitHub-linked local items means this is zero-case evidence. No GitHub issues were written or scheduled sync enabled. Only the managed manifest is tracked; fresh clones install the ignored extension files with the README command.

## Packed copied-real-tracker dogfood

Ran `flock /tmp/claude-1000/heavy-gate.lock /tmp/claude-1000/dogfood-slack.sh`. `npm pack --silent --pack-destination /tmp/claude-1000` produced `pm-slack-2026.10.3.tgz`. Copied this repository's full `.agents/pm` into `/tmp/claude-1000/cert-wt/pm-slack-dogfood/.agents/pm`, then ran `npm install --save-exact /tmp/claude-1000/pm-slack-2026.10.3.tgz @unbrained/pm-cli@2026.10.4` and activated the tarball with `npx -y @unbrained/pm-cli@2026.10.4 package install /tmp/claude-1000/pm-slack-2026.10.3.tgz --project`.

npm/npx and native Bun (`bunx --bun`) both passed offline test, notify dry-run and digest dry-run. Both digest results report created=82, closed=72, blocked=2, in_progress=3, total=159 activity bucket entries; counts overlap across the 82 source items. No Slack message was sent. Scratch was deleted by the exit trap. Exact commands and outputs:

```text
+ npx -y @unbrained/pm-cli@2026.10.4 slack test --on close --json
{
  "preview": true,
  "event": "close",
  "format": "blockkit",
  "payload": {
    "text": "*[Issue]* Fix login redirect bug closed ✅\nReason: Fixed in commit abc123",
    "blocks": [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "✅ Fix login redirect bug",
          "emoji": true
        }
      },
      {
        "type": "section",
        "fields": [
          {
            "type": "mrkdwn",
            "text": "*Item:*\npm-3c4d"
          },
          {
            "type": "mrkdwn",
            "text": "*Type:*\nIssue"
          },
          {
            "type": "mrkdwn",
            "text": "*Event:*\nclosed"
          },
          {
            "type": "mrkdwn",
            "text": "*Priority:*\ncritical"
          },
          {
            "type": "mrkdwn",
            "text": "*Status:*\nclosed"
          },
          {
            "type": "mrkdwn",
            "text": "*By:*\nbob"
          },
          {
            "type": "mrkdwn",
            "text": "*Assignee:*\nbob"
          }
        ]
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "*Reason:* Fixed in commit abc123"
        }
      },
      {
        "type": "actions",
        "elements": [
          {
            "type": "button",
            "text": {
              "type": "plain_text",
              "text": "View on GitHub",
              "emoji": true
            },
            "url": "https://github.com/unbraind/pm-slack/issues/2",
            "action_id": "pm_slack_open_github"
          }
        ]
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "🤖 pm-slack · pm item pm-3c4d closed"
          }
        ]
      }
    ],
    "mrkdwn": true
  }
}
[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled
+ npx -y @unbrained/pm-cli@2026.10.4 slack notify --title 'Certification preview' --on create --dry-run --json
{
  "dryRun": true,
  "event": "create",
  "format": "blockkit",
  "payload": {
    "text": "*[Note]* Certification preview created 🆕\nPriority: unknown • Type: Note • By: unknown",
    "blocks": [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "🆕 Certification preview",
          "emoji": true
        }
      },
      {
        "type": "section",
        "fields": [
          {
            "type": "mrkdwn",
            "text": "*Item:*\nmanual"
          },
          {
            "type": "mrkdwn",
            "text": "*Type:*\nNote"
          },
          {
            "type": "mrkdwn",
            "text": "*Event:*\ncreated"
          },
          {
            "type": "mrkdwn",
            "text": "*Priority:*\nunknown"
          }
        ]
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "🤖 pm-slack · pm item manual created"
          }
        ]
      }
    ],
    "mrkdwn": true
  }
}
[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled
+ npx -y @unbrained/pm-cli@2026.10.4 slack digest --since 2026-01-01 --dry-run --json
{
  "dryRun": true,
  "format": "blockkit",
  "counts": {
    "created": 82,
    "closed": 72,
    "blocked": 2,
    "in_progress": 3
  },
  "total": 159,
  "window": "since 2026-01-01",
  "payload": {
    "text": "*pm activity digest* (since 2026-01-01) — 159 updates\n\n🆕 *Created* (82)\n• pm-slack-0jzg — A release run bumped and committed a new version every night while publishing was impossible, because the only externally-failable step runs last\n• pm-slack-280u — The release job authenticated with a stored npm token that expired, so publishing stopped while every other gate stayed green\n• pm-slack-c104 — Certify pm-slack on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates\n• pm-slack-fitn — Read Slack digests through the complete SDK corpus and refuse unreadable records\n• pm-slack-5fb5 — Measure all authored source and internal declarations before release approval\n• …and 77 more\n\n✅ *Closed* (72)\n• pm-slack-w4dg — Certify pm CLI 2026.9.23 and adopt the guarded pm-ops merge-driver launcher\n• pm-slack-x0wg — A publish that npm accepts late is reported as failed and the GitHub Release is skipped on bun mirror lag\n• pm-slack-h3ba — Certify pm CLI 2026.9.21 and install merge drivers through the canonical pm-ops launcher\n• pm-slack-gmno — Consume the canonical attestation gate instead of carrying a copy of it\n• pm-slack-i9sz — A failed provenance publish silently falls back to an unattested one\n• …and 67 more\n\n🔄 *In progress* (3)\n• pm-slack-0jzg — A release run bumped and committed a new version every night while publishing was impossible, because the only externally-failable step runs last\n• pm-slack-280u — The release job authenticated with a stored npm token that expired, so publishing stopped while every other gate stayed green\n• pm-slack-c104 — Certify pm-slack on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates\n\n🚫 *Blocked* (2)\n• pm-slack-fitn — Read Slack digests through the complete SDK corpus and refuse unreadable records\n• pm-slack-5fb5 — Measure all authored source and internal declarations before release approval",
    "blocks": [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "📊 pm activity digest",
          "emoji": true
        }
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "since 2026-01-01 · 159 updates"
          }
        ]
      },
      {
        "type": "section",
        "fields": [
          {
            "type": "mrkdwn",
            "text": "🆕 *Created:*\n82"
          },
          {
            "type": "mrkdwn",
            "text": "✅ *Closed:*\n72"
          },
          {
            "type": "mrkdwn",
            "text": "🔄 *In progress:*\n3"
          },
          {
            "type": "mrkdwn",
            "text": "🚫 *Blocked:*\n2"
          }
        ]
      },
      {
        "type": "divider"
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "🆕 *Created* (82)\n• pm-slack-0jzg — A release run bumped and committed a new version every night while publishing was impossible, because the only externally-failable step runs last\n• pm-slack-280u — The release job authenticated with a stored npm token that expired, so publishing stopped while every other gate stayed green\n• pm-slack-c104 — Certify pm-slack on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates\n• pm-slack-fitn — Read Slack digests through the complete SDK corpus and refuse unreadable records\n• pm-slack-5fb5 — Measure all authored source and internal declarations before release approval\n• …and 77 more"
        }
      },
      {
        "type": "divider"
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "✅ *Closed* (72)\n• pm-slack-w4dg — Certify pm CLI 2026.9.23 and adopt the guarded pm-ops merge-driver launcher\n• pm-slack-x0wg — A publish that npm accepts late is reported as failed and the GitHub Release is skipped on bun mirror lag\n• pm-slack-h3ba — Certify pm CLI 2026.9.21 and install merge drivers through the canonical pm-ops launcher\n• pm-slack-gmno — Consume the canonical attestation gate instead of carrying a copy of it\n• pm-slack-i9sz — A failed provenance publish silently falls back to an unattested one\n• …and 67 more"
        }
      },
      {
        "type": "divider"
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "🔄 *In progress* (3)\n• pm-slack-0jzg — A release run bumped and committed a new version every night while publishing was impossible, because the only externally-failable step runs last\n• pm-slack-280u — The release job authenticated with a stored npm token that expired, so publishing stopped while every other gate stayed green\n• pm-slack-c104 — Certify pm-slack on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates"
        }
      },
      {
        "type": "divider"
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "🚫 *Blocked* (2)\n• pm-slack-fitn — Read Slack digests through the complete SDK corpus and refuse unreadable records\n• pm-slack-5fb5 — Measure all authored source and internal declarations before release approval"
        }
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "🤖 pm-slack · pm digest · since 2026-01-01"
          }
        ]
      }
    ],
    "mrkdwn": true
  }
}
[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 slack test --on close --json
{
  "preview": true,
  "event": "close",
  "format": "blockkit",
  "payload": {
    "text": "*[Issue]* Fix login redirect bug closed ✅\nReason: Fixed in commit abc123",
    "blocks": [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "✅ Fix login redirect bug",
          "emoji": true
        }
      },
      {
        "type": "section",
        "fields": [
          {
            "type": "mrkdwn",
            "text": "*Item:*\npm-3c4d"
          },
          {
            "type": "mrkdwn",
            "text": "*Type:*\nIssue"
          },
          {
            "type": "mrkdwn",
            "text": "*Event:*\nclosed"
          },
          {
            "type": "mrkdwn",
            "text": "*Priority:*\ncritical"
          },
          {
            "type": "mrkdwn",
            "text": "*Status:*\nclosed"
          },
          {
            "type": "mrkdwn",
            "text": "*By:*\nbob"
          },
          {
            "type": "mrkdwn",
            "text": "*Assignee:*\nbob"
          }
        ]
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "*Reason:* Fixed in commit abc123"
        }
      },
      {
        "type": "actions",
        "elements": [
          {
            "type": "button",
            "text": {
              "type": "plain_text",
              "text": "View on GitHub",
              "emoji": true
            },
            "url": "https://github.com/unbraind/pm-slack/issues/2",
            "action_id": "pm_slack_open_github"
          }
        ]
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "🤖 pm-slack · pm item pm-3c4d closed"
          }
        ]
      }
    ],
    "mrkdwn": true
  }
}
[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 slack notify --title 'Certification preview' --on create --dry-run --json
{
  "dryRun": true,
  "event": "create",
  "format": "blockkit",
  "payload": {
    "text": "*[Note]* Certification preview created 🆕\nPriority: unknown • Type: Note • By: unknown",
    "blocks": [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "🆕 Certification preview",
          "emoji": true
        }
      },
      {
        "type": "section",
        "fields": [
          {
            "type": "mrkdwn",
            "text": "*Item:*\nmanual"
          },
          {
            "type": "mrkdwn",
            "text": "*Type:*\nNote"
          },
          {
            "type": "mrkdwn",
            "text": "*Event:*\ncreated"
          },
          {
            "type": "mrkdwn",
            "text": "*Priority:*\nunknown"
          }
        ]
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "🤖 pm-slack · pm item manual created"
          }
        ]
      }
    ],
    "mrkdwn": true
  }
}
[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 slack digest --since 2026-01-01 --dry-run --json
{
  "dryRun": true,
  "format": "blockkit",
  "counts": {
    "created": 82,
    "closed": 72,
    "blocked": 2,
    "in_progress": 3
  },
  "total": 159,
  "window": "since 2026-01-01",
  "payload": {
    "text": "*pm activity digest* (since 2026-01-01) — 159 updates\n\n🆕 *Created* (82)\n• pm-slack-0jzg — A release run bumped and committed a new version every night while publishing was impossible, because the only externally-failable step runs last\n• pm-slack-280u — The release job authenticated with a stored npm token that expired, so publishing stopped while every other gate stayed green\n• pm-slack-c104 — Certify pm-slack on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates\n• pm-slack-fitn — Read Slack digests through the complete SDK corpus and refuse unreadable records\n• pm-slack-5fb5 — Measure all authored source and internal declarations before release approval\n• …and 77 more\n\n✅ *Closed* (72)\n• pm-slack-w4dg — Certify pm CLI 2026.9.23 and adopt the guarded pm-ops merge-driver launcher\n• pm-slack-x0wg — A publish that npm accepts late is reported as failed and the GitHub Release is skipped on bun mirror lag\n• pm-slack-h3ba — Certify pm CLI 2026.9.21 and install merge drivers through the canonical pm-ops launcher\n• pm-slack-gmno — Consume the canonical attestation gate instead of carrying a copy of it\n• pm-slack-i9sz — A failed provenance publish silently falls back to an unattested one\n• …and 67 more\n\n🔄 *In progress* (3)\n• pm-slack-0jzg — A release run bumped and committed a new version every night while publishing was impossible, because the only externally-failable step runs last\n• pm-slack-280u — The release job authenticated with a stored npm token that expired, so publishing stopped while every other gate stayed green\n• pm-slack-c104 — Certify pm-slack on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates\n\n🚫 *Blocked* (2)\n• pm-slack-fitn — Read Slack digests through the complete SDK corpus and refuse unreadable records\n• pm-slack-5fb5 — Measure all authored source and internal declarations before release approval",
    "blocks": [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "📊 pm activity digest",
          "emoji": true
        }
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "since 2026-01-01 · 159 updates"
          }
        ]
      },
      {
        "type": "section",
        "fields": [
          {
            "type": "mrkdwn",
            "text": "🆕 *Created:*\n82"
          },
          {
            "type": "mrkdwn",
            "text": "✅ *Closed:*\n72"
          },
          {
            "type": "mrkdwn",
            "text": "🔄 *In progress:*\n3"
          },
          {
            "type": "mrkdwn",
            "text": "🚫 *Blocked:*\n2"
          }
        ]
      },
      {
        "type": "divider"
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "🆕 *Created* (82)\n• pm-slack-0jzg — A release run bumped and committed a new version every night while publishing was impossible, because the only externally-failable step runs last\n• pm-slack-280u — The release job authenticated with a stored npm token that expired, so publishing stopped while every other gate stayed green\n• pm-slack-c104 — Certify pm-slack on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates\n• pm-slack-fitn — Read Slack digests through the complete SDK corpus and refuse unreadable records\n• pm-slack-5fb5 — Measure all authored source and internal declarations before release approval\n• …and 77 more"
        }
      },
      {
        "type": "divider"
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "✅ *Closed* (72)\n• pm-slack-w4dg — Certify pm CLI 2026.9.23 and adopt the guarded pm-ops merge-driver launcher\n• pm-slack-x0wg — A publish that npm accepts late is reported as failed and the GitHub Release is skipped on bun mirror lag\n• pm-slack-h3ba — Certify pm CLI 2026.9.21 and install merge drivers through the canonical pm-ops launcher\n• pm-slack-gmno — Consume the canonical attestation gate instead of carrying a copy of it\n• pm-slack-i9sz — A failed provenance publish silently falls back to an unattested one\n• …and 67 more"
        }
      },
      {
        "type": "divider"
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "🔄 *In progress* (3)\n• pm-slack-0jzg — A release run bumped and committed a new version every night while publishing was impossible, because the only externally-failable step runs last\n• pm-slack-280u — The release job authenticated with a stored npm token that expired, so publishing stopped while every other gate stayed green\n• pm-slack-c104 — Certify pm-slack on PM CLI/SDK 2026.10.4 and consolidate pending dependency updates"
        }
      },
      {
        "type": "divider"
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "🚫 *Blocked* (2)\n• pm-slack-fitn — Read Slack digests through the complete SDK corpus and refuse unreadable records\n• pm-slack-5fb5 — Measure all authored source and internal declarations before release approval"
        }
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "🤖 pm-slack · pm digest · since 2026-01-01"
          }
        ]
      }
    ],
    "mrkdwn": true
  }
}
[pm-slack] PM_SLACK_WEBHOOK not set — notifications disabled
+ rm -rf /tmp/claude-1000/cert-wt/pm-slack-dogfood

```

The pm items remain open for orchestrator verification. CI and substantive bot reviews are assessed separately on the final PR head.
