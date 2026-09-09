# Building a release

The plugin and managed Symphony runtime are separate source repositories. Pin
both revisions in a release receipt. Preserve the upstream Symphony `LICENSE`
and `NOTICE`, and distribute the runtime dependency notices beside the executable.

## Plugin bundle

Use the committed lockfile and an existing Node installation:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Commit the generated `mcp/server.mjs` and `mcp/cli.mjs` with their source. The
marketplace installs those bundles; end users do not need TypeScript, esbuild,
Elixir, or Erlang. Validate a tracked-files-only installation in a fresh Codex
home, including a path containing spaces and an actual MCP call. After
publication, repeat installation from the pinned public Git source.

## Linux Symphony executable

Build from the managed integration revision named by the release, using its
locked Hex dependencies. The initial executable targets Ubuntu 24.04-compatible
Linux x86_64, including Ubuntu WSL2. Other upstream Burrito targets have not been
validated for this managed distribution.

The reviewed build uses Erlang/OTP 28.5, Elixir 1.19.5, Burrito 1.5.0 and Zig
0.15.2. The custom ERTS input is distributed with the release:

- Input: `symphony-erts-28.5-noble-glibc.tar.gz`
- SHA256: `9d4195221fa24670ae4a187d4a6d1eec5f369ed0f4e09f370a74e63e1c5d0627`

Verify the input digest, then run the existing guarded build script from the
Symphony repository:

```sh
cd elixir
mise install
mise install zig@0.15.2
mise exec -- mix deps.get
mise exec -- make all
export SYMPHONY_CUSTOM_ERTS=/absolute/path/to/symphony-erts-28.5-noble-glibc.tar.gz
export SYMPHONY_CUSTOM_ERTS_SHA256=9d4195221fa24670ae4a187d4a6d1eec5f369ed0f4e09f370a74e63e1c5d0627
./scripts/build-linux-x86_64-custom-erts.sh
```

The output is `elixir/burrito_out/symphony_linux_x86_64`. The executable embeds
its BEAM runtime and application dependencies. It still uses ordinary Ubuntu
host libraries, including glibc and OpenSSL; it is not a fully static binary.
Codex, GitHub CLI, Node, Git and systemd remain host prerequisites.

The published input, source revisions, lockfiles and commands make the build
repeatable. They do not establish byte-for-byte reproducibility of Burrito's
result. Record the resulting executable digest, size, runtime dependency closure
and host library requirements for each release, and launch it with development
tools absent from `PATH` before distribution.

## Publication and maintenance

Publish only after the installed disposable workflow, recovery checks and one
bounded real delivery have passed. Include the complete source, plugin bundles,
Linux executable, exact ERTS input, build receipt and relevant third-party
notices. Keep private source, issue bodies, credentials, local configuration and
unsanitized validation logs out of these artifacts.

Keep the read-only Projects adapter and provider-neutral hook-context changes
as independent upstream PRs. Use the downstream patch register to track the
managed extensions and their removal conditions. Pin upgrades, preserve a
working prior executable, and verify compatible journal and configuration
behavior before switching. A rollback does not undo Git changes or provider
writes.
