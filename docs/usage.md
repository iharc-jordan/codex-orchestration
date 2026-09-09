# Local service lifecycle

The shipped `mcp/cli.mjs` entrypoint manages the local Symphony executable and
its host service. It does not install another Node, Codex, GitHub CLI, or
scheduler.

The first setup uses an explicit Symphony release executable and a private
workflow file. Download the executable and `build-receipt.json` from the
[pinned runtime release](https://github.com/iharc-jordan/symphony/releases/tag/v0.1.6)
and compare its SHA256 with the receipt. On Linux, mark the downloaded file
executable with `chmod +x symphony_linux_x86_64`. Windows users should place it
in their Ubuntu WSL home and pass its Linux path to setup. Building from source
is optional; see the [build instructions](release.md).
Use the [generic workflow example](../fixtures/WORKFLOW.example.md) as a starting
point and replace its paths and Project owner before setup:

```text
node ./mcp/cli.mjs setup --executable /path/to/symphony_linux_x86_64 --workflow /path/to/WORKFLOW.md --version 0.1.6 --port 8787
```

Setup creates separate XDG configuration, data, and state roots. Configuration
contains `config.json`, `token`, and the private `WORKFLOW.md`; state contains
the managed lock, journal, logs, and workspaces; data contains staged releases
and the current release pointer. Setup installs the owned service assets but
does not enable or resume execution.

Run these commands from the installed plugin directory (reported by
`codex plugin add --json`) or a checkout of its pinned source. Setup stages an
immutable release label; use a new label when upgrading to a changed executable.

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
node ./mcp/cli.mjs upgrade --executable /path/to/new/bin/symphony --version local-2
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

The Windows launcher resolves Linux Node from the Ubuntu login environment. Set
`CODEX_ORCHESTRATION_WSL_NODE` to an absolute WSL Node path when an explicit
runtime is required.

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
| `managed.checkout_helper_path` | Installed plugin's pinned `mcp/cli.mjs` path. |
| `managed.checkout_policy_file` | Private repository allowlist and workspace/control path policy. |
| `managed.usage_limit_tokens` | Optional aggregate worker limit; further work stops when reported usage reaches it. |

The validated Codex 0.153.4 managed profile disables worker network access.
Prepare dependencies through a trusted `before_run` hook or a PM operation;
GitHub access and checkout preparation run outside the worker turn. The named
`symphony_worker` permission profile governs the turn, so changing only the
legacy `turn_sandbox_policy.networkAccess` setting does not enable networking.

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
workspace paths to match. A plugin upgrade must keep the old helper available
until the service workflow points at the new installed helper.

## Recovery and troubleshooting

- If orchestration tools are missing from a desktop task, verify the plugin is
  enabled with `codex plugin list`. A fresh native Codex App Server connection
  discovered all 11 tools in validation, while an already running desktop client
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

For an upgrade, pause and let healthy work reach review, then stop the service.
Stage the new executable, update any changed private configuration, and start it.
If validation fails, stop and use `rollback` to restore the previous staged
executable. Keep compatible configuration and journal backups; a binary rollback
does not undo Git changes or GitHub writes.
