# Codex Orchestration

A Codex plugin for an Astra PM working with a persistent pool of 5.6 workers,
using OpenAI Symphony on Ubuntu and GitHub Projects for workflow state.

**Published v1:** the `v0.1.0` plugin with the `v0.1.6` Symphony runtime has
passed the recorded disposable installation, recovery, and bounded PM pilot.
The pilot reached PM acceptance after source integration, CI, and live
deployment verification. See the [delivery record](docs/implementation.md) for
the evidence and limits.

The current checkout also contains a `v0.2.0` managed-control candidate. It is
local development work: no `v0.2.0` marketplace entry, release artifact, or
real PM pilot has been published. Use the public v1 instructions below for the
released profile; use the candidate only with a matching local Symphony build
and disposable validation.

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

The published v1 profile supports one Project, one Ubuntu execution host, and
two concurrent workers. Windows uses Ubuntu WSL2 for execution; native Ubuntu
is also a supported target. Work stops for PM review before acceptance unlocks
dependent assignments.

The local v2 candidate extends the managed profile to multiple Projects and
repositories. Each assignment has one responsible PM, with explicit handoff to
another PM task, typed resource claims, and ownership revision fences. These
candidate controls have local contract coverage; they are not release or pilot
evidence.

## Installation

The public v1 distribution uses the pinned GitHub marketplace:

```shell
codex plugin marketplace add iharc-jordan/codex-orchestration --ref v0.1.0
codex plugin add codex-orchestration@codex-orchestration
```

Download `symphony_linux_x86_64` and its build receipt from the matching
[Symphony release](https://github.com/iharc-jordan/symphony/releases/tag/v0.1.6).
The executable includes Erlang and the application dependencies; existing
Codex, GitHub CLI, Node, Git, and systemd are still required. Follow the
[setup instructions](docs/usage.md) to configure the service before enabling it.

### From a local checkout

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

This local-checkout path is also how the unreleased `v0.2.0` candidate is
tested. It does not turn the candidate into a public release. Pair it with the
matching local Symphony source and private workflow, and do not use a
`v0.2.0` marketplace or runtime-release URL because none has been published.

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

## Managed v2 candidate contract

The candidate exposes ten native PM operations through the bridge:
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

The plugin is licensed under [Apache-2.0](LICENSE). Symphony retains its upstream
license and attribution. The
[managed Symphony source](https://github.com/iharc-jordan/symphony/tree/orchestration/integration)
and its release receipt identify the exact runtime used with this plugin.
