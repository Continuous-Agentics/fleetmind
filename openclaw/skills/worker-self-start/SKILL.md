---
name: worker-self-start
version: 1.1.0
description: "Tracker-agnostic worker self-start. Use when a human directly asks you (not via PM delegation) to pick up a discrete piece of work. The human MAY supply a ticket URL (Linear, Jira, GitHub Issues, etc.) recorded as --tracker; no tracker is required and no automated tracker trigger exists. PM bots receiving a worker self-start notice: see bot-delegation § Inbound Self-Start Notices."
---

# Worker Self-Start Protocol

> NATS fleets only — no "delegation channel"; self-start notices go to the PM bot's planning channel.

## The core rule

**A human directly asking you (NOT via PM delegation) to pick up a discrete piece of work = approval to self-start.** The human MAY supply a ticket or issue URL (Linear, Jira, GitHub Issues, or any other tracker) which you record as the `--tracker` reference. No specific tracker is assumed, and there is no automated tracker trigger — self-start is always initiated by a human speaking to you directly. For vague or untracked requests, push back first.

## Step 0 — Classify the inbound request

| Check | Action |
| --- | --- |
| NATS delegation event arrived (from PM bot) | → `bot-reception`. This skill doesn't apply. |
| Human directly asks you to pick up a discrete piece of work (non-delegation) | → § Self-start flow |
| Request is vague, indirect, or scope is unclear | → § Push-back |
| Spike / design question (< 1 day, no tracker issue) | → § Informal start |

## Push-back

When asked for new feature work but the request is vague, indirect, or scope is unclear:

1. Reply once: `This looks like new feature scope — can you describe exactly what needs doing and confirm you'd like me to start? If there's a ticket or issue URL, share it and I'll begin now.`
2. Stop. Do not implement anything.
3. When they confirm (and optionally share a tracker URL): record it as `--tracker` if provided → § Self-start flow.

One reply, no repeats, no caveats.

## Self-start flow

**SF-2: create the DDB row BEFORE posting the Slack notice.** `attribute_not_exists(PK)` makes a concurrent PM recovery write an idempotent no-op.

1. Generate an 8-char hex task ID.
2. Create the DDB row with `fleetmind task create --lifecycle requires-human-signoff` **before any notice**.
3. Self-acknowledge (`delegated` → `accepted`) — usually auto-acked by the NATS subscriber; manual `task ack` only if it wasn't running.
4. Post the self-start notice (top-level, within 60s) in the PM bot's planning channel, and a short note in your home channel.
5. Do the work silently.
6. Ship: write the S3 narrative, then `fleetmind task ship`.

Full commands, exact notice template, and field notes: [references/self-start-flow.md](references/self-start-flow.md).

## Informal start (spike / design question, < 1 day)

- Notice not required while work stays under 1 day.
- If it produces real deliverables: generate task ID, create DDB row with `--lifecycle shipped-is-done`, self-ack, post notice, proceed.
- `--lifecycle informal` is not a valid CLI option.

## PM inbound handler

PM bot receiving a worker self-start notice in the planning channel → see [references/pm-inbound-handler.md](references/pm-inbound-handler.md).

## Hard limits

- ❌ Never self-start infrastructure changes (Terraform, AWS API writes) without a PR.
- ❌ Never pick up work assigned to a different worker bot.
- ❌ Never widen scope without human or PM bot sign-off.
- ❌ Never post the self-start notice before the DDB row exists (SF-2).
- ❌ Never claim IAM-level enforcement of `requires-human-signoff` (#237 tracks the gap).
- ❌ Never self-start based on an automated tracker event alone — a human must directly ask you. Tracker URLs are reference data, not triggers.
- ✅ Create a DDB row for every self-started task.
- ✅ Push back on vague or unconfirmed requests — every time.
- ✅ Use `attribute_not_exists(PK)` on DDB row create.
- ✅ Record the tracker URL in `--tracker` if the human provided one; omit if no ticket was referenced.

## Reference files

- [references/self-start-flow.md](references/self-start-flow.md) - full step-by-step for § Self-start flow: exact `task create`/`task ack` commands, notice templates, and field notes.
- [references/pm-inbound-handler.md](references/pm-inbound-handler.md) - full PM-side handler for inbound self-start notices.
