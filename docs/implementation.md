# Delivery contract

Approved 2026-09-09. The user-visible implementation plan in the Codex task is
the scope authority. This file records integration interfaces and current work.

## Fixed architecture

Symphony upstream baseline: `8001b52e3062495a16e520e4ceaf8f9de868c4d0`.
One Ubuntu execution host, one managed GitHub Project, two concurrent workers.
Windows desktop PM -> bundled stdio MCP bridge in WSL -> authenticated loopback
Symphony API -> existing Orchestrator -> Codex App Server workers.

Plugin name `codex-orchestration`; Apache-2.0. Local development until disposable
checks and one real IHARC delivery pass. Then publish the plugin and Symphony
integration source and submit independent Projects and hook-context PRs.

Public installation must work from a pinned Git marketplace without asking users
to build TypeScript. Ship the generated runtime bundle in the plugin package and
tagged source used by that marketplace (for example `mcp/server.mjs`, not an
ignored `dist` dependency). A repository marketplace can point to `./`: official
docs confirm paths resolve relative to repository root and example plugin-folder
layouts are not mandatory. Validate this with a clean temporary Codex home before
release. Preserve the existing personal marketplace entry for local development.

The installed openai-developers MCP configuration provides a working local
pattern: `command: node`, `cwd: .`, `args: [./mcp/server.mjs]`. Verify the same
relative-path behavior from this plugin's actual installed cache.

No Project State integration, native Windows worker runtime, distributed claims,
curated marketplace requirement or assumed desktop-sidebar worker integration.

## Components and ownership

| Component | State | Owner |
| --- | --- | --- |
| Required WSL toolchain and real worker proof | ACCEPTED | PM verified |
| Additive github_projects tracker | ACCEPTED: 312 tests, full gate, both live reads; integrated d50dfaf | PM verified |
| Generic hook context | ACCEPTED: 308 tests, full gate, integrated c3397b5 | PM verified |
| Managed AppServer routes, resume and reports | ACCEPTED R1: 7526f12 plus reviewed budget fixes 3ac2a7e/48310ed; integrated e9415bf | PM verified |
| Managed process containment and permission proof | ACTIVE R2 | AppServer worker |
| Managed journal/lifecycle/controls | ACTIVE: feature/managed-core from d50dfaf | projects worker |
| Plugin MCP/client/skills | ACCEPTED R1: 63d6972; operation schemas follow core | PM verified |
| Service setup and launchers | ACCEPTED R2: 08dabb8, Linux and Windows lifecycle fixtures | PM verified |
| Release dependencies | ACCEPTED: 137e8d1, full gate with 324 tests and clean dependency audit; integrated 66e2b94 | PM verified |
| Self-contained executable and runtime notices | WAITING on combined runtime candidate | bridge worker |
| Personal marketplace installation/discovery | ACCEPTED: installed 0.1.0, actual fresh-task MCP diagnostics | PM verified |
| Installed disposable workflow and recovery | WAITING on implementation | PM |
| Fresh IHARC PM pilot | WAITING on installed proof | PM |
| Public source/release/upstream PRs | WAITING on pilot | PM |

All new implementation workers use an explicit 5.6 route. Existing workers keep
their current route. Integration and release decisions remain with the PM.

## Tracker and hook contract

`tracker.kind = github_projects`; provider keys: `owner_type` (`user` or `org`),
`owner`, `project_number`, `status_field_name` (default `Status`). Existing
`active_states`, `terminal_states`, and required-label options stay under tracker.

`Issue.id` is the Project item node ID. `Issue.identifier` is
`owner/repository#number`. `native_ref` includes `project_id`, `project_item_id`,
`issue_id` (underlying global issue node ID), `repository` (owner, name,
name_with_owner, id, url), `issue_number`, and `content_type`.

The Projects adapter is read-only and generic. The managed execution profile owns
enrollment, board mutations and ACCEPTED prerequisite checks. A closed cancelled
issue is never equivalent to an ACCEPTED prerequisite in managed execution.

