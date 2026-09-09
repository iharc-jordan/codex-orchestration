# Codex Orchestration

A Codex plugin for an Astra PM working with a persistent pool of 5.6 workers,
using OpenAI Symphony on Ubuntu and GitHub Projects for workflow state.

**Development snapshot:** personal marketplace installation and actual MCP
discovery have passed. Managed dispatch, process recovery, the real pilot, and
public release validation are still in progress. See the
[delivery record](docs/implementation.md) for the current evidence boundary.

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

The initial profile supports one Project, one Ubuntu execution host, and two
concurrent workers. Windows uses Ubuntu WSL2 for execution; native Ubuntu is also
a supported target. Work stops for PM review before acceptance unlocks dependent
assignments.

## Local installation

The repository includes a marketplace entry pointing to the plugin at its root.
From a local checkout:

```shell
codex plugin marketplace add /path/to/codex-orchestration
codex plugin add codex-orchestration@codex-orchestration
```

For an existing personal marketplace entry, use its own marketplace name instead:

```shell
codex plugin add codex-orchestration@personal
```

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

## Documentation and development

- [Compatibility and supported environments](docs/compatibility.md)
- [Service setup, diagnostics, upgrade, rollback, and uninstall](docs/usage.md)
- [Control contracts](contracts/README.md)
- [Data handling](docs/data-handling.md)
- [Contribution instructions](CONTRIBUTING.md)
- [Release builds and runtime inputs](docs/release.md)
- [Downstream changes and validation](docs/implementation.md)
- [Third-party notices for the bundled bridge](THIRD_PARTY_NOTICES.md)

The plugin is licensed under [Apache-2.0](LICENSE). Symphony retains its upstream
license and attribution. The runtime integration, executable, and reproducible
release instructions will be published after the required installed workflow,
recovery, and pilot validation passes.
