# Codex Orchestration

Build the approved Symphony-backed orchestration plugin. Keep one scheduler: the
existing Symphony Orchestrator. GitHub Projects and repository issues own work;
the runtime's private SQLite state records execution recovery only.

Persistent user decisions live in the canonical project REQUIREMENTS.md; use
the plugin requirements tools to capture explicit changes and preserve scope.

- User authority and current assignment revisions govern execution.
- Current user direction governs repository delivery. Do not require the plugin
  itself, a product-managed pilot, or fixed model roles to coordinate its implementation.
- Keep upstream Projects and hook-context changes independent of managed policy.
- Runtime and workers execute on supported native Windows hosts; do not add fallback execution paths.
- Do not install duplicate global Codex/GitHub CLIs or alter other projects.
- Keep credentials, local binding/configuration, worker records and private pilot
  artifacts out of this repository and its public release.
- Publish only after the repository checks and the current user-authorized native
  packaged acceptance pass.
- Use real process tests for lifecycle guarantees. Do not label a mock test as
  end-to-end proof or a worker completion as PM acceptance.
- Preserve unaccepted changes, unknown process state, and unrelated services.
- Windows lifecycle and usage details are in docs/windows.md and docs/usage.md.

Repository checks will be defined with the TypeScript implementation. Run focused
tests while iterating, then typecheck, test and build before integration. Validate
the plugin manifest using the installed Plugin Creator validator.
