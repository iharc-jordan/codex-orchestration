# Implementation and delivery record

This is the public maintainer record for the plugin's downstream Symphony
integration. The canonical Symphony source reviewed for this record is
`011c7233aa64307f63ac808c4e2802c8bebda819`; the current managed runtime
version is `0.1.6`.

The alpha and beta validation sets, canonical integration, and the initial
installed disposable workflow are accepted. That workflow accepted all four
fixture assignments, unlocked dependent integration only after alpha and beta
acceptance, and merged and pushed preserved commits into the fixture
repositories. Its interruption/recovery run also completed with exact-once
filesystem and commit effects. The qualified 0.1.6 source gate passed 425
tests with zero failures, six skips, 100% configured coverage, format, specs,
Credo, and Dialyzer. The 0.1.6 binary is built, installed, and passed the
upgrade/start check with HTTP 200 while preserving MCP state. The bounded PM
pilot is resuming on 0.1.6; pilot acceptance and public release remain
pending.

## Fixed architecture

Symphony remains the only scheduler. The initial profile uses one Linux
execution host, one managed GitHub Project, and two concurrent workers. The
Codex desktop PM calls the bundled stdio MCP bridge; the bridge calls the
authenticated loopback Symphony API; Symphony owns assignment state and starts
Codex App Server workers.

The plugin is Apache-2.0 and remains in local development until the bounded
pilot passes. The plugin package carries
the generated bridge bundles so a pinned Git marketplace install does not need a
TypeScript build. The repository-root marketplace layout and relative MCP paths
must be checked again from a clean public Git installation before release.

The initial release does not include Project State synchronization, a native
Windows worker runtime, distributed scheduling, automatic migration of desktop
workers, or an assumed desktop-sidebar worker integration. Credentials,
configuration, journal data, workspaces, and detailed pilot receipts remain
outside this repository.

## Component ledger

| Area | Status | Evidence boundary and next proof |
| --- | --- | --- |
| GitHub Projects tracker | ACCEPTED for alpha/beta | Additive adapter coverage includes 312 tests and live provider reads. Keep the upstream contribution independent and retain generic tracker behavior. |
| Provider-neutral hook context | ACCEPTED for alpha/beta | Bounded identity context and rejection rules are covered by the hook suite. Keep the upstream contribution independent. |
| Managed App Server routes, resume, and reports | ACCEPTED for alpha/beta and recorded disposable run | Route enforcement, attempt identity, resume semantics, per-turn authorization, and report scope are covered by the qualified source gate and installed run. Recovery used the same App Server thread with a new turn and generation; 0.1.6 pilot validation remains pending. |
| Managed checkout and process containment | ACCEPTED through installed disposable workflow | Trusted checkout and session-mode fixtures exercise the preparer before Codex startup. Four assignments completed through acceptance, with preserved commits merged and pushed in the fixture repositories. |
| Managed journal, lifecycle, and controls | ACCEPTED for alpha/beta, recorded disposable run, and qualified 0.1.6 source gate | Durable controls, revisions, effect intents, retry bounds, and lifecycle fixtures are covered. Successful revision recovery resets retry/block state while retaining a nonzero lifetime allowance, rereads current intents after controls-first recovery, and retires obsolete automatic intents only after provider and local commit. |
| MCP bridge, CLI, skills, and checkout helper | ACCEPTED through installed disposable workflow | Bundle, type, test, build, manifest, fresh-task diagnostics, managed controls, and four-assignment workflow checks have passed. A fresh native app-server process also listed all 11 installed orchestration tools and completed an `orchestration_diagnostics` call without a model turn. |
| Linux service and Windows WSL launcher | ACCEPTED for recorded alpha/beta and disposable runs; 0.1.6 upgrade/start PASSED | Setup/start/pause/resume/stop, upgrade/rollback, locking, uninstall preservation, forced process stop, and recovery fixtures have passed. The 0.1.6 installation upgrade/start check returned HTTP 200 and preserved MCP state. |
| Self-contained runtime | 0.1.4 SMOKE PASSED; 0.1.6 INSTALL/START PASSED | The installed 0.1.4 binary from `0a53a0a` passed its build smoke. The 0.1.6 binary built from `011c7233aa64307f63ac808c4e2802c8bebda819` passed installation/start verification; the bounded pilot is resuming. |
| Installed disposable workflow | ACCEPTED | Four assignments were enrolled, dispatched, reviewed, accepted, and cleanly stopped; alpha/beta concurrency and integration unlock behavior matched policy. |
| Restart and interruption recovery | PASS RECORDED; 0.1.6 pilot resuming | A pending requirements revision survived an owned service-process stop; the same App Server thread resumed with a new recovery turn, one checkpoint, one completion, exact-once filesystem/commit effects, and no rewind. Exact duplicate control submission was idempotent. The qualified source gate covers controls-first recovery, current-intent reread, retry/block reset, and ordered obsolete-intent retirement. |
| Bounded pilot | RESUMING | The bounded PM pilot is resuming on the installed 0.1.6 service after the verified upgrade/start check; no pilot acceptance has been recorded. |
| Public release and upstream submissions | WAITING | Public publication has not been performed. Publish only after the pilot and release checks pass; upstream merge is not required before submission. |

