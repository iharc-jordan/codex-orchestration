# Managed MVP service lifecycle

These instructions cover the MVP: one Symphony scheduler, bounded assignments,
PM-owned review/acceptance/release, and the native state and report paths.
Workers execute on Linux with full access to the configured CLI, MCP tools, apps,
skills, network, and Docker. Tool availability is capability rather than action
authorization. Desktop-only worker parity and a new messaging service are out of
scope. Keep one current assignment description and one current implementation
path; remove superseded behavior instead of retaining parallel old/new paths.

The current local iteration pairs plugin `v0.2.0` with Symphony runtime binary
`0.2.0-mvp.3`. Use a Symphony executable built from the current managed-state version 2 source
with this plugin. There is no public runtime artifact or production pilot; use
the local checkout and the [fresh-task acceptance note](fresh-task-test.md).

The shipped `mcp/cli.mjs` entrypoint manages the local Symphony executable and
its host service. It does not install another Node, Codex, GitHub CLI, or
scheduler.

The first setup uses an explicit Symphony executable built from the current
managed-state version 2 source and a private workflow file. Set its application version to
`0.2.0-mvp.3`; an older runtime or state format is incompatible. On Linux, mark
the executable with `chmod +x symphony_linux_x86_64`. Windows users should place
it in their Ubuntu WSL home and pass its Linux path to setup. See the
[build instructions](release.md) for the local runtime build.
Use the [generic workflow example](../fixtures/WORKFLOW.example.md) as a starting
point and replace its paths and Project owner before setup:

```text
node ./mcp/cli.mjs setup --executable /path/to/symphony_linux_x86_64 --workflow /path/to/WORKFLOW.md --version 0.2.0-mvp.3 --port 8787
```

Setup creates separate XDG configuration, data, and state roots. Configuration
contains `config.json`, `token`, and the private `WORKFLOW.md`; state contains
the managed lock, journal, logs, and workspaces; data contains staged releases,
the current release pointer, and an owned copy of the checkout helper. Setup
installs the owned service assets but does not enable or resume execution.

Run these commands from the installed plugin directory (reported by
`codex plugin add --json`) or this local checkout. Setup stages an
immutable release label; use a new label when upgrading to a changed executable.
The `0.2.0-mvp.3` label identifies the matching local iteration runtime; it is
not a published version or production support claim.

On Windows, setup delegates these Linux-owned roots and service operations to
Ubuntu WSL. The installed bridge also runs its Linux Node process in Ubuntu, so
the default configuration, token, staged release, journal, logs, and workspaces
are read from the same WSL home. Windows retains only the hidden standard-user
keeper task and its launcher metadata under the user data directory.

Use these commands for the lifecycle:

```text
node ./mcp/cli.mjs diagnostics
node ./mcp/cli.mjs start
node ./mcp/cli.mjs pause
node ./mcp/cli.mjs resume
node ./mcp/cli.mjs stop
node ./mcp/cli.mjs upgrade --executable /path/to/new/bin/symphony --version 0.2.0-mvp.3
node ./mcp/cli.mjs rollback
node ./mcp/cli.mjs uninstall
```

`stop` first records a managed `pause` with `disable: true` and refuses to stop
the host service when that durable control request cannot be confirmed.
`uninstall` removes only the owned service and Windows task assets, preserving
configuration, staged releases, journal, and workspaces. On Linux the service
unit is run through `/usr/bin/flock --nonblock` using a lock in the state root.
On Windows, the hidden standard-user task keeps the Ubuntu WSL session alive
while the service is enabled; logon does not enable a service that was disabled.

## Operator controls and PM identity

Native MCP mutations require the Codex task's trusted `_meta.threadId`. The
bridge derives a private per-task capability from that UUID and the configured
operator token before sending the request to Symphony. A model-supplied
`owner`, `pm_id`, display name, working directory, or environment value never
selects PM authority. `orchestration_state` and `orchestration_events` remain
available without task metadata for diagnosis, but that mode cannot identify a
PM.

Project binding, service pause/resume, and an emergency operator takeover are
operator-only actions. Submit one exact JSON control envelope through the
private CLI input file:

```text
node ./mcp/cli.mjs control --input /path/to/operator-control.json
```

The envelope uses the same wire shape as the managed control endpoint. For
example, a service pause is:

```json
{
  "request_id": "operator-pause-2026-09-09",
  "operation": "pause",
  "args": {
    "scope": "service",
    "expected_revision": 12,
    "reason": "planned maintenance"
  }
}
```

Replace `12` with the current managed control revision returned by the state
endpoint before submitting the envelope.

