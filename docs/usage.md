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
