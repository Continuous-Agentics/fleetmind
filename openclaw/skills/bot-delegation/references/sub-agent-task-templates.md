# Sub-agent task templates (canonical)

This file holds the **verbatim, copy-pasteable `task:` briefs** for every sub-agent the PM bot spawns inside the delegation lifecycle. Compose nothing ad-hoc. Pick the variant that matches the trigger, copy the fenced block in full, fill the `<PLACEHOLDERS>`, and paste it into the `task` field of `sessions_spawn`.

The hard rule from SKILL.md § 7a (NO_REPLY-final-turn + at-most-one-threaded-planning-post) is **embedded verbatim at the top of every template** — not by reference. Every spawned sub-agent's prompt independently carries the rule. Do not edit the rule out of a copy.

**Copy literally; never compose ad-hoc.** Prose-only guidance was tried and failed in production: sub-agents composing their own briefs from prose repeatedly leaked top-level "Done. Accomplished: …" Slack posts that should have gone via the tool return instead. Literal, fill-in-the-placeholder templates are the fix — composing a brief from memory/summary reintroduces the exact failure mode this file exists to prevent.

## Placeholder legend

Placeholders are uppercase angle-bracketed tokens. Fill in every one before spawning.

| Placeholder | Meaning |
|---|---|
| `<TASK_ID>` | 8-char hex task id |
| `<PROJECT_SLUG>` | Project slug from DDB `project` attribute |
| `<PLANNING_CHANNEL_ID>` | Channel id for the planning/coordination channel |
| `<PLANNING_THREAD_TS>` | `ts` of the original planning-channel thread root; **empty string `""` for follow-on operational tasks** (no planning thread) |
| `<PLANNING_PERMALINK>` | Permalink to the planning thread root |
| `<REQUESTOR_THREAD_PERMALINK>` | Permalink to the human requestor's planning thread |
| `<WORKER_NAME>` | Worker bot display name |
| `<WORKER_REPLY_TS>` | `ts` of the worker's terminal reply |
| `<TRACKER_LINK>` | Issue tracker URL (or `none`) |
| `<DOD>` | Definition of done (one line) |
| `<ARTIFACT_LINK>` | PR / deploy / commit URL the worker produced |
| `<BLOCKER_SUMMARY>` | One-line blocker summary from the worker's ⛔ reply |

---

## Template (a) — close-the-loop on terminal worker reply

**Trigger:** Worker posts a *ship* terminal in an active delegation thread when `lifecycle: shipped-is-done`, OR a `blocked` terminal at any time, OR a DDB terminal wake fires for a task whose `lifecycle` allows direct close. (For `lifecycle: requires-human-signoff` *ship*, use template **(b)** instead.)

```
## Output discipline (READ THIS LAST, OBEY IT FIRST)

Hard rule (verbatim from bot-delegation SKILL.md § 7a):

> Any sub-agent spawned in the delegation lifecycle (close-the-loop, In-Review,
> signoff, blocked, or any sibling) must end its final turn with the literal
> token `NO_REPLY` and nothing else. Its *only* Slack write is the single
> threaded planning-thread summary it was explicitly spawned to post (via the
> `message` tool with explicit `target` and `replyTo`). Report-back to the
> parent agent goes via the **tool result** — i.e. the plain-text return value
> of the `task` — never via a Slack message. A top-level "Done. Accomplished: …"
> post in the planning channel (or any other channel) is a **bug**, not a
> feature.

Concretely for THIS sub-agent:

- Your ONLY permitted Slack write is exactly ONE summary post. Route it based
  on `<PLANNING_THREAD_TS>`:

  **Thread-originated task** (`<PLANNING_THREAD_TS>` is non-empty) — reply
  threaded to the planning thread:
    message(action=send, target="<PLANNING_CHANNEL_ID>",
            replyTo="<PLANNING_THREAD_TS>",
            message=<the close-the-loop summary specified below>)

  **Follow-on operational task** (`<PLANNING_THREAD_TS>` is empty) — post
  top-level in the planning channel:
    message(action=send, target="<PLANNING_CHANNEL_ID>",
            message=<the close-the-loop summary specified below>)

- ZERO additional posts beyond the one above (no top-level posts for
  thread-originated tasks; no threaded replies for operational tasks).
  ZERO posts in the worker channel. ZERO DMs.
- Report-back to the parent (PM bot) is the plain-text return value of this
  task — i.e. the natural-language string you emit on the assistant turn
  IMMEDIATELY BEFORE your final `NO_REPLY` turn. The parent reads that
  return text directly. It is NOT a Slack message; do not mirror it to Slack.
- Your final assistant turn must be exactly the literal token `NO_REPLY`
  (9 characters, no quotes, no trailing punctuation, no whitespace).

## Your task: close the loop for delegation `<TASK_ID>`

Context:
- Project: `<PROJECT_SLUG>`
- Worker: <WORKER_NAME>
- Requestor planning thread: <REQUESTOR_THREAD_PERMALINK>
- Worker's terminal reply ts: `<WORKER_REPLY_TS>`
- Planning thread root permalink: <PLANNING_PERMALINK>
- Planning thread root ts (use as `replyTo`): `<PLANNING_THREAD_TS>`
- Tracker link (or `none`): <TRACKER_LINK>
- Outcome: <done | blocked> — fill from the worker reply

Steps:

1. Read the narrative: `fleetmind narrative get --task-id <TASK_ID>`
   Read `## What I did` and `## Learned`. Ground the summary in them —
   don't paraphrase from session memory.
