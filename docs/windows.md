# Windows 11 x64 operation

Version 0.4.0 supports Windows 11 x64 only. It does not start an alternate
runtime, translate paths, inspect Codex desktop internals, copy profiles or
cookies, or install a second Codex CLI.

The plugin owns one private root:

    %LOCALAPPDATA%\CodexOrchestration
      config\       config.json, token, controller-env.json, WORKFLOW.md
      releases\     immutable Windows Mix release directories
      state\        private runtime state and controller Job identity
      logs\         runtime logs
      workspaces\   runtime workspaces
      current       selected release version
      previous      rollback release version

The bundled workflow maps `managed.store_path` to
`$SYMPHONY_STATE_ROOT\managed.sqlite3`; this is the only managed persistence
path.

The public CLI has no alternate root option: `%LOCALAPPDATA%` is the sole
installation authority. Disposable tests pass an explicit root directly to
their in-process harnesses; ambient environment variables cannot redirect the
CLI or MCP server.

Every lifecycle mutation runs once through a uniquely named, hidden,
same-user on-demand task. That task executes the installed public `node.exe`
directly, reads an ACL-protected request beneath `%USERPROFILE%\.codex`, and
returns an atomic nonce/operation/exit result. The caller verifies the task
principal and exact action before running or cleaning it, never replays an
uncertain invocation, and removes the temporary task and staging after a
confirmed result. The child alone holds the existing lifecycle mutex. Root,
`config.json`, and token final paths are read back from both contexts so a stale
packaged-app shadow becomes an actionable conflict instead of a hidden second
installation.

Setup accepts a standard Windows Mix release ZIP. The staged version must
contain `bin\symphony.bat`, disable Erlang distribution in its versioned
`env.bat`, and omit `releases\COOKIE`; the release directory is immutable after staging.
Use the 0.4.0 release-manifest.json that pins repository iharc-jordan/symphony,
the exact runtime source revision, HTTPS GitHub download URL, and SHA-256.
Alternatively provide an offline ZIP with the same expected digest through --sha256. The
plugin verifies the digest before extracting either source.
The one persistent hidden CodexOrchestration scheduled task uses the current interactive
user, InteractiveToken, least privilege, a logon trigger, no execution time
limit, IgnoreNew, and up to three one-minute restarts.

The task runs the hidden PowerShell runner directly. The workflow contains the
validated absolute launcher path, and Symphony invokes it with fixed
`cmd.exe /d /s /c` arguments (`app-server -c features.multi_agent=false -c
features.multi_agent_v2=false`). It sets the absolute
SYMPHONY_WORKFLOW_PATH, SYMPHONY_LOGS_ROOT, SYMPHONY_STATE_ROOT,
SYMPHONY_WORKSPACES_ROOT, SYMPHONY_WINDOWS_WORKER_HOST,
SYMPHONY_SERVER_HOST=127.0.0.1,
SYMPHONY_SERVER_PORT, SYMPHONY_MANAGED=true, and
RELEASE_DISTRIBUTION=none. It invokes the selected release through the bundled
native Windows Job helper, which persists the exact controller process identity
and owns the full controller process tree. Task identity and credential variables are
filtered case-insensitively for the app-server/helper launch; provider
authentication (for example `GITHUB_TOKEN`) is captured in the ACL-protected
`config\controller-env.json` and loaded for the controller. Normal user profile
and Codex plugin-discovery variables remain available.

The bridge config accepts only 127.0.0.1; it never contacts the runtime merely
to register its MCP tools. `start` has one absolute 60-second readiness deadline.
Stop, upgrade, rollback, and uninstall verify termination of the recorded
controller Job without Erlang RPC before changing the selected release or task.