## Tracker and hook contract

The managed profile uses `tracker.kind = github_projects`. Provider settings
identify one exact user or organization Project, its status field, repository
allowlist, and existing active/terminal state policy. `Issue.id` is the Project
item node ID; `Issue.identifier` is the repository issue identifier;
`native_ref` carries provider identity and location metadata only.

The Projects adapter is read-only and generic. Managed enrollment owns board
mutations and prerequisite checks. A closed or cancelled issue is not an
`ACCEPTED` prerequisite.

Hooks receive bounded JSON in `SYMPHONY_ISSUE_CONTEXT` containing `id`,
`identifier`, and `native_ref`. It excludes title, body, credentials, and
commands. Oversized, malformed, credential-bearing, or executable-bearing
contexts fail explicitly. The trusted checkout helper validates the enrolled
repository and passes Git values as argument arrays rather than interpolated
shell text.

## Managed control interface v1

All JSON wire keys use snake_case. The API binds only to loopback. Managed
endpoints require a bearer token loaded from a private local file. The bridge
does not implement a second scheduler or retain a second assignment database.

- `GET /api/v1/managed/state` returns compact managed state and the latest cursor.
- `GET /api/v1/managed/events?after=N&wait_ms=M&limit=L` returns durable,
  monotonic events, with bounded wait and page sizes.
- `POST /api/v1/managed/control` accepts `{request_id, operation, args}`.
  Repeating an ID with the same input returns its recorded result; changed input
  is a conflict. Assignment mutations include the expected revision.

Operations are `bind_project`, `enroll`, `revise`, `pause`, `resume`,
`interrupt`, `cancel`, and `review`. The control schemas and error values are
shared between the Elixir service tests and the TypeScript bridge through
checked fixtures.

Enrollment names an existing issue and Project item, pinned base commit,
ownership/resources, and a resolved allowed model/effort route. Revision checks
material requirements before committing them. Pause stops new dispatch and
retries while healthy active work drains to review. A disabled pause is durable
before a host stop. Interrupt and cancel reconcile the owned process before
releasing it. Review records acceptance, rework, or waiting.

The attempt-scoped `orchestration_report` tool supports result, checkpoint, and
context-needed reports. It cannot accept work or invoke PM controls. Missing
result or evidence is not successful acceptance.

## Lifecycle invariants

The board owns `READY`, `ACTIVE`, `WAITING`, `REVIEW`, `ACCEPTED`, and
`CANCELLED`. The journal persists execution intent and outcome, ownership
generation, revision, route, attempt/thread/turn/workspace identity, blocked
state, retry count, event cursor, usage, and pending publication. It does not
duplicate full transcripts.

Underlying issue identity and declared exclusive resources continue to gate
ownership even when Project membership IDs change. Unknown stop or side-effect
state blocks conflicting dispatch and cleanup. Corrupt state fails visibly
without resetting it.

The managed profile keeps the saved Codex thread. After a confirmed process
stop, recovery resumes that thread with a new turn and current facts; it does
not replay an interrupted turn or silently start a fresh thread. The default
route is Luna/xhigh. Luna/max and Terra/xhigh or Terra/max require an explicit
reason. Two automatic transient retries are allowed, and the 20-turn assignment
allowance is shared across retries.

## Delivery evidence

The focused alpha/beta evidence covers the following boundaries:

- The real checkout fixture invokes the trusted preparer before Codex and
  captures fresh, resumed, and escalated session modes.
- Dispatch failure increments a durable retry count, permits two automatic
  retries, then records `WAITING` with a visible reason. An uncertain provider
  transition remains pending and is not replayed as a start effect.
- Provider transition recovery loads an unloaded provider module before checking
  its exported callback. Completed automatic effects are not replayed after
  restart.
- Denied filesystem paths are normalized before comparison; this does not claim
  symlink resolution. Approved requirements are supplied to revision preview
  and repeated identical control requests remain idempotent.
- Revision recovery prevalidates all pending controls before writes, rereads the
  current intent after recovery controls, resets retry/block state while
  retaining a nonzero lifetime allowance, and retires obsolete automatic
  intents only after provider and local commit.
- The reviewed Burrito 0.1.4 build smoke passed. Version changes force a fresh
  application extraction while retaining the previous versioned executable for
  rollback. The 0.1.6 binary is built from
  `011c7233aa64307f63ac808c4e2802c8bebda819`; installation/start verification
  passed with HTTP 200 and preserved MCP state.
- A fresh native Codex app-server process loaded `codex-orchestration@personal`,
  listed all 11 tools, reported the server connected after an ephemeral thread
  start, and successfully called `orchestration_diagnostics`. No model turn was
  started and the owned process exited cleanly. This proves native package
  loading and tool invocation, not desktop PM registry freshness.

These results include an installed disposable service, an owned-process
interruption/recovery run, a qualified 0.1.6 source gate, and a verified 0.1.6
installation/start. The bounded PM pilot is resuming and remains unaccepted;
these results do not prove a public release. Keep provider configuration, issue
content, credentials, and detailed receipts private.

