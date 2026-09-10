# Codex Orchestration

A Codex plugin for an Astra PM working with a persistent pool of 5.6 workers,
using OpenAI Symphony on Ubuntu and GitHub Projects for workflow state.

This checkout contains the local managed MVP: plugin `v0.2.0` with Symphony
runtime binary `0.2.0-mvp.1`. The runtime must be built from the current
managed-state version 2 source and used with this plugin version; older runtime releases and
state formats are not compatible with these instructions. There is no public
marketplace entry or release artifact, and this README makes no PM pilot or
model-performance claim.

## How it works

The PM uses the plugin's bundled MCP bridge to control an authenticated,
loopback-only Symphony service. Symphony remains the scheduler. GitHub Projects
owns workflow status, repository issues describe bounded assignments, and an
operational journal preserves execution ownership and recovery information.

```text
Codex PM -> plugin MCP bridge -> Symphony service -> Codex workers
                    |                  |
                    +-- GitHub Projects and repository issues
```

The MVP supports multiple Projects and repositories. Each assignment has one
responsible PM, with explicit handoff to another PM task, typed resource claims,
and ownership revision fences. Windows uses Ubuntu WSL2 for execution; native
Ubuntu is also a supported target. Work stops for PM review before acceptance
unlocks dependent assignments.

## Installation

Install the plugin from this local checkout. The current MVP requires a
matching Symphony build from the current managed-state version 2 source and runtime binary
version `0.2.0-mvp.1`:

```shell
codex plugin marketplace add /path/to/codex-orchestration
codex plugin add codex-orchestration@codex-orchestration
```

Build or obtain that matching executable before setup. The executable includes
its runtime dependencies; existing Codex, GitHub CLI, Node, Git, and systemd
are still required. Follow the [setup instructions](docs/usage.md) to configure
the service before enabling it.

For an existing personal marketplace entry, use its own marketplace name
instead. The local checkout remains required because no public MVP artifact has
been published.

Open a fresh Codex task to discover the installed tools. Call
`orchestration_diagnostics` to check bridge configuration. A missing configuration
response means the bridge launched but service setup has not been completed.

The committed `mcp/server.mjs` and `mcp/cli.mjs` bundles use the existing Node
installation. Installing the plugin does not require a TypeScript build or a
global npm package. Existing Codex and GitHub CLI installations are reused.

## Service and workflow

Use the [service lifecycle instructions](docs/usage.md) with a compatible managed
Symphony executable and a private workflow file. Setup installs service assets
without enabling execution. Keep configuration, credentials, journal, and
workspaces outside the plugin installation.

The managed workflow uses `READY`, `ACTIVE`, `REVIEW`, `ACCEPTED`, `WAITING`, and
`CANCELLED`. Project membership alone is insufficient: each assignment requires
explicit enrollment, a pinned repository starting point, ownership boundaries,
and a permitted worker route. Workers submit attempt-scoped results; PM controls
own review disposition.

Pausing new dispatch allows healthy active work to reach review. Stopping the
service disables further work. Uninstall preserves configuration and user work.
Sleep, shutdown, and explicit WSL termination require recovery; they are not
continuous-execution guarantees.

## Managed MVP contract

The MVP exposes ten native PM operations through the bridge:
`register_pm`, `claim`, `enroll`, `revise`, `pause`, `resume`, `interrupt`,
`cancel`, `review`, and `handoff`. The operator CLI adds `bind_project`,
service pause/resume, and `operator_takeover`. The bridge does not add a second
scheduler or assignment store.

PM identity comes from trusted Codex task metadata. `assignment_id` is the
GitHub Project item ID, and PM operations include the explicit `project_id`.
Enrollment carries typed resources as `{kind, authority, identity, access}`;
repository writes use `kind: "repository"`, `authority: "github.com"`, and
`access: "write"`. The runtime resolves native issue and repository identity
and the exact issue-body fingerprint from GitHub, so the PM does not manually
hash issue text. Any supplied identity or fingerprint is checked against the
provider.

Every write uses a caller-owned `request_id`. Assignment controls carry the
current assignment and ownership revision fences. Assignment pause/resume and
handoff use a fenced `assignments` list; a handoff names a registered recipient
and preserves a healthy worker's attempt identity while transferring PM
responsibility. Review remains a PM control and requires evidence tied to the
current assignment and attempt.

## Documentation and development

- [Compatibility and supported environments](docs/compatibility.md)
- [Service setup, diagnostics, upgrade, rollback, and uninstall](docs/usage.md)
- [Control contracts](contracts/README.md)
- [Data handling](docs/data-handling.md)
- [Contribution instructions](CONTRIBUTING.md)
- [Release builds and runtime inputs](docs/release.md)
- [Downstream changes and validation](docs/implementation.md)
- [Third-party notices for the bundled bridge](THIRD_PARTY_NOTICES.md)

The plugin is licensed under [Apache-2.0](LICENSE). The
[Symphony source](https://github.com/iharc-jordan/symphony) retains its upstream
license and attribution. The local build receipt identifies the exact runtime
source revision used with this plugin.
