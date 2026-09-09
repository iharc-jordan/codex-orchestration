# Data handling

GitHub Projects holds workflow status. Repository issues hold assignment objectives, acceptance checks, permitted actions and ownership boundaries. The local Symphony journal holds operational records needed to enforce ownership and recover execution. The plugin does not operate a proprietary coordination backend.

## Where information goes

- The stdio MCP bridge sends authenticated controls and compact reads to the configured loopback Symphony API.
- The service reads and updates the bound GitHub Project and enrolled repository issues using host-side GitHub authentication.
- Managed Codex sessions receive the assignment context and workspace information necessary for the authorized work. Codex and GitHub continue to apply their own account and service terms.
- Linux workspaces contain repository checkouts and worker changes. Codex may retain local thread history through its existing installation so the service can resume the recorded conversation.
- The operational journal records assignment revisions, generations, attempt/thread/process/workspace identity, routes, pause and blocker state, turn reservations, usage baselines, event cursors, reports and external-effect intent/outcome. It is not a copy of the full issue database or conversation transcript.

Keep authentication files, the API token, local configuration and operational records outside repository content. Exclude private assignments, unsanitized logs and pilot artifacts from public source and releases. Reports should reference the minimum evidence needed for review; repository paths, issue identifiers and report text may themselves be sensitive.

## Authority boundaries

Project membership alone does not authorize execution. Enrollment, current assignment revision, dependencies and resource ownership constrain dispatch. Worker reports cannot grant PM acceptance or invoke unrestricted service controls.

Loopback authentication and worker permission profiles are distinct controls. A tool schema is not an operating-system security boundary. The supported installation uses the existing local account and Codex installation; it does not claim isolation from a hostile administrator or an unrestricted process running as that account.

## Retention and removal

Upgrade, rollback and uninstall preserve configuration, the operational journal and workspaces. Removing the plugin is not an instruction to delete unaccepted changes or Codex thread history. Resolve unknown process ownership and retain any required evidence before deliberately deleting data through the owning application or service's documented procedure.

Do not put tokens in issue bodies, command examples, reports or release logs. Error responses and diagnostics should identify the failed operation without echoing credential values.