## Downstream patch register

Each entry below states why the downstream change exists, what it preserves,
what has been checked, and when it can be retired.

| Change | Rationale | Compatibility | Verification boundary | Retirement condition |
| --- | --- | --- | --- | --- |
| GitHub Projects tracker | Read exact Project membership, status, repository identity, and cross-repository prerequisites. | Additive tracker adapter; existing adapters and generic callers remain unchanged. | 312-test suite and live reads; no managed write is owned by the adapter. | Retire after an upstream adapter provides the same normalized identity and dependency behavior with equivalent tests. |
| Provider-neutral hook context | Give trusted hooks bounded repository identity without exposing issue content or secrets. | Existing hook commands remain valid; the context is additive and size-limited. | Hook tests cover allowed fields, invalid fields, oversize rejection, and cleanup behavior. | Retire after upstream exposes the same bounded, fail-closed contract. |
| Managed App Server routes and resume | Enforce resolved worker routes, attempt-scoped reports, per-turn authorization, and exact conversation recovery. | Opt-in managed path; generic AgentRunner/App Server callers retain their defaults. | Route, resume, report, and turn-budget tests plus the session fixtures. | Retire individual changes only after upstream supplies the same tested managed invariants. |
| Managed journal, lifecycle, controls, and retry bounds | Preserve ownership and reconcile process/provider effects across interruption; stop dispatch-failure loops. | Opt-in managed state; GitHub Projects remains workflow authority and Symphony remains scheduler. | Journal/control/lifecycle tests, retry exhaustion test, and effect-intent recovery fixtures. | Retire after upstream has equivalent durable intent, ownership, reconciliation, and bounded-retry behavior. |
| Managed revision recovery and retry allowance | Recover revised assignments without consuming fresh lifetime turns or replaying obsolete automatic intents. | Successful `revise` resets retry/block state while retaining a nonzero lifetime allowance; recovery applies controls first, rereads the current intent, and requires provider plus local commit before retiring obsolete intents. | Qualified 0.1.6 source gate: 425 tests, zero failures, six skips, and 100% configured coverage, including revision-recovery scenarios. | Retire after upstream provides equivalent ordered recovery, allowance reset, and intent-retirement guarantees. |
| Trusted managed checkout | Prepare enrolled repositories at a pinned commit while preserving safe reusable workspaces. | Managed checkout only; generic `hooks.after_create` behavior remains available outside this profile. | Helper policy tests and installed four-assignment workflow; 0.1.6 pilot run is in progress. | Retire after upstream provides equivalent enrollment, ancestry, context, and argument-array safeguards. |
| Managed denied-path normalization | Remove redundant descendant denials beneath an already denied ancestor, avoiding Bubblewrap setup failures. | Expands and deduplicates path strings with component-boundary checks; preserves explicit workspace and `.git` write exceptions. It does not claim symlink resolution. | Focused path tests and a real configured App Server start; existing control files remain inaccessible while the assigned workspace stays writable. | Retire after the permission implementation accepts equivalent nested denials without setup failure. |
| Cold provider module loading | Avoid false provider-unavailable results after restart when a valid module is not loaded yet. | Loads the configured provider before checking its transition/review callbacks; no public API change. | Cold-module recovery fixture invokes the provider and records reconciliation. | Retire after upstream performs equivalent load-aware callback discovery. |
| Completed automatic-effect replay prevention | Avoid repeating an external side effect after its journal intent is already reconciled. | Recovery consults durable effect status; new pending intents retain existing behavior. | Completed-effect recovery test verifies no second provider call. | Retire after upstream makes completed-effect replay prevention durable and tested. |
| Approved requirements revision preview and idempotency | Validate the approved source requirements before committing a material revision and preserve exact-request replay semantics. | Managed `revise` only; unrelated control operations and generic tracker behavior remain unchanged. | Revision preview, provider rejection, and duplicate/conflicting request tests. | Retire after upstream provides equivalent source verification and request-idempotency guarantees. |
| Burrito application-version cache handling | Ensure a changed executable selects a fresh extraction while an older version remains available for rollback. | Release packaging only; existing target formats and rollback command remain supported. | Reviewed 0.1.4 build smoke and versioned extraction behavior; 0.1.6 binary built from `011c7233aa64307f63ac808c4e2802c8bebda819` passed installation/start verification. | Retire after Burrito or the release path guarantees fresh extraction for changed binaries without the version bump. |
| Release dependency updates | Keep shipped runtime dependencies within the reviewed resolver and security baseline. | Lockfile and runtime changes are isolated from focused upstream feature patches. | Qualified 0.1.6 source gate passed 425 tests with zero failures, six skips, 100% configured coverage, format, specs, Credo, and Dialyzer. | Rebase or remove once the upstream release baseline contains equivalent reviewed versions. |

Record exact plugin, canonical Symphony, executable, and dependency versions with
each release receipt. Upstream merge alone does not remove a downstream patch;
verify the replacement against the affected managed and generic behavior first.
