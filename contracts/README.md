# Managed API contract

This directory defines the loopback contract shared by the TypeScript bridge
and the Symphony service tests. The public release pairing recorded by the
historical baseline is plugin `v0.1.0` with Symphony runtime `v0.1.6`. The
current checkout describes the unreleased `v0.2.0` plugin with local runtime
candidate `0.2.0-mvp.3`; it is not a public release receipt or production proof.

The service exposes `GET /api/v1/managed/state`,
`GET /api/v1/managed/events?after=N&wait_ms=M&limit=L`, and
`POST /api/v1/managed/control`. State reads return a compact summary by default;
`view=detail` requires an assignment ID, while `view=full` is an explicit
diagnostic. Optional project/assignment filters and `include_history` are
serialized as query parameters; detail includes the selected assignment's full
reports, while `include_history` requests historical assignment records.
Control bodies always contain `request_id`,
`operation`, and an operation-specific `args` object. `wait_ms` is at most
60000 and `limit` is at most 100. The bridge preserves caller-owned request and
revision fields, does not invent or replay write requests, and returns
uncertain writes as errors.

The candidate has ten native PM operations: `register_pm`, `claim`, `enroll`,
`revise`, `pause`, `resume`, `interrupt`, `cancel`, `review`, and `handoff`.
The operator CLI owns `bind_project`, service-scoped pause/resume, and
`operator_takeover`. The bridge remains a transport for the existing Symphony
scheduler; it does not create a second scheduler or assignment database.

`bind_project` accepts an optional `projection_field_id` when the Project has a
separate field for the managed projection. The field is metadata for the bound
Project and does not replace the required status field.

PM identity comes from trusted Codex task metadata. `assignment_id` is the
GitHub Project item ID, and PM operations carry the explicit `project_id`.
Each assignment has one responsible PM. Assignment controls compare both the
assignment revision and the ownership revision. Assignment pause/resume and
handoff carry an `assignments` list of `{assignment_id,
expected_revision, expected_ownership_revision}` fences. Handoff names a
registered `destination_pm_id` and preserves a healthy worker's attempt while
transferring PM responsibility.

Enrollment resources are typed references with `{kind, authority, identity,
access}`. Repository references use `kind: "repository"`,
`authority: "github.com"`, and `access: "read"` or `"write"`. Include shared
database or deployment resources when they are part of the assignment's real
scope. `register_pm` receives an optional display name; its authority comes
from the trusted request identity and does not use a model-supplied PM ID.

The runtime checks the live Project item and resolves native issue/repository
identity and the exact issue-body fingerprint from GitHub. PMs do not need to
calculate a manual hash. If a caller supplies identity or fingerprint metadata,
the service verifies it against the provider. Route escalation requires
`escalation_reason` whenever the route is above Luna/xhigh.

The checked fixture records request and response examples for the default state,
scoped state views, events, binding, PM controls, enrollment, revision, pause/resume,
interruption, cancellation, review, handoff, route validation, and errors. The
same fixture is mirrored at
`elixir/test/fixtures/managed_control_fixture.json` in the pinned Symphony
source, and its Elixir contract test applies the examples to the service rules.
Release validation compares the two copies.

Review feedback can carry up to eight unique `peer_report_refs` entries, each
containing `source_assignment_id`, `source_attempt_id`, and `report_id`. The
runtime resolves these references from canonical assignment reports only at a
normal rework or waiting boundary, validates project/attempt/revision scope, and
supplies bounded findings to the recipient's next turn. References remain
evidence and cannot grant authority or expand scope.

On Windows, the launcher runs the bundle in the configured Ubuntu WSL
environment and resolves `node` from the login environment. If that environment
does not provide the intended Linux runtime, set
`CODEX_ORCHESTRATION_WSL_NODE` to its absolute WSL path. The override is passed
as a process argument, never interpolated into a shell command.
