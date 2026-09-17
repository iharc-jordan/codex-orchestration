# Managed control contract

The fixtures define the 13 managed MCP controls in version 0.5.0: diagnostics,
state, events, and the ten PM mutation operations. The bridge preserves each
request ID, operation body, and supplied revision or ownership fence.

Managed state projections add worker activity, route escalation reasons, latest
report timestamps, and `truncated` markers when compact report summaries omit
detail. Usage fields identify managed-worker telemetry completeness and keep
cached input separate from ordinary input; they do not represent full PM/Astra
usage or billed dollars. Read the full assignment detail before relying on
evidence from a truncated summary.

MCP tool listing is local and immediate. Calls use a direct authenticated
127.0.0.1 connection from the native Node bridge. Mutations never retry after a
transmission attempt. If the bridge cannot know the response outcome, it returns
mutation_outcome_uncertain and the caller must inspect canonical state with the
same request ID before deciding what to do next.

PM mutations require trusted _meta.threadId metadata. The bridge derives a
per-thread capability from the local operator token and does not accept model
supplied task, owner, or identity values as authority.

Three additional local tools read, update and acknowledge project requirements,
without contacting Symphony. They require an explicit repository cwd; updates
and acknowledgements require trusted native task metadata. See
[persistent requirements](../docs/requirements.md) for the file and hook contract.

Operator project bindings include an absolute `requirements_path`. Enrollment
and revision resolve `project_requirements_fingerprint` on the runtime; callers
cannot replace the project source with an assignment-supplied path or text.
This fingerprint is separate from `requirements_fingerprint` of the issue body.
Dispatch, resume and acceptance check current project requirements before work
can proceed. Stale requirements require assignment revision and reconciliation.
