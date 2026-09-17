# Persistent user requirements

The plugin loads current project decisions into ordinary Codex tasks and managed
workers. Native Codex memory remains useful background recall; it is not the
authority for these decisions. Current explicit user direction wins.

## Project file

Use `orchestration_requirements_read` with the task's repository `cwd`. The tool
returns the canonical file, full text and SHA-256 fingerprint. Capture lasting
user directions with `orchestration_requirements_update`, passing that fingerprint
and the new complete file. It uses a lock and atomic replacement; a conflicting
write requires rereading and reconciling, never blind retry.

```markdown
# Requirements

## Example decision
- Scope: The project and workflows the user actually named.
- Source: User, 2026-09-17, task <id>, turn <id>; brief exact source excerpt.
- Decision: The current explicit requirement, without expanding its scope.
- Supersedes: Prior entry/source, only when the user explicitly changed it.
```

Capture decisions during the same turn without requiring the user to say
"remember this". Do not record secrets or whole transcripts. Suggestions,
generated reminders, code, tests and worker reports are not user decisions.
Remove superseded behavior; do not quietly restore it. In plan or read-only
work, describe a needed update without writing it.

Before completing an ordinary root turn, call
`orchestration_requirements_acknowledge` with `cwd`, the hook's original `turn_id`,
the current `fingerprint`, and `outcome: updated` or `unchanged`. This is internal
bookkeeping, not a new user approval. A stop hook requests one correction if the
checkpoint is missing, then reports incomplete capture instead of looping.
Subagents and managed workers read requirements; the root task captures user
decisions. Acknowledgement checks current context, not semantic correctness.
Symphony marks its worker processes with `SYMPHONY_MANAGED_WORKER=1`, so their
generated assignment prompts do not enter user-decision capture. Requirement
loading and revision checks still run for those workers.

## Worktrees and related repositories

By default all Git worktrees read `REQUIREMENTS.md` in the primary checkout.
This intentionally avoids branch-local stale copies. The primary checkout must
remain available. Projects without recorded requirements start empty, and their
first explicit lasting decision creates the file.

Private cross-repository mappings live in
`%LOCALAPPDATA%\CodexOrchestration\config\requirements.json`:

```json
{"version":1,"roots":{"C:\\work\\related":"C:\\work\\canonical"},"repositories":{"github.com/example/project":"C:\\work\\canonical"}}
```

Map related repositories only when they share the user's scoped requirements.
Do not publish private mapping paths or copy private decisions into a public
repository. A mapped file that is absent or unreadable is an error.
Repository keys include host, owner and repository in lowercase; HTTPS and SSH
GitHub origin URLs resolve to the same identity. These mappings also cover fresh
managed clones. Explicit local root mappings take precedence.

## Hooks and managed execution

The bundled `hooks/hooks.json` uses native command hooks. Startup, resume,
compaction, user messages and subagent startup receive the requirements text.
Before supported tools run, a changed revision blocks that pending call and
delivers the current decisions for reconsideration. Loading works while Symphony
is stopped. The per-session private state contains only revision and capture
bookkeeping, never a second authoritative requirement store.

The operator binds a managed project's `requirements_path` to its canonical
file returned by `orchestration_requirements_read` for the project's checkout.
If enrollment is needed before the first lasting decision, initialize an empty
`# Requirements` file through the update tool, without inventing a decision.
Symphony resolves the project fingerprint independently of the issue-body
fingerprint, includes the current text in worker context and rejects stale
dispatch, resume and acceptance. Reconcile changed requirements through the
existing assignment revision operation; preserve unaffected work and evidence.

Codex requires review and trust of the exact installed hook definition. Use
`/hooks` to inspect and trust it; changed definitions require renewed review.
Installing the plugin alone does not activate untrusted hooks. Do not bypass
trust in the normal installation or report inactive hooks as protection.

Hook coverage is not a universal security boundary: already running commands
cannot be undone, specialized tool paths may bypass hooks, and agents can still
misinterpret language. Test source capture and actual task behavior, not just
the existence of a requirement file. No new scheduler, service or model call is
used for requirement loading.