Hooks receive bounded JSON in `SYMPHONY_ISSUE_CONTEXT`: `id`, `identifier`,
`native_ref`. No title, body, credentials or executable command is included.
The proposed maximum is 16 KiB, with explicit failure on oversized context. The
trusted checkout helper validates repository enrollment and uses Git argument
arrays. It does not interpolate tracker strings into executable shell text.

## Managed control interface v1

All JSON wire keys use snake_case. The API binds only to loopback. Managed
endpoints require a bearer token loaded from a private local file. The MCP bridge
does not implement a second scheduler or retain a second assignment database.

- `GET /api/v1/managed/state`: compact current state and latest cursor.
- `GET /api/v1/managed/events?after=N&wait_ms=M&limit=L`: changed events;
  wait <= 60000 ms, limit <= 100, durable monotonic cursor.
- `POST /api/v1/managed/control`: `{request_id, operation, args}`. Repeating a
  request ID with the same input returns the recorded result; different input
  is a conflict. Assignment mutations include the expected current revision.

Operations: `bind_project`, `enroll`, `revise`, `pause`, `resume`, `interrupt`,
`cancel`, `review`. Read/control schemas and error values must be shared between
the Elixir service tests and TypeScript bridge as checked fixtures.

- Binding supplies explicit Project identity/status mapping/repository allowlist.
- Enrollment references an existing issue/item and supplies revision, base Git
  commit, ownership/resources, and the resolved allowed model/effort route.
- Revision updates material requirements and invalidates conflicting old work.
- Pause stops new dispatch/retries and drains healthy active work. Resume polls.
- Host stop uses `pause` with `args.disable = true`: persist disabled intent and
  deny further turns before stopping the owned systemd unit. Ordinary pause has
  `disable = false` and lets healthy active assignments continue to review.
- Interrupt/cancel reconcile the actual owned process state before release.
- Review accepts current evidence, requests rework, or records WAITING.

Setup/start/stop use the host service manager. Stop persists paused/disabled
intent before stopping owned execution; install does not arm or dispatch work.
The Windows enabled-service marker governs logon restoration only; it is not an
assignment store. A normal pause keeps that marker but preserves paused journal
state across restart. Uninstall preserves configuration, journal and workspaces.

The worker has an attempt-scoped dynamic `orchestration_report` tool for result,
checkpoint and context-needed reports. It cannot accept work or invoke PM
controls. Missing result/evidence is not successful acceptance.

## Lifecycle invariants

States: READY, ACTIVE, WAITING, REVIEW, ACCEPTED, CANCELLED. The board owns these
workflow facts. disk_log persists execution intent/outcome, ownership generation,
revision, route, attempt/thread/turn/workspace identity, blocked state, retries,
event cursor, usage and pending publication. Do not duplicate full transcripts.

Underlying issue identity and declared exclusive resources gate ownership even
when Project membership IDs change. Unknown stop/side-effect state blocks
conflicting dispatch and cleanup. Corrupt state fails visibly without resetting.

Keep live thread continuation. After a confirmed process stop, resume the saved
thread with a new recovery turn and current facts; do not replay an interrupted
turn or silently substitute a fresh thread. The same existing global Codex CLI
and account remain in use.

Default Luna/xhigh; only Luna/max and Terra/xhigh or Terra/max with a reason.
Do not silently change an existing route or delegate recursively. Two automatic
transient retries maximum; 20 turns across an assignment allowance, not a new
allowance on each retry. Optional worker budget excludes the external PM and
documents delayed telemetry and in-flight overshoot.

## Delivery evidence

### AgentRunner / AppServer integration boundary

The managed core passes explicit keyword options to `AgentRunner.run/3`:
`model`, `effort`, optional `resume_thread_id`, `max_turns` (remaining allowance),
`managed_attempt` (assignment/revision/generation/attempt identity), and an
attempt-scoped report callback. Generic callers retain existing defaults.
AppServer sends the selected model in thread start/resume and turn start, and
effort in turn start. A resumed thread must match the requested ID and resolved
route; unsupported or missing history returns an error, never thread/start.

