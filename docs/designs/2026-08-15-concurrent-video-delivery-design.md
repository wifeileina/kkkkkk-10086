---
design_type: feature
created_at: 2026-08-15
---

## Intent Contract
intent: Ensure independent, successful video delivery when identical or different links arrive concurrently from multiple group chats, and recover automatically from transient Douyin CDN 403 responses.
constraints: Preserve existing parsing commands, response formatting, configuration compatibility, and per-event reply routing.
success_criteria: Concurrent requests never share a writable temporary media path; every event reaches its own send operation; Douyin 403 performs bounded fallback attempts before reporting a clear failure.
risk_level: medium

## Verification Contract
verify_steps:
  - run tests: execute the existing project test or lint command where available
  - check: exercise concurrent requests that resolve to the same video and inspect that paths, retry state, and sends remain distinct
  - confirm: each source event receives a video or a scoped, actionable failure message

## Governance Contract
approval_gates:
  - approve the concurrency and 403 fallback design before implementation
  - review verification output before completion
rollback: revert the focused plugin changes if media delivery or platform compatibility regresses.
ownership: plugin maintainer

## Scope
| Area | In scope | Out of scope |
| --- | --- | --- |
| Media paths | Generate collision-resistant temporary names for every download request | Rework unrelated platform parsers |
| Concurrent delivery | Keep per-event download and send state isolated, including the same source URL | Global job queue or cross-process deduplication |
| Douyin 403 | Retry with bounded, meaningful fallback request profiles | Bypass access controls or use unauthorised credentials |
| Diagnostics | Include platform/status/fallback outcome in failure logs and replies | Redesign all user-facing messages |

## Decisions
| # | Decision | Choice | Rejected alternatives |
| --- | --- | --- | --- |
| 1 | Temporary-file identity | Use a high-entropy per-request identifier rather than a millisecond timestamp | Timestamp-only names can collide under concurrent messages |
| 2 | Event isolation | Retain each event's media result locally until that event's send call completes | File-level shared state allows cross-group overwrites |
| 3 | 403 recovery | Use a small ordered set of safe transport/header fallbacks with delays, then fail clearly | Repeating an identical failing request wastes retries |
| 4 | Scope of state cleanup | Cleanup only the request-owned file after its send lifecycle, preserving existing cache policy | Shared cleanup can delete a file still used by another request |

## Surface
Temporary download naming and 403 retry selection will be centralized in the media download utility so all callers avoid collisions. Douyin's download invocation will use that utility without retaining mutable module-level result state across events.

The existing event object remains the destination for replies. No public command, configuration key, or parser output schema changes are planned.

## Risks & Open Questions
Some CDN 403 responses may represent an expired URL rather than a request-profile issue; these must end in a bounded failure rather than indefinite retries. Validation will use mocked request failures and concurrent calls because reproducing a live CDN 403 deterministically is not reliable.
