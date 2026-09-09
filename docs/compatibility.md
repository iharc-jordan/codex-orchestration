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
| Symphony source | `5459015` / runtime `0.1.5` | Current version-only candidate, based on the green source gate at `e8b3a9d`; a new runtime gate is pending after the revision-recovery repair |
| Installed Symphony binary | `0.1.4` from `0a53a0a` | Disposable workflow and interruption/recovery evidence passed; the installed service is stopped pending the current runtime repair |
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

The installed disposable run passed four-assignment enrollment, dispatch, review,
acceptance, dependency unlocking, and clean stop. A forced owned-service stop
also recovered the same App Server thread with a new turn, one checkpoint, one
completion, and exact-once filesystem and commit effects. A later fresh PM pilot
exposed a revision-recovery defect after caller-fingerprint handling, involving
retry bookkeeping and obsolete automatic effect intents. The pilot is paused
while the runtime is repaired. The 0.1.4 service remains stopped; do not
infer current-release validation from the earlier disposable pass.

The hidden Windows launcher keeps an enabled WSL service session available. It must not change global WSL idle settings, Windows power settings or unrelated startup tasks. Native Ubuntu uses the user service manager directly.

Native Windows workers, distributed scheduling, automatic migration of desktop workers, Project State synchronization and ordinary sidebar visibility for managed workers are outside the initial release.

## Release acceptance

The combined source gate at `e8b3a9d` passed 420 tests with zero failures, six
skips, and 100% configured coverage. The 0.1.4 build smoke and installed
disposable workflow passed, but the 0.1.5 version-only candidate needs a new
green runtime gate after the revision-recovery repair. Fresh PM pilot work is
paused pending that repair and has not been accepted. Public publication has
not been performed. Track accepted evidence in release notes; do not infer
release readiness from this compatibility table alone.
