# Contributing

Keep the existing Symphony Orchestrator as the only scheduler. GitHub Projects and repository issues own work; the runtime's private SQLite state records execution recovery. Prefer a small addition to the existing control, tracker or session boundary over a second scheduler, task database or compatibility layer.

Read [AGENTS.md](AGENTS.md) for ownership and validation rules and [the Windows lifecycle contract](docs/windows.md) before preparing fixtures or logs.

For plugin changes, use the locked dependencies and run the checks relevant to the changed behavior:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Validate plugin discovery with the installed Codex manifest tooling and test the bundled runtime from an installed cache. A successful TypeScript build alone does not prove installation or service lifetime.

For Symphony changes, follow its `elixir/AGENTS.md`, update public specifications and configuration examples when behavior changes, and run focused tests followed by `make -C elixir all` with the repository-pinned mise toolchain. Stateful lifecycle changes need an independent adversarial review and real process evidence for startup, restart and failure recovery.

Keep Projects tracker reads and provider-neutral hook context in separate upstream contributions. Personal routing policy, managed lifecycle and installation belong in the downstream integration. Record each downstream patch's purpose and removal condition; adopt an upstream replacement only after verifying equivalent behavior.

A pull request should explain the user-visible problem, resulting behavior, focused validation and remaining gaps. Do not include credentials, private issue content, proprietary source or unsanitized pilot receipts. Claim completion only for the terminal behavior actually demonstrated.