The CLI accepts only `bind_project`, service-scoped `pause` or `resume`, and
`operator_takeover`. It reads the file once, loads the operator credential from
the configured owner-only token file, sends one request, and does not retry a
write. Keep the input file under the private control root and remove it after
the response has been recorded. The file must not contain bearer tokens or
worker credentials.

The Windows launcher resolves Linux Node from the Ubuntu login environment. Set
`CODEX_ORCHESTRATION_WSL_NODE` to an absolute WSL Node path when an explicit
runtime is required.

## Managed MVP controls

The local MVP uses the loopback endpoint and durable journal with authenticated
PM ownership controls. Native PM tools are
`orchestration_register_pm`, `orchestration_claim`, `orchestration_enroll`,
`orchestration_revise`, `orchestration_pause`, `orchestration_resume`,
`orchestration_interrupt`, `orchestration_cancel`, `orchestration_review`, and
`orchestration_handoff`. The bridge also exposes diagnostics, compact scoped
state views, and bounded event reads. Each call carries a caller-owned
`request_id`; the bridge preserves the exact request and does not retry an
uncertain write.

Read managed state with `orchestration_state` using its default compact summary.
Use `view: "detail"` with an `assignment_id` when reviewing one assignment's
evidence, and use `view: "full"` only for an explicit diagnostic read. Optional
`project_id` and `assignment_id` filters scope the response; `include_history`
requests historical assignment records when the selected view supports them;
detail already includes the selected assignment's full reports.
The runtime remains the authority for project, assignment, ownership, and
history access checks.

At a normal `rework` or `waiting` review boundary, the PM may pass up to eight
`peer_report_refs` entries in review feedback. Each reference names the source
assignment, source attempt, and report ID. The runtime resolves those references
from canonical reports for the recipient's next turn and rejects stale,
missing, cross-project, or out-of-scope references. Peer findings are evidence
and cannot authorize work, change ownership, or override the current assignment.

Use the Project item ID as `assignment_id` and include the explicit
`project_id`. Enrollment resources are typed references, for example:

```json
{
  "request_id": "enroll-item-1",
  "operation": "enroll",
  "args": {
    "expected_revision": 12,
    "project_id": "PVT_example",
    "assignment_id": "PVTI_item",
    "repository": "OWNER/REPOSITORY",
    "issue_number": 42,
    "base_commit": "0123456789abcdef0123456789abcdef01234567",
    "board_state": "READY",
    "resources": [
      {"kind":"repository","authority":"github.com","identity":"OWNER/REPOSITORY","access":"write"}
    ],
    "dependencies": [],
    "route": {"model":"gpt-5.6-luna","effort":"xhigh"}
  }
}
```

The runtime checks the live Project item and resolves native issue/repository
identity and the exact issue-body fingerprint from GitHub. The PM does not
manually hash issue text; any identity or fingerprint supplied by the caller is
validated against the provider. Use the current assignment revision and
ownership revision from managed state for subsequent controls.

Pause/resume use a fenced `assignments` list. Handoff uses the same fences and
names a registered `destination_pm_id`; it transfers PM responsibility while
preserving a healthy worker's attempt identity. The recipient continues from
the current assignment state.

These controls require the matching `0.2.0-mvp.3` Symphony build from current
managed-state version 2 source. Scoped state and peer-report support are part of
this local iteration; no public artifact or production support is claimed.

## Trusted assignment checkout

Managed Symphony calls its trusted workspace preparer after workspace creation
and before `before_run` or Codex startup. Leave `hooks.after_create` empty for
this profile. The preparer supplies bounded `SYMPHONY_ISSUE_CONTEXT` containing
the Project item id, display identifier, and provider `native_ref`; it excludes
credentials, issue text, and commands. It invokes the installed helper using
the configured absolute paths, equivalent to:

```text
node ./mcp/cli.mjs checkout --input /home/example/.local/state/codex-orchestration/attempts/attempt-1.json --policy /home/example/.config/codex-orchestration/checkout-policy.json
```

Keep the policy and per-attempt input under the private control root, outside the
worker workspace. A policy names the writable workspace root and an exact
repository-to-remote allowlist:

```json
{
  "control_root": "/home/example/.local/state/codex-orchestration",
  "workspace_root": "/home/example/.local/state/codex-orchestration/workspaces",
  "repositories": {
    "OWNER/REPOSITORY": {
      "remote": "https://github.com/OWNER/REPOSITORY.git"
    }
  }
}
```

Each attempt input must contain `assignment_id` matching the context id,
`attempt_id`, `base_commit`, and an absolute `workspace` below
`workspace_root`. The optional `repository` must match the structured native
reference and an enrolled policy entry. The helper pins a new empty workspace to
the requested commit; on reuse it verifies the origin and base ancestry, then
preserves the current branch, local commits, and uncommitted worker changes.
Git receives every value as a separate argument. The tracker adapter does not
clone repositories or parse the operational journal.

