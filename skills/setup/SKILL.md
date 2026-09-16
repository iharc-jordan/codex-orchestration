---
name: setup
description: Install and operate the Windows-only Symphony 0.4.0 runtime packaged with Codex Orchestration.
---

Use this skill for a first install or an intentional lifecycle change. This
plugin supports native Windows only and keeps its private state under
`%LOCALAPPDATA%\CodexOrchestration`; this is the sole public installation
authority and has no alternate root option.

For an online install, use the published `release-manifest.json` shipped with
the plugin package (or the release owner's published manifest). Do not
hand-write or copy a digest from an untrusted source. Start with the bundled
workflow template, copy it to a private working file, and replace its project
binding values and provider settings:

    $plugin = (Get-Location).Path
    $setupRoot = Join-Path $env:USERPROFILE ".codex\orchestration-setup"
    New-Item -ItemType Directory -Force -Path $setupRoot | Out-Null
    $workflow = Join-Path $setupRoot "WORKFLOW.md"
    Copy-Item "$plugin\fixtures\WORKFLOW.example.md" $workflow
    $manifest = Join-Path $plugin "release-manifest.json" # published package asset
    if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "obtain the published release-manifest.json for this package" }
    # Edit the copy: tracker.provider.owner/project_number and the provider
    # token reference must match the PM-owned project; keep managed paths.
    node "$plugin\mcp\cli.mjs" setup --release-manifest $manifest --workflow $workflow --version 0.4.0

For an offline install, use an absolute ZIP path and the SHA-256 from that
published manifest (or an independently verified release receipt):

    node .\mcp\cli.mjs setup --executable C:\path\symphony-windows.zip --sha256 <64-hex-digest> --workflow C:\path\WORKFLOW.md --version 0.4.0

The ZIP is accepted only when it contains regular files
`bin\symphony.bat` and `bin\symphony-worker-host.exe`. Setup stages an
immutable release and records `current`/`previous`; it creates one hidden,
least-privilege interactive-token scheduled task. It does not start the task.
Lifecycle mutations themselves run once through a uniquely named, bounded,
same-user on-demand task so the fixed LocalAppData root is not redirected by a
packaged desktop ancestor. Keep workflow, token-file, and offline ZIP inputs in
an ordinary user-profile path such as `%USERPROFILE%\.codex\orchestration-setup`,
not `%TEMP%` or another redirected AppData path. The temporary task and its
private nonce-bound request/result staging are removed after a confirmed
result; an uncertain invocation is never replayed.
The bundled workflow uses only `managed.store_path:
$SYMPHONY_STATE_ROOT\managed.sqlite3` for managed persistence.
Run `start`, wait for its authenticated 60-second readiness check, and use
`diagnostics` before lifecycle controls. `upgrade` stops and verifies the task
before switching the release pointer; `rollback` follows the same rule.

Keep workflow credentials and project values outside the plugin source. Setup
captures provider authentication names such as `GITHUB_TOKEN` into the ACL-
protected controller environment file; the controller loads that private file
at task launch. Task identity, PM identity, and credential variables are then
filtered case-insensitively from the app-server/helper environment while normal
Windows profile and Codex plugin discovery remain available.

After setup, bind the PM-owned project explicitly through the operator control
path. Read `orchestration_state` first, use its current `revision`, and send a
single `bind_project` envelope with the complete project binding (project id,
number, status/projection fields, status options, and repository list):

    node "$plugin\mcp\cli.mjs" control --input C:\path\bind-project.json

The envelope must contain only `request_id`, `operation: "bind_project"`, and
`args`; `args.expected_revision` must be the state revision and `args.project`
must be the PM-approved binding. Confirm the returned request id and state
before registering a PM. Never auto-replay an uncertain mutation. Register the
PM only through the trusted MCP `_meta.threadId` flow after the operator
binding is confirmed.

Never add a second scheduler, WSL/Linux/SSH execution path, updater, or copied
CLI.
