# Codex Orchestration

Build the approved Symphony-backed orchestration plugin. Keep one scheduler: the
existing Symphony Orchestrator. GitHub Projects and repository issues own work;
the operational journal owns execution recovery only.

- User authority and current assignment revisions govern execution.
- Root acts as PM. Delegate bounded implementation to the 5.6 family, default
  Luna/xhigh; preserve active worker routes. No worker recursively delegates.
- Keep upstream Projects and hook-context changes independent of managed policy.
- Runtime and workers execute in Linux; Windows hosts the plugin launcher/PM.
- Do not install duplicate global Codex/GitHub CLIs or alter other projects.
- Keep credentials, local binding/configuration, worker records and private pilot
  artifacts out of this repository and its public release.
- No publication before disposable validation and the real IHARC pilot pass.
- Use real process tests for lifecycle guarantees. Do not label a mock test as
  end-to-end proof or a worker completion as PM acceptance.
- Preserve unaccepted changes, unknown process state, and unrelated services.
- Full agreed interfaces and delivery tracking are in docs/implementation.md.

Repository checks will be defined with the TypeScript implementation. Run focused
tests while iterating, then typecheck, test and build before integration. Validate
the plugin manifest using the installed Plugin Creator validator.