## Configuration reference

The private Symphony workflow owns tracker, worker and execution configuration.
The bridge's `config.json` contains only loopback connectivity and token-file
location; it does not contain assignment state.

| Setting | Purpose |
| --- | --- |
| `tracker.kind: github_projects` | Select the Projects adapter. |
| `tracker.provider.owner_type`, `owner`, `project_number` | Select one exact user or organization Project. |
| `tracker.provider.status_field_name` | Name of the Project's status field, normally `Status`. |
| `tracker.provider.token` | Provider token or `$ENVIRONMENT_VARIABLE` reference. |
| `workspace.root` | Parent of all managed worker checkouts. |
| `agent.max_concurrent_agents` | Set to `2` for the initial profile. |
| `agent.max_turns` | Set to `20`; retries share the assignment allowance. |
| `codex.command` | Existing Linux Codex App Server command; use absolute runtime paths where needed. |
| `managed.enabled` | Enables the managed profile; explicit binding and enrollment are still required. |
| `managed.journal_path` | Private durable execution journal path. |
| `managed.control_token_file` | Private non-empty bearer-token file also used by the bridge. |
| `managed.checkout_node` | Existing Linux Node executable. |
| `managed.checkout_helper_path` | Setup rewrites this to the owned checkout-helper copy under the stable data root. |
| `managed.checkout_policy_file` | Private repository allowlist and workspace/control path policy. |
| `managed.usage_limit_tokens` | Optional aggregate worker limit; further work stops when reported usage reaches it. |

Workers run on Linux with full access to the configured CLI, MCP tools, apps,
skills, network, and Docker. This is a capability of the configured worker turn,
not an authorization to expand the assignment or invoke PM controls: the current
assignment, declared resources, and PM review still govern actions. Desktop-only
worker parity is outside this MVP. Preserve host-side credential handling and
do not put tokens in worker prompts, public workflow examples, repository files,
or command arguments.

Worker usage is measured from App Server telemetry. Updates can arrive late,
and already running work can overshoot a cap. This limit does not include the
PM's separate desktop usage. The journal preserves cumulative accounting and
attempt identity across recovery.

Provide service credentials through the user service manager, for example an
owner-only `EnvironmentFile` in a systemd drop-in for the installed unit. Set the
Linux `PATH` there if Node or Git is installed outside standard directories.
Never place tokens in public workflow examples, repository files, or command
arguments. The worker process excludes tracker credential environment variables.
Protect the private configuration root with owner-only permissions.

For custom roots, pass `--root` consistently to lifecycle commands and point the
bridge at that root's Linux `config/config.json` using
`CODEX_ORCHESTRATION_CONFIG`. Update the workflow's journal, token, checkout and
workspace paths to match. Setup and upgrade copy the helper into the stable data
root before writing the workflow path, so the service does not depend on a
disposable plugin cache.

## Recovery and troubleshooting

- If orchestration tools are missing from a desktop task, verify the plugin is
  enabled with `codex plugin list`. A fresh native Codex App Server connection
  discovered all 13 tools in validation, while an already running desktop client
  omitted them after installation. Refresh the client when convenient; do not
  reset service state or enroll a second assignment to address tool discovery.
- `config_missing` means the bridge launched but cannot find its Linux
  configuration. Check the WSL home and any explicit configuration override.
- An inactive service needs setup/start; an active service with no work may be
  paused, unbound, unenrolled, blocked by dependencies, or at its usage limit.
  Read managed state and events before changing it.
- A credential or Project binding failure needs a corrected private service
  configuration or provider access. Do not change assignment state to bypass it.
- After a crash, keep the journal and workspaces. Reconcile the owned process,
  Git changes and pending GitHub effects before authorizing another attempt.
  Recovery uses the recorded thread with a new turn; missing history is a
  visible blocker, not permission to replay the assignment in a new thread.
- An uncertain stop retains ownership. Inspect the named systemd scope and its
  recorded identity; do not kill unrelated processes or clear the journal.
- Damaged journals fail visibly. Preserve a copy for diagnosis and restore only
  a known matching execution checkpoint after resolving external effects.
- Repeated transient failure reaches `WAITING` after two automatic retries.
  Diagnose the cause and use explicit review/revision controls for further work.
  After the cause clears and the recorded process is reconciled, use review with
  disposition `rework` to return the retained assignment and its Project card to
  `READY`. Resume only removes a dispatch pause; it does not change `WAITING`.

For an upgrade, pause and let healthy work reach review, then stop the service.
Stage the new executable, update any changed private configuration, and start it.
If validation fails, stop and use `rollback` to restore the previous staged
executable. Keep compatible configuration and journal backups; a binary rollback
does not undo Git changes or GitHub writes.
