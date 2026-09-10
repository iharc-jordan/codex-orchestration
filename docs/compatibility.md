# Compatibility

The initial supported targets are Windows with Ubuntu WSL2 and native Ubuntu Linux. Workers and the Symphony service execute in Linux. Windows hosts the Codex PM and the stdio bridge launcher.

The verified release pairing documented here is plugin `v0.1.0` with Symphony
runtime `v0.1.6`. The current checkout reports plugin `v0.2.0`, but that is an
unreleased managed-control candidate. Its local contract and focused tests do
not establish a public release, production deployment, or PM pilot.

## Verified development baseline

| Component | Observed version | Evidence boundary |
| --- | --- | --- |
| Ubuntu | 24.04.4 LTS | Existing WSL execution host |
| WSL | 2.7.3, kernel 6.6.114.1 | Existing Windows host |
| Codex CLI | 0.153.4 | Windows and Linux; existing account authentication |
| GitHub CLI | 2.100.0 | Linux Projects and repository reads |
| Node.js | 24.15.0 Windows; 24.13.1 Linux | Bridge development and focused tests |
| Symphony source | `011c7233aa64307f63ac808c4e2802c8bebda819` / runtime `0.1.6` | Release source; qualified full gate passed 425 tests with zero failures, six skips, 100% configured coverage, format, specs, Credo, and Dialyzer |
| Installed Symphony binary | `0.1.6` from `011c7233aa64307f63ac808c4e2802c8bebda819` | Upgrade/start verification passed with HTTP 200 and preserved MCP state; bounded PM pilot accepted |
| Current local plugin candidate | `0.2.0` | Managed v2 contract and focused tests only; no public artifact, production verification, or real PM pilot |
| Elixir / OTP | Repository-pinned mise toolchain | Build and full upstream checks |

Package metadata declares Node.js 20 or later. That declaration is not a claim that every intervening Node version has been tested. Release receipts must identify the exact plugin, Symphony integration and executable versions tested together.

The Linux x86_64 release embeds the reviewed OTP/ERTS runtime, so users
do not need Elixir or Erlang development tools. Its custom ERTS targets Ubuntu
24.04-compatible systems and dynamically uses host libraries, including
`libcrypto.so.3`, `libtinfo.so.6`, `libz.so.1`, `libstdc++.so.6`, and glibc with
`GLIBC_2.38`. It is not a static universal Linux binary. Systemd user services,
Git, Node and the existing authenticated Codex CLI are required at runtime.
The tested host is Ubuntu under WSL2; a separate bare-metal installation has not
yet been verified. macOS, ARM64 and native Windows worker binaries are not part
of this release.

## Execution and recovery boundaries

A healthy service can continue authorized work after the PM or MCP client disconnects. Pending results wait for PM review. This does not promise that an idle desktop task can be woken by MCP.

Windows sleep, shutdown and explicit WSL termination interrupt execution. Recovery must reconcile the journal, filesystem, provider effects and owned processes before starting a new recovery turn. Systemd restart alone is not proof that work can be safely reassigned.

The installed disposable run passed four-assignment enrollment, dispatch, review,
acceptance, dependency unlocking, and clean stop. A forced owned-service stop
also recovered the same App Server thread with a new turn, one checkpoint, one
completion, and exact-once filesystem and commit effects. The qualified 0.1.6
source gate additionally covers controls-first revision recovery, current-intent
reread, retry/block reset with a nonzero lifetime allowance, and ordered obsolete
automatic-intent retirement after provider and local commit. The 0.1.6
installation/start verification passed with HTTP 200 and preserved MCP state.
The bounded PM pilot was accepted on 0.1.6; the prior 0.1.4 disposable evidence remains
the recorded four-assignment and interruption/recovery proof.

The hidden Windows launcher keeps an enabled WSL service session available. It must not change global WSL idle settings, Windows power settings or unrelated startup tasks. Native Ubuntu uses the user service manager directly.

Native Windows workers, distributed scheduling, automatic migration of desktop workers, Project State synchronization and ordinary sidebar visibility for managed workers are outside the initial release.

The local v2 candidate adds typed resource references, explicit Project and
assignment ownership fences, PM registration and claim, and fenced handoff.
The runtime resolves provider identity and issue-body fingerprints; these
candidate controls do not require the PM to calculate a manual hash. A healthy
worker may continue through handoff while PM responsibility changes. These
behaviors are covered by local contract and runtime tests, not by the
published v1 release evidence above.

## Release acceptance

The qualified 0.1.6 source gate passed 425 tests with zero failures, six skips,
100% configured coverage, format, specs, Credo, and Dialyzer. The 0.1.6 binary
is built and its installation/start verification passed with HTTP 200 and
preserved MCP state. The bounded PM pilot was accepted after source integration,
CI, and live deployment verification. The versioned release notes record clean
public Git installation and publication evidence. Usage telemetry can arrive
after a result: the pilot managed snapshot was 55,740 tokens below the final
worker session count. Allow for in-flight and late-reported usage; raw token
counts that include cached input do not establish billed cost.

No `v0.2.0` release or pilot receipt exists yet. Keep candidate validation
separate from these v1 acceptance claims until the real PM pilot and release
checks are complete.
