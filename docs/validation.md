# Release validation

The source currently contains development work. This matrix states the required
proof; it is not a claim that all rows have passed. Keep exact revisions and
receipts with the release being assessed. A passing unit fixture does not prove
process lifetime, configured installation, or an accepted real delivery.

| Boundary | Required evidence |
| --- | --- |
| Tracker reads | Pagination of items and native blockers; duplicate issue numbers across repositories; excluded archived/draft/PR/inaccessible items; missing statuses and provider errors. |
| Workspace selection | Correct repository and starting commit; rejection of path escapes and mismatches; explicit enrollment; underlying issue identity retained across membership replacement. |
| Dependent workflow | Two independent results followed by integration; only current accepted prerequisites unlock it; membership-only negative control never dispatches. |
| Mutations | Equal idempotency requests reuse the outcome; conflicting requests and stale revisions reject; duplicate reports cannot repeat effects. |
| Provider effects | Intent recorded before each write; partial or unknown Project/issue writes reconcile; incomplete acceptance cannot unlock dependencies. |
| Ownership | Exclusive resource conflicts serialize; active revision or route changes fence the old attempt; uncertain stops retain claims and workspaces. |
| Recovery | Real worker and supervisor crashes; persisted blockers; damaged or unknown journal versions; duplicate instance rejection; explicit reconciliation before continuation. |
| Conversation | Real same-thread continuation and exact thread resumption after confirmed process stop; missing history is explicit; interrupted turns are not replayed. |
| Worker permissions | Actual allowed checkout writes and Git commit; denied control configuration/token/journal and sibling workspaces; absence of inherited PM controls and recursive delegation. |
| Process containment | Real command, PTY and background descendants stop within the owned service boundary; an unknown stop cannot authorize reassignment or cleanup. |
| Routing and limits | Actual model/effort parameters, forbidden route rejection, explained escalation, transient retry exhaustion, durable total turns and usage accounting across resume. |
| Service lifetime | MCP disconnect and caller exit leave authorized work running; hidden standard-user Windows keeper respects enabled state; explicit stop ends owned execution. |
| Installation | Tracked-files-only package, paths with spaces, fresh-task MCP invocation, configured controls, upgrade/rollback, uninstall preserving shared CLIs and user work. |
| Executable | Pinned integration/dependencies, upstream quality gate, runtime dependency audit, reproducible release build, executable launch without development tools on PATH. |
| Real delivery | Fresh PM uses the installed runtime; bounded change meets its own integration/test/release requirements and is accepted; elapsed time, usage, rework and interventions reported. |
| Public release | Sanitized source and artifacts available at pinned revisions; public Git installation works; both focused upstream PRs submitted. |

Run focused checks while implementing. Run the upstream quality gate and plugin
typecheck, tests, build and manifest validation on the completed candidate.
Repeat only when a subsequent change or concrete unresolved risk invalidates the
relevant evidence. Preserve unaccepted work and unrelated services during all
failure tests.

Worker token limits cover recorded worker usage. Report telemetry delays and
possible in-flight overshoot. Record PM usage separately when available; label
it unavailable otherwise. One accepted pilot does not establish a percentage
cost saving.
