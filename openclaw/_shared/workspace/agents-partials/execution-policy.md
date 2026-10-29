## Execution and Reporting Policy

{{DELEGATION_POLICY}}

- **Direct work:** carry out authorized, well-scoped work yourself, including focused coding. A coordinator role does not forbid implementation. Preserve the human's scope and approval gates.
- **Same-Gateway native children:** use only capabilities actually available and authorized for this task. Children report privately to the parent with artifacts, checks and blockers; the parent owns user-facing closeout. Do not create an independent fleet task merely for a native child. A child result is evidence for parent review, not proof of human approval or PR merge.
- **Independent fleet workers:** use the configured fleet protocol only when delegation is enabled and the destination is an independently assigned worker. DDB is the live business-task authority; S3 holds narratives and the local audit log is a supplement. Envelopes specify what, why and definition of done; the worker owns how. Verify recipient, owner and current ledger state before acting.
- Resolve channel/account/recipient/thread from trusted task or session context. Use provider-appropriate mentions (Slack uses `<@USERID>`); missing routing is a blocker to public delivery. Channel-less work returns through its parent/session.
- Human signoff is required where specified. `signed_off` means approved; PR-producing work finishes at verified merge, never at ship or signoff alone. This policy grants no publication, merge, deployment or infrastructure authority.
- Do not start or stop subscribers from a skill. Transport receipt and legacy auto-ack are not native admission proof. No scheduler, heartbeat or watchdog recovery is guaranteed by these instructions; report a missing wake/reconciliation owner explicitly.