2. Read the DDB record: `fleetmind task get --task-id <TASK_ID> --json`
   Confirm current status and lifecycle.
3. If `<TRACKER_LINK>` is a real URL, update the tracker issue per your
   deployment's tracker workflow (Done on ship; leave In Progress and comment
   on blocked). Idempotent.
4. Update DDB:
   - Ship terminal: `fleetmind task merge --task-id <TASK_ID> --project <PROJECT_SLUG>`
   - Blocked terminal: `fleetmind task block --task-id <TASK_ID> --worker <worker-id> --project <PROJECT_SLUG>`
5. Move the delegation block from `## Active` to `## Closed` in
   `memory/active-delegations.md` (audit log only — DDB is truth).
   Set `closed_at: <UTC ISO>` and `last-handled-terminal-at: <DDB terminal ts>`.
   These two updates must be the last write before you move the block.
6. Post EXACTLY ONE summary — route based on `<PLANNING_THREAD_TS>`:
   - Non-empty (`<PLANNING_THREAD_TS>` set) → threaded reply:
       message(action=send, target="<PLANNING_CHANNEL_ID>",
               replyTo="<PLANNING_THREAD_TS>",
               message=<summary below>)
   - Empty → top-level post:
       message(action=send, target="<PLANNING_CHANNEL_ID>",
               message=<summary below>)
   Summary contents (≤6 lines):
   - Task ID + worker + outcome
   - One line of what got done (or blocker + what's needed)
   - Artifact link: <ARTIFACT_LINK>
   - Tracker link if any: <TRACKER_LINK>
   - Narrative pointer: `fleetmind narrative get --task-id <TASK_ID>`
7. Run the closeout completion checklist from skill § 7 step 7. If any box
   would be unchecked, do that step now before your final turn.
8. Return a short plain-text summary to the parent: outcome, artifact URL,
   any blockers, the `closed_at` timestamp. This is the tool return — NOT
   a Slack message.
9. Final assistant turn: exactly `NO_REPLY`.
```

---

## Template (b) — In-Review handoff on `shipped` + `requires-human-signoff`

**Trigger:** Worker posts a *ship* terminal in a delegation whose `lifecycle: requires-human-signoff`. The delegation does NOT close yet — a human must sign off first. This sub-agent transitions the tracker issue to In Review and posts the artifact-for-review in the planning thread.

```
## Output discipline (READ THIS LAST, OBEY IT FIRST)

Hard rule (verbatim from bot-delegation SKILL.md § 7a):

> Any sub-agent spawned in the delegation lifecycle (close-the-loop, In-Review,
> signoff, blocked, or any sibling) must end its final turn with the literal
> token `NO_REPLY` and nothing else. Its *only* Slack write is the single
> threaded planning-thread summary it was explicitly spawned to post (via the
> `message` tool with explicit `target` and `replyTo`). Report-back to the
> parent agent goes via the **tool result** — never via a Slack message. A
> top-level "Done. Accomplished: …" post is a **bug**, not a feature.

Concretely for THIS sub-agent:

- Your ONLY permitted Slack write is exactly ONE threaded reply in the planning
  thread:
    message(action=send, target="<PLANNING_CHANNEL_ID>",
            replyTo="<PLANNING_THREAD_TS>",
            message=<the In-Review handoff post specified below>)
- ZERO top-level posts. ZERO posts in the worker channel. ZERO DMs.
- The In-Review handoff post is NOT a close-the-loop post. Do NOT use
  "Done." / "Accomplished:" / "closing the loop" phrasing. Use review-request
  phrasing — see template below.
- Report-back to the parent is the plain-text return value of this task.
- Your final assistant turn must be exactly the literal token `NO_REPLY`.

## Your task: In-Review handoff for delegation `<TASK_ID>`

Context:
- Project: `<PROJECT_SLUG>`
- Worker: <WORKER_NAME>
- Requestor thread: <REQUESTOR_THREAD_PERMALINK>
- Worker's ship reply ts: `<WORKER_REPLY_TS>`
- Planning thread root ts: `<PLANNING_THREAD_TS>`
- Tracker link: <TRACKER_LINK>
- Artifact: <ARTIFACT_LINK>

Steps:

1. Read the narrative: `fleetmind narrative get --task-id <TASK_ID>`
   Read `## What I did` to summarize the artifact.
2. Read the DDB record: `fleetmind task get --task-id <TASK_ID> --json`
   Confirm `status = shipped`. If not, abort and return the actual state
   to the parent — do NOT post anything to Slack.
3. If `<TRACKER_LINK>` is a real URL, transition the tracker issue to
   `In Review` and comment with the artifact link.
4. Do NOT flip DDB to `signed_off` here — that's the human's call (template c).
5. In `memory/active-delegations.md`, set `status: in-review` on the
   delegation block (it stays in `## Active` until signoff).
6. Post EXACTLY ONE threaded reply in the planning thread:
       message(action=send, target="<PLANNING_CHANNEL_ID>",
               replyTo="<PLANNING_THREAD_TS>",
               message=<review-request summary>)
   Summary phrasing:
   - "Ready for your review" (NOT "Done")
   - Task ID, worker, what shipped (one line)
   - Artifact link: <ARTIFACT_LINK>
   - "Work with Developer directly on the PR. Reply here only when you're ready to approve the merge."
7. Return a short plain-text summary to the parent: artifact URL, tracker
   transition done? yes/no, audit-log status flipped? yes/no.
8. Final assistant turn: exactly `NO_REPLY`.
```

---

## Template (c) — signoff close on human approval

**Trigger:** A human posts approval in a planning thread for a delegation currently `in-review` (DDB `status: shipped`, `lifecycle: requires-human-signoff`).

```
## Output discipline (READ THIS LAST, OBEY IT FIRST)

Hard rule (verbatim from bot-delegation SKILL.md § 7a):

> Any sub-agent spawned in the delegation lifecycle (close-the-loop, In-Review,
> signoff, blocked, or any sibling) must end its final turn with the literal
> token `NO_REPLY` and nothing else. Its *only* Slack write is the single
> threaded planning-thread summary it was explicitly spawned to post (via the
> `message` tool with explicit `target` and `replyTo`). Report-back to the
> parent agent goes via the **tool result** — never via a Slack message. A
> top-level "Done. Accomplished: …" post is a **bug**, not a feature.

Concretely for THIS sub-agent:

- Your ONLY permitted Slack write is exactly ONE threaded reply in the planning
  thread:
    message(action=send, target="<PLANNING_CHANNEL_ID>",
            replyTo="<PLANNING_THREAD_TS>",
            message=<the signoff close summary specified below>)
- ZERO top-level posts. ZERO posts in the worker channel. ZERO DMs.
- Report-back to the parent is the plain-text return value of this task.
- Your final assistant turn must be exactly the literal token `NO_REPLY`.

## Your task: signoff close for delegation `<TASK_ID>`

Context:
- Project: `<PROJECT_SLUG>`
- Worker: <WORKER_NAME>
- Planning thread root ts: `<PLANNING_THREAD_TS>`
- Tracker link: <TRACKER_LINK>
- Artifact: <ARTIFACT_LINK>

Steps:

1. Read the DDB record: `fleetmind task get --task-id <TASK_ID> --json`
   Confirm `status = shipped` and `lifecycle = requires-human-signoff`.
   If not, abort and return the actual state to the parent — do NOT post.
2. `fleetmind task signoff --task-id <TASK_ID> --project <PROJECT_SLUG>`
   If this fails (conditional check — already signed off), return that to
   parent and `NO_REPLY` without posting.
3. If `<TRACKER_LINK>` is a real URL, transition tracker issue to Done and
   comment with the artifact + "Signed off."
4. Move the delegation block from `## Active` to `## Closed` in
   `memory/active-delegations.md`. Add `closed_at`, `signed_off_at`,
   and `last-handled-terminal-at` (all set to the same UTC ISO timestamp).
5. Post EXACTLY ONE threaded reply in the planning thread:
       message(action=send, target="<PLANNING_CHANNEL_ID>",
               replyTo="<PLANNING_THREAD_TS>",
               message=<close summary>)
   Summary:
   - "Signed off — closing." (≤1 line of context)
   - Task ID, worker, artifact link, tracker link.
   - Narrative pointer: `fleetmind narrative get --task-id <TASK_ID>`
6. Return short plain-text summary to parent: closed_at, tracker final state.
7. Final assistant turn: exactly `NO_REPLY`.
```

---

## Template (d) — blocked-handler on ⛔ / DDB `blocked`

**Trigger:** Worker posts a *blocked* terminal in an active delegation thread, OR a DDB terminal wake fires for a task whose `status` flipped to `blocked`. Posts the blocker in the planning thread; does NOT close the delegation (a human decides next step).

```
## Output discipline (READ THIS LAST, OBEY IT FIRST)

Hard rule (verbatim from bot-delegation SKILL.md § 7a):

> Any sub-agent spawned in the delegation lifecycle (close-the-loop, In-Review,
> signoff, blocked, or any sibling) must end its final turn with the literal
> token `NO_REPLY` and nothing else. Its *only* Slack write is the single
> threaded planning-thread summary it was explicitly spawned to post (via the
> `message` tool with explicit `target` and `replyTo`). Report-back to the
> parent agent goes via the **tool result** — never via a Slack message. A
> top-level "Done. Accomplished: …" post is a **bug**, not a feature.

Concretely for THIS sub-agent:

- Your ONLY permitted Slack write is exactly ONE threaded reply in the planning
  thread:
    message(action=send, target="<PLANNING_CHANNEL_ID>",
            replyTo="<PLANNING_THREAD_TS>",
            message=<the blocker summary specified below>)
- ZERO top-level posts. ZERO posts in the worker channel. ZERO DMs.
- Do NOT use "Done." / "Accomplished:" — the delegation is NOT closed.
  Use blocker-escalation phrasing.
- Report-back to the parent is the plain-text return value of this task.
- Your final assistant turn must be exactly the literal token `NO_REPLY`.

## Your task: blocked-handler for delegation `<TASK_ID>`

Context:
- Project: `<PROJECT_SLUG>`
- Worker: <WORKER_NAME>
- Requestor thread: <REQUESTOR_THREAD_PERMALINK>
- Worker's blocked reply ts: `<WORKER_REPLY_TS>`
- Planning thread root ts: `<PLANNING_THREAD_TS>`
- Tracker link: <TRACKER_LINK>
- Blocker summary (from worker reply): <BLOCKER_SUMMARY>

Steps:

1. Read the narrative (if present):
   `fleetmind narrative get --task-id <TASK_ID>`
   Otherwise rely on the worker's reply text for the blocker description.
2. `fleetmind task block --task-id <TASK_ID> --worker <worker-id> --project <PROJECT_SLUG>`
   If this fails (already terminal), return that to parent and `NO_REPLY`
   without posting.
3. If `<TRACKER_LINK>` is a real URL, comment on the tracker issue with the
   blocker. Leave the issue in its current active state — blocked is a
   Slack/audit-log status, not a tracker state.
4. In `memory/active-delegations.md`, set `status: blocked` on the delegation
   block. Add `blocked_at: <UTC ISO>`. Block stays in `## Active` until a
   human resolves or abandons.
5. Post EXACTLY ONE threaded reply in the planning thread:
       message(action=send, target="<PLANNING_CHANNEL_ID>",
               replyTo="<PLANNING_THREAD_TS>",
               message=<blocker post>)
   Phrasing:
   - "<WORKER_NAME> is blocked on `<TASK_ID>`."
   - One-line blocker: <BLOCKER_SUMMARY>
   - What the worker needs (extracted from the reply).
   - Delegation thread permalink for full context.
6. Return short plain-text summary to parent: blocker_summary, blocked_at,
   tracker comment success? yes/no.
7. Final assistant turn: exactly `NO_REPLY`.
```

---

## Maintenance checklist

When adding a new sub-agent variant to the delegation lifecycle:

1. Add a new fenced template here (variant **(e)**, **(f)**, …).
2. Embed the § 7a rule **verbatim** at the top of the new template's
   `## Output discipline` block.
3. Add a one-line pointer in `SKILL.md` from the prose section that describes
   the new spawn to this file's variant id.
4. Bump SKILL.md version + add a changelog entry.

Do not delete templates; deprecate them in place with a `> **Deprecated <date>**:` admonition above the fenced block.
