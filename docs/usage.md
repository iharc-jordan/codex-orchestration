# Lifecycle

Run the bundled CLI from the installed plugin directory. State is stored under
`%LOCALAPPDATA%\CodexOrchestration` as its single public installation root. The
setup skill is packaged at
`skills\setup\SKILL.md` and describes the same first-install flow.

Use the published `release-manifest.json` shipped alongside the plugin (or the
release owner's published manifest); do not hand-write a digest. Start from
the included workflow template, replacing its project-specific values, or
provide another absolute workflow path:

    Copy-Item .\fixtures\WORKFLOW.example.md C:\Users\you\Downloads\WORKFLOW.md
    node .\mcp\cli.mjs setup --release-manifest .\release-manifest.json --workflow C:\Users\you\Downloads\WORKFLOW.md --version 0.4.0
    node .\mcp\cli.mjs start
    node .\mcp\cli.mjs diagnostics
    node .\mcp\cli.mjs pause
    node .\mcp\cli.mjs resume
    node .\mcp\cli.mjs stop
    node .\mcp\cli.mjs upgrade --release-manifest .\release-manifest.json --version 0.4.0
    node .\mcp\cli.mjs rollback
    node .\mcp\cli.mjs uninstall

setup creates the task but does not start it. start waits for an authenticated
loopback readiness response. stop submits the service pause control once and
ends only the owned task. uninstall removes only the owned task and launcher
files; private configuration, release ZIP contents, state, logs, and workspaces
remain recoverable.

The mutating CLI commands execute through one bounded, same-user, on-demand
task so `%LOCALAPPDATA%\CodexOrchestration` is physical even when the command
originates in a packaged desktop process. Place workflow, offline ZIP, and
token-file inputs in an ordinary user-profile directory visible outside that
process ancestry, such as `%USERPROFILE%\.codex\orchestration-setup`; do not
stage them in a redirected `%TEMP%` or AppData shadow. The transient task and
its ACL-protected nonce request/result directory are removed after each
confirmed invocation. An uncertain task outcome is stopped only after exact
SID/action verification and is never replayed.
`diagnostics` also reads the native task state, last result/run time, startup
action, and selected release entry/helper validation; sensitive action values
are redacted.

For an offline archive, use `--executable C:\path\release.zip` with
`--sha256` followed by the same 64-character digest recorded in the published
trusted release manifest. The manifest identifies iharc-jordan/symphony
v0.4.0 and its release-owned runtime revision, download URL, and SHA-256. Do
not hand-write or substitute a digest.

The bridge publishes 13 tools immediately. Mutations preserve caller request
IDs and revision/ownership fences, never retry after transmission, and return
mutation_outcome_uncertain when delivery cannot be known.

Use delegation when it materially helps the outcome. Keep small coupled work in
the current task. The Sol delivery PM owns managed-worker routing and routine
acceptance, integration, and release after confirming the trusted native PM
tools. User steering travels through native task messaging to Sol and then the
existing enroll, revise, pause, or cancel controls; cancellation is not
acceptance and unaffected work and proof remain valid.

Read compact state first. If a report summary is marked `truncated`, read the
assignment's full detail before relying on its evidence. Managed-worker usage is
telemetry only, distinguishes cached input from ordinary input, and must not be
presented as full PM/Astra use or billed dollars. Do not add polling loops, an
inbox service, or a duplicate scheduler. The dashboard remains the existing
root-owned LiveView path with `?view=live&pm=<PM task identity>`.

For worker App Server startup, the workflow contains only the validated
absolute `codex.launcher` path. The runtime invokes the public npm shim
through fixed `cmd.exe /d /s /c` arguments (`app-server -c
features.multi_agent=false -c features.multi_agent_v2=false`); pass `--launcher`
only when an explicit absolute
replacement is needed. The plugin does not search desktop internals or create
a duplicate CLI installation.

Setup stores provider authentication (such as `GITHUB_TOKEN`) in the private,
ACL-protected controller environment beneath the orchestration root. It keeps
task/credential identity filtering scoped to app-server/helper processes while
preserving normal profile and Codex plugin discovery. After setup, read state
and send one operator `bind_project` envelope with the current revision and
PM-approved project binding, then confirm state before using PM tools.
The bundled workflow stores managed recovery in
`$SYMPHONY_STATE_ROOT\managed.sqlite3` through `managed.store_path`.
