# Managed API contract

This directory is the checked interface shared by the TypeScript bridge and the
Symphony service tests. The bridge sends the JSON shape in
`managed-contract-fixtures.json` without renaming, filling, retrying, or replaying
caller-owned write fields.

The loopback service exposes `GET /api/v1/managed/state`,
`GET /api/v1/managed/events?after=N&wait_ms=M&limit=L`, and
`POST /api/v1/managed/control`. Control bodies always contain `request_id`,
`operation`, and an operation-specific `args` object. `wait_ms` is at most 60000;
`limit` is at most 100. Mutations preserve `request_id` and any
`expected_revision` supplied in `args`; uncertain writes are returned as errors
and are never retried by this bridge.

The checked fixture records the operation-specific request and response shapes
for binding, enrollment, revision, pause/resume, interruption, cancellation, and
review. `args` remains extensible so the service can add compatible fields
without a second scheduler or a duplicate assignment database. The bridge
rejects unsupported operation names and oversized requests before contacting the
service. Review effects such as Project status changes and issue closure remain
service-owned; the bridge only transports the control request and response.

Supply `escalation_reason` alongside `route` for enrollment, or alongside `route`
inside revision `changes`. The service requires it for every route above
Luna/xhigh. `assignment_id` is the Project item node ID; native issue identity
is verified separately so duplicate memberships cannot create duplicate owners.

`requirements_fingerprint` is `sha256:` followed by the lowercase SHA-256 digest
of the exact UTF-8 GitHub issue body, with no title or whitespace normalization.
Hash the body string from the authoritative API response rather than formatted
shell output. `requirements_revision` is a PM-supplied material revision; it is
not parsed from the issue text and is distinct from the assignment's revision.

The same fixture is shipped as `elixir/test/fixtures/managed_control_fixture.json`
in the pinned Symphony source. Its Elixir contract test applies the operation
examples and route cases to the service rules; release validation compares the
two copies.

On Windows, the launcher runs the bundle in the configured Ubuntu WSL
environment and resolves `node` from the login environment. If that environment
does not provide the intended Linux runtime, set
`CODEX_ORCHESTRATION_WSL_NODE` to its absolute WSL path. The override is passed
as a process argument, never interpolated into a shell command.
