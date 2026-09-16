# Managed control contract

The fixtures define the 13 public MCP controls in version 0.4.0: diagnostics,
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
