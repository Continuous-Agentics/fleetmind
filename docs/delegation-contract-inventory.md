# Delegation contract inventory

> **Status:** Phase 0 extraction baseline. This document freezes the behavior that a channel-neutral delegation runtime must preserve while FleetMind moves from a CLI-owned Slack workflow to an OpenClaw plugin.
>
> **Scope:** Current FleetMind behavior at v1.1.0. It is a compatibility inventory, not a new protocol specification.

## 1. Ownership boundary

The extracted runtime owns task lifecycle enforcement, DDB persistence, NATS publishing/subscription, terminal-event delivery, and the channel delivery context. FleetMind retains fleet provisioning, template rendering, install and upgrade operations, health/recovery, and an optional operator CLI.

The plugin must not make Slack formatting or a Slack permalink canonical task state. Channel adapters render delivery late.

## 2. Durable task contract

The canonical record is `TaskRecord` in `src/runtime/delegation/types.ts` and is written with DynamoDB conditional writes in `src/runtime/delegation/ddb.ts`.

Required compatibility fields:

- Identity/query: `PK` (`TASK#<8-hex-id>`), `task_id`, `v`, `project`, `GSI1PK`, `GSI2PK`, `delegated_at`, and `expires_at`.
- Ownership: `delegated_by` and `worker`.
- Lifecycle: `status`, `lifecycle`, `definition_of_done`, and the transition timestamps.
- Correlation: `tracker_link`, `task_s3_key`, `delegation_thread`, and `delegation_envelope_ts`.

`delegation_thread` and `delegation_envelope_ts` currently carry Slack-specific values, but are optional-at-creation and empty for NATS-only fleets. The plugin must replace them with a channel-neutral delivery context without breaking existing reads during the compatibility window.

## 3. Lifecycle contract

Statuses are:

```text
delegated -> accepted -> shipped -> signed_off -> merged
```

`blocked` and `abandoned` are side transitions. `lifecycle` is either `requires-human-signoff` or `shipped-is-done`.

The existing conditional-write guards are part of the public safety contract:

| Operation | Required state / actor constraint                           |
| --------- | ----------------------------------------------------------- |
| create    | `attribute_not_exists(PK)`                                  |
| accept    | `delegated` and record worker matches caller                |
| ship      | `accepted` and record worker matches caller                 |
| sign off  | `shipped` and `requires-human-signoff`                      |
| merge     | `signed_off`, or `shipped` with `shipped-is-done`           |
| block     | `delegated` or `accepted`, and record worker matches caller |
| abandon   | not `merged` or already `abandoned`                         |

A plugin migration must preserve the rule that a PR-producing task is not done when a worker ships: it remains pending human signoff and merge.

## 4. NATS contract

The current versioned envelope is `TaskEvent` (`v: "1.0"`) with event types `delegation`, `ack`, `progress`, `ship`, and `block`.

Subjects are deliberately asymmetric:

```text
{prefix}.delegation.{worker-id}        # task creation / PM-to-worker delivery
{prefix}.task.{task-id}.ack            # worker-to-PM lifecycle events
{prefix}.task.{task-id}.progress
{prefix}.task.{task-id}.ship
{prefix}.task.{task-id}.block
```

Worker subscribers receive only their delegation subject. PM subscribers receive `{prefix}.task.>`. Consequently a PM does not currently receive a `delegation` event, including a worker self-start emitted by `task create`. That is the still-current behavior described by issue #239; changing it needs an explicit event-model decision rather than an accidental subscription broadening during extraction.

## 5. Current Slack coupling to extract

`src/cli/commands/nats.ts` presently combines protocol handling with these Slack-specific concerns:

- parsing Slack permalink/thread timestamps;
- direct Slack Web API receipts for worker and PM fast paths;
- worker home-channel resolution from a Slack channel binding;
- Slack-specific OpenClaw session-key construction; and
- Slack wording and delivery fallbacks.

`ChannelSchema` currently has only a `slack` variant and `core/channels.ts` only exposes `slackChannel()`. These are adapter responsibilities, not core lifecycle responsibilities. Discord work should begin after the core accepts a provider-neutral delivery context (provider, account, conversation, optional thread/message, and actor identifiers).

## 6. Golden-test gate before extraction

Before moving code into `delegation-core`, create tests that can run unchanged against both the FleetMind implementation and the extracted package:

1. **Record golden tests:** create-task defaults and serialized DDB item shape, including keys, indexes, lifecycle, empty legacy delivery fields, and S3 key.
2. **Transition matrix:** every valid transition succeeds; invalid state/actor combinations fail without changing indexes or timestamps.
3. **Envelope/subject matrix:** every event encodes to the existing v1.0 envelope and exact subject; unknown event handling is explicit.
4. **Terminal delivery contract:** `ship` and `block` resolve the authoritative task delivery context and wake once; missing delivery context falls back safely without suppressing the wake.
5. **Channel neutrality:** the same task/event fixtures work for Slack and a Discord-shaped delivery context; only rendering and session-key adaptation differ.
6. **Compatibility fixtures:** real v0.2 task records and NATS v1.0 envelopes remain readable by the plugin during migration.

## 7. Extraction-ready first implementation slice

1. Extract the pure schemas, lifecycle transition rules, and NATS subject/envelope functions behind a package boundary with the golden tests.
2. Leave the FleetMind CLI as a thin caller of that package; preserve Slack delivery unchanged.
3. Define and persist the provider-neutral delivery context with a backward reader for `delegation_thread` / `delegation_envelope_ts`.
4. Build the OpenClaw plugin and obtain Slack parity before adding Discord.

This sequencing keeps Discord as a proof of the boundary rather than a second copy of Slack-specific lifecycle logic.
