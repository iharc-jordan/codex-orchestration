# Compatibility

The initial supported targets are Windows with Ubuntu WSL2 and native Ubuntu Linux. Workers and the Symphony service execute in Linux. Windows hosts the Codex PM and the stdio bridge launcher.

## Verified development baseline

| Component | Observed version | Evidence boundary |
| --- | --- | --- |
| Ubuntu | 24.04.4 LTS | Existing WSL execution host |
| WSL | 2.7.3, kernel 6.6.114.1 | Existing Windows host |
| Codex CLI | 0.153.4 | Windows and Linux; existing account authentication |
| GitHub CLI | 2.100.0 | Linux Projects and repository reads |
| Node.js | 24.15.0 Windows; 24.13.1 Linux | Bridge development and focused tests |
| Symphony upstream | 8001b52e3062495a16e520e4ceaf8f9de868c4d0 | Pinned source baseline, before managed extensions |
| Elixir / OTP | Repository-pinned mise toolchain | Build and full upstream checks |

Package metadata declares Node.js 20 or later. That declaration is not a claim that every intervening Node version has been tested. Release receipts must identify the exact plugin, Symphony integration and executable versions tested together.

The Linux x86_64 release candidate embeds the reviewed OTP/ERTS runtime, so users
do not need Elixir or Erlang development tools. Its custom ERTS targets Ubuntu
24.04-compatible systems and dynamically uses host libraries, including
`libcrypto.so.3`, `libtinfo.so.6`, `libz.so.1`, `libstdc++.so.6`, and glibc with
`GLIBC_2.38`. It is not a static universal Linux binary. Systemd user services,
Git, Node and the existing authenticated Codex CLI are required at runtime.
The tested host is Ubuntu under WSL2; a separate bare-metal installation has not
yet been verified. macOS, ARM64 and native Windows worker binaries are not part
of this candidate.

## Execution and recovery boundaries

A healthy service can continue authorized work after the PM or MCP client disconnects. Pending results wait for PM review. This does not promise that an idle desktop task can be woken by MCP.

Windows sleep, shutdown and explicit WSL termination interrupt execution. Recovery must reconcile the journal, filesystem, provider effects and owned processes before starting a new recovery turn. Systemd restart alone is not proof that work can be safely reassigned.

The hidden Windows launcher keeps an enabled WSL service session available. It must not change global WSL idle settings, Windows power settings or unrelated startup tasks. Native Ubuntu uses the user service manager directly.

Native Windows workers, distributed scheduling, automatic migration of desktop workers, Project State synchronization and ordinary sidebar visibility for managed workers are outside the initial release.

## Release acceptance

The current development baseline is not an installed-service certification. A release requires the installed disposable workflow, process interruption/recovery checks, and the documented bounded pilot. Track accepted evidence in the release notes; do not infer it from this compatibility table.
