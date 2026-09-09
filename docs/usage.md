# Local service lifecycle

The shipped `mcp/cli.mjs` entrypoint manages the local Symphony executable and
its host service. It does not install another Node, Codex, GitHub CLI, or
scheduler.

The first setup uses an explicit locally built Symphony executable and a private
workflow file:

```text
node ./mcp/cli.mjs setup --executable /path/to/bin/symphony --workflow /path/to/WORKFLOW.md --version local-1 --port 8787
```

Setup creates separate XDG configuration, data, and state roots. Configuration
contains `config.json`, `token`, and the private `WORKFLOW.md`; state contains
the managed lock, journal, logs, and workspaces; data contains staged releases
and the current release pointer. Setup installs the owned service assets but
does not enable or resume execution.

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

Symphony passes a bounded `SYMPHONY_ISSUE_CONTEXT` environment value to its
`after_create` hook. The context contains the issue id, display identifier, and
provider `native_ref`; it does not contain credentials, issue text, or commands.
The hook can prepare the one checkout assigned to that attempt with:

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
