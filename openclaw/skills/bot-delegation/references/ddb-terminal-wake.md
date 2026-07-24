# § 5a — DDB Terminal Wake (fallback path), full detail

_Idempotency contract: DDB is authoritative._ The audit log is a cache of DDB state; when they disagree, DDB wins. The previous pattern - "check audit log first; short-circuit if the task is in `## Closed`" - silently dropped legitimate re-ships (a re-ship after close, a blocked→shipped retry, or a scope-amendment cycle arrives after the task was already closed). The correct order is: read DDB first, derive the decision from DDB timestamps, use the audit log only for presentation and to find the matching block.

When `DDB_TERMINAL_WAKE: TASK#<task_id>` arrives:

1. Parse the task_id from the message.
2. **Read DDB first.** This is the authoritative read.

   ```bash
   ITEM=$(fleetmind task get --task-id "${TASK_ID}" --json)
   STATUS=$(echo "$ITEM" | jq -r '.status')
   SHIPPED_AT=$(echo "$ITEM" | jq -r '.shipped_at // empty')
   BLOCKED_AT=$(echo "$ITEM" | jq -r '.blocked_at // empty')
   MERGED_AT=$(echo "$ITEM" | jq -r '.merged_at // empty')
   ABANDONED_AT=$(echo "$ITEM" | jq -r '.abandoned_at // empty')
   LIFECYCLE=$(echo "$ITEM" | jq -r '.lifecycle')
   TASK_S3_KEY=$(echo "$ITEM" | jq -r '.task_s3_key')

   # Pick the most recent terminal timestamp DDB knows about.
   TERMINAL_AT=$(printf '%s\n' "$SHIPPED_AT" "$BLOCKED_AT" "$MERGED_AT" "$ABANDONED_AT" \
     | grep -v '^$' | sort | tail -1)
   ```

   If `fleetmind task get` fails (not found or network error): fall back to audit-log idempotency WITH A WARNING - log the degradation, surface for human investigation, do not guess.

3. **Compare `last-handled-terminal-at` from the audit log block against the DDB terminal timestamp:**

   ```bash
   LAST_HANDLED=$(awk -v id="${TASK_ID}" '
     /^## Delegation:/ { in_block = ($0 ~ id) }
     in_block && /last-handled-terminal-at:/ { sub(/^[^:]*:[ ]*/, ""); print; exit }
   ' memory/active-delegations.md 2>/dev/null)

   if [ -n "$LAST_HANDLED" ] && [ -n "$TERMINAL_AT" ]; then
     if [[ "$LAST_HANDLED" == "$TERMINAL_AT" ]] || [[ "$LAST_HANDLED" > "$TERMINAL_AT" ]]; then
       echo "INFO: TASK#${TASK_ID} terminal at ${TERMINAL_AT} already handled. Duplicate delivery - skipping."
       exit 0
     fi
     # DDB has a NEWER terminal timestamp - re-ship, blocked→shipped retry,
     # or scope-amendment cycle. Reopen the block and run close-the-loop fresh.
     echo "INFO: TASK#${TASK_ID} re-terminal detected (DDB ${TERMINAL_AT} > last-handled ${LAST_HANDLED}). Reopening."
     REOPEN=1
   fi
   ```

4. **Reopen-on-reship (silent).** If `REOPEN=1`, move the block from `## Closed` back to `## Active` in the audit log:
   - Set `Status:` back to `acked` (or `in-review` if `LIFECYCLE=requires-human-signoff` and DDB `status=shipped`).
   - Clear `Closeloop subagent:` and `Closeloop spawned at:` fields.
   - Remove `Closed at:` and `Outcome:` fields.
   - Leave `last-handled-terminal-at:` in place - the close-the-loop sub-agent overwrites it on completion.
   - **Do NOT post anything to the coordination channel about the reopen.** This is silent self-healing. The close-the-loop sub-agent posts normally when done.

5. **Hard short-circuit on already-final DDB status.** If DDB itself says `merged` or `abandoned` AND the audit log shows the block in `## Closed`, it's a confirmed noop:

   ```bash
   if [[ "$STATUS" == "merged" || "$STATUS" == "abandoned" ]] && \
      awk '/^## Closed/,0' memory/active-delegations.md 2>/dev/null | grep -q "task_id: ${TASK_ID}"; then
     echo "INFO: TASK#${TASK_ID} terminal in DDB (${STATUS}) and closed in audit log. Noop."
     exit 0
   fi
   ```

   _(Defense-in-depth: the `last-handled-terminal-at` comparison in step 3 is the primary gate; this is a belt-and-suspenders backstop.)_

6. **Read the narrative** (for context in the closeout summary):

   ```bash
   NARRATIVE=$(fleetmind narrative get --task-id "${TASK_ID}")
   if [ $? -ne 0 ]; then
     echo "WARNING: Narrative not yet available for ${TASK_ID} - worker may still be writing. Retry in 30s."
   fi
   ```

7. **Close the loop** (§ 7 of `SKILL.md`), grounding the summary in the `## What I did` and `## Learned` sections from the narrative already fetched in step 6. Use the canonical brief template from [../assets/sub-agent-task-templates.md](../assets/sub-agent-task-templates.md) - copy the matching variant verbatim into the `task` field of `sessions_spawn`. Do not compose ad-hoc.
