# Codex Orchestration

Codex Orchestration 0.5.0 is a Windows 11 x64 MCP bridge and lifecycle manager
for one local Symphony managed delivery control plane. Delegation is the
default when it materially helps; small, tightly coupled work stays local.

It publishes 16 MCP tools immediately, before reading configuration or
contacting the runtime. Calls use one direct authenticated 127.0.0.1 client.
Trusted MCP thread metadata derives the PM credential; caller request IDs and
revision fences are forwarded exactly. A transmitted mutation is never replayed:
an interrupted response is reported as mutation_outcome_uncertain.

Managed state summaries expose additive worker activity, configured escalation
reason, latest-report timestamp, and an explicit truncated marker for compact
report summaries. Managed-worker usage reports input, cached-input, output, and
total telemetry with completeness/accounting status; it excludes PM and Astra
use and is not a billed-dollar total.

The Windows lifecycle owns private data beneath
%LOCALAPPDATA%\CodexOrchestration, one hidden least-privilege Scheduled Task,
and immutable standard Mix release ZIP directories. It has no alternate runtime,
keeper, bootstrap helper, path translation, desktop-internals scan, or duplicate
Codex CLI path.

The Windows release disables Erlang distribution and ships no release cookie.
The bundled native Job helper owns the controller process tree, so lifecycle stop
does not depend on Erlang RPC or leave the controller behind the Scheduled Task.

Lifecycle mutations cross the packaged-app boundary through a bounded,
same-user, on-demand Scheduled Task that runs the public Node entrypoint
directly. Its nonce-bound request/result staging and task registration are
removed after every confirmed invocation; the runtime task is the only
persistent task.

See docs/windows.md for the runtime environment contract and docs/usage.md for
the lifecycle commands. The public control envelope remains documented in
contracts/README.md.

Persistent [project requirements](docs/requirements.md) are loaded automatically
for ordinary tasks and managed workers through bundled Codex hooks. Source-linked
decisions live in `REQUIREMENTS.md`, independently of native memory and Symphony
availability. Review and trust the installed hooks in `/hooks` to activate them.
