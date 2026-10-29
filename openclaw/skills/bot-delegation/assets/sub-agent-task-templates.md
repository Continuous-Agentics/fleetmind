# Private native child task templates

Use only for an authorized same-Gateway native child through a capability that
is actually available. The parent can do these checks directly. These templates
do not prescribe a native API, install a scheduler or dispatch a fleet worker.
Independent workers use the fleet envelope and authoritative ledger instead.

Fill every placeholder. Each brief contains what, why and DoD; the child owns
how. All variants return privately to the parent. The parent owns user-facing
closeout and any authorized ledger, tracker, signoff or merge transition.

## Shared brief fields

```
Task: <TASK_ID or parent task reference>
Context: <why this result is needed>
Scope: <bounded evidence/artifacts to review>
Definition of done: <verifiable outcome>
Authority: <read/write boundaries; default to evidence gathering only>
Return privately to the parent: outcome, evidence/artifact links, checks run,
limitations, blockers and recommended next step. Do not post to public channels
or close the parent task. Human approval and PR merge remain separate gates.
```

## (a) Terminal result review

```
What: Review <WORKER_RESULT> against <DOD> for <TASK_ID>.
Why: The parent needs grounded evidence for closeout.
DoD: Return verified outcome, artifact links, checks and unresolved gaps privately.
A shipped PR is ready for review; PR work finishes at verified merge.
```

## (b) In-review handoff

```
What: Prepare a review handoff for <TASK_ID>, artifact <ARTIFACT_LINK>.
Why: The designated human must review before signoff or merge.
DoD: Return a proposed review summary, evidence and any blockers privately.
Do not transition to signed_off or done. The parent sends the review request.
```

## (c) Approval and merge evidence

```
What: Check approval and PR merge evidence for <TASK_ID> / <ARTIFACT_LINK>.
Why: Human signoff is distinct from completion of PR-producing work.
DoD: Return who approved what, observed merge state and evidence links privately.
Do not infer merged from signed_off. The parent records authorized transitions
and keeps PR work active until the actual merge is verified.
```

## (d) Blocker assessment

```
What: Assess <BLOCKER_SUMMARY> for <TASK_ID>.
Why: The parent needs an actionable recovery or escalation choice.
DoD: Return cause, evidence, required authority/input and next step privately.
Blocked work stays active until resolved or explicitly abandoned.
```
