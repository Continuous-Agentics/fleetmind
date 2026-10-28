---
name: worker-self-start
version: 1.2.0
description: "Tracker-agnostic worker self-start. Use when a human directly asks you (not via PM delegation) to pick up a discrete piece of work. The human MAY supply a ticket URL (Linear, Jira, GitHub Issues, etc.) recorded as --tracker; no tracker is required and no automated tracker trigger exists. PM bots receiving a worker self-start notice: see bot-delegation § Inbound Self-Start Notices."
---

# Worker Self-Start Protocol

## Choose the execution mode

- **Direct/solo work:** a concrete human request authorizes focused coding within scope. Use the current session for results; no independent fleet row or notice is required by this skill.
- **Same-Gateway native child:** continue the parent's authorized task and report privately to the parent with artifacts, checks and blockers. Do not self-register or post publicly; the parent owns user-facing closeout.
- **Independent fleet worker:** use the flow below only with delegation enabled, configured ledger access and a safe dispatch/ownership path. Retain DDB/S3 authority and the human signoff/merge gates.

## The core rule

**A human directly asking you (NOT via PM delegation) to pick up a discrete piece of work = approval to self-start.** The human MAY supply a ticket or issue URL (Linear, Jira, GitHub Issues, or any other tracker) which you record as the `--tracker` reference. No specific tracker is assumed, and there is no automated tracker trigger — self-start is always initiated by a human speaking to you directly. Ask for missing scope only when the request is vague; the absence of a tracker alone is not a blocker.

## Step 0 — Classify the inbound request

| Check | Action |
| --- | --- |
| Independent fleet assignment arrived from PM | → `bot-reception`; verify the current task and recipient. |
| Native child request from parent | Return privately to parent; skip self-start registration. |
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

**SF-2 (independent fleet only): create the DDB row BEFORE any self-start notice.** `attribute_not_exists(PK)` prevents overwriting an existing row; reread and verify the existing owner/state after a conditional failure.

1. Generate an 8-char hex task ID.
2. Verify safe ownership/dispatch first: the current `task create` may publish a legacy NATS assignment even for self-start. If duplicate execution cannot be excluded, report the gap; do not create or re-dispatch. When safe, create the DDB row with `--lifecycle requires-human-signoff` before any notice.
3. Once actually working this task, reread DDB and acknowledge only if still delegated to you. A legacy auto-ack is not native admission proof.
4. Post an authorized self-start notice on the configured coordination route using trusted provider/account/recipient/thread context. Use provider-appropriate mentions; missing routing blocks delivery.
5. Do the work silently.
6. Ship: write the S3 narrative, then `fleetmind task ship`.

Full commands, exact notice template, and field notes: [references/self-start-flow.md](references/self-start-flow.md).

## Informal start (spike / design question, < 1 day)

- Notice not required while work stays under 1 day.
- For enabled independent fleet work producing non-PR deliverables, use the safe registration flow and explicitly chosen lifecycle. PR-producing work always requires human signoff and finishes at verified merge. Direct/native work uses its parent/session.
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
- ✅ Register independent fleet work safely; direct/native work uses its parent/session.
- ✅ Human approval records `signed_off`; PR work stays active until verified `merged`.
- ✅ Push back on vague or unconfirmed requests — every time.
- ✅ Use `attribute_not_exists(PK)` on DDB row create.
- ✅ Record the tracker URL in `--tracker` if the human provided one; omit if no ticket was referenced.

## Reference files

- [references/self-start-flow.md](references/self-start-flow.md) - full step-by-step for § Self-start flow: exact `task create`/`task ack` commands, notice templates, and field notes.
- [references/pm-inbound-handler.md](references/pm-inbound-handler.md) - full PM-side handler for inbound self-start notices.