The core owns the durable allowance and authorization for each next turn. Runner
callbacks obtain a serialized decision before a new turn; successful reporting
ends work at REVIEW or WAITING without waiting for a stale board poll. Agent
events include thread and turn IDs separately so recovery does not parse a
concatenated display session ID. The report tool exposes no PM controls.

The application already includes Burrito release targets for Linux x86_64 and
arm64. Reuse this upstream release path for the self-contained executable rather
than inventing another runtime packager.

A real pilot must select one bounded, already-authorized deliverable using its
current repository instructions and provider, funding and test constraints.
Do not implicitly enroll an entire program or restart predecessor tasks.
Keep private pilot prompts, issue content and detailed receipts outside the
public plugin repository.

Record targeted checks, exact revisions and unresolved gaps per component. Run
upstream make all and plugin typecheck/test/build/manifest validation after
integration. Prove actual installed MCP operation, a multi-repository dependency
workflow, interruption/recovery, route enforcement and host/client separation.

The service wrapper fixture at `08dabb8` passed setup/start/pause/resume/stop,
upgrade/rollback, duplicate wrapper locking, and uninstall preservation checks.
Windows verification used an installation path containing spaces and confirmed
that a missing enabled marker prevents startup, the hidden standard-user task
maintains the WSL session after the caller exits, and stop removes that keeper.
The PM verified that owned test units/tasks were removed and the existing
`Launch Codex` task remained unchanged. These fixtures used a test managed API;
the actual Symphony recovery and installed workflow checks remain outstanding.

Personal marketplace installation of `0.1.0` succeeded with the bundled bridge.
A fresh Codex task called the actual `orchestration_diagnostics` MCP tool through
WSL and received the expected `config_missing` response before service setup.
This establishes discovery and launch only. A configured service, managed
controls, and clean public Git installation still require their own proof.

A separate clean installation at `0c9a098` used only tracked files, a temporary
Codex home, and a repository-root marketplace. The installed package contained
neither `node_modules` nor Git metadata. Its bundled bridge listed all 11 MCP
tools, answered diagnostics through WSL, and exited successfully on disconnect.
Public Git fetching remains a later release check.

The approved private IHARC Labs GitHub Project exists. A fresh Astra PM selects
one bounded already-authorized delivery from existing IHARC work and uses the
installed service. Preserve paused tasks and private data. Public release follows
acceptance, not merely worker completion; upstream PR submission is required,
upstream merge is not.

## Downstream patch register

| Change | Reason | Compatibility and disposition |
| --- | --- | --- |
| `feature/github-projects` | Read exact Project membership, status and cross-repository issue dependencies. | Additive tracker; existing GitHub adapter stays unchanged. Submit separately upstream and replace with a verified upstream implementation when available. |
| `feature/hook-context` | Supply bounded provider-neutral repository identity to trusted workspace hooks. | Existing hook commands remain valid. Submit separately upstream; remove downstream commits after the accepted upstream contract is verified. |
| Managed AppServer routes and resume | Enforce worker routing, report scope, per-turn authorization and exact conversation recovery. | Opt-in managed behavior; preserve generic callers. Keep separate from tracker/hook PRs and propose independently reusable parts later. |
| Managed journal, lifecycle and controls | Preserve execution ownership and reconcile external effects across interruption. | Opt-in extension; GitHub retains workflow authority and Symphony remains the scheduler. Retire individual additions only when upstream provides equivalent tested invariants. |
| Release dependency updates | Address advisories reported by the dependency resolver for shipped packages. | Keep lockfile/runtime changes separate from focused upstream contributions. Pin validated versions and retain a working rollback release. |

For every release, record exact integration and plugin revisions plus the tested
runtime/dependency versions. Upstream merge alone does not remove a patch: verify
the replacement against the affected managed and generic behavior first.
