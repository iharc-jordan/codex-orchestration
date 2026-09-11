# Compatibility

The local MVP targets Windows with Ubuntu WSL2 and native Ubuntu Linux. Workers
and the Symphony service execute in Linux. Windows hosts the Codex PM and the
stdio bridge launcher.

The current local iteration pairs plugin `v0.2.0` with Symphony runtime binary
`0.2.0-mvp.3`. Build the runtime from the current managed-state version 2 source and keep the
plugin, executable, and state format on that matching pair. There is no public
marketplace entry or release artifact, and this document makes no production,
PM pilot, or model-performance claim.

## Verified development baseline

| Component | Observed version | Evidence boundary |
| --- | --- | --- |
| Ubuntu | 24.04.4 LTS | Existing WSL execution host |
| WSL | 2.7.3, kernel 6.6.114.1 | Existing Windows host |
| Codex CLI | 0.154.0 | Windows and Linux; existing account authentication |
| GitHub CLI | 2.100.0 | Linux Projects and repository reads |
| Node.js | 24.15.0 Windows; 24.13.1 Linux | Bridge development and focused tests |
| Symphony source | Current managed-state version 2 source checkout | Required source for the matching local runtime build; no public release receipt |
| Installed Symphony binary | `0.2.0-mvp.3` | Required local iteration executable; installation and delivery evidence remain to be collected |
| Current local plugin | `0.2.0` | Managed MVP bridge; no public artifact, production verification, PM pilot, or model-performance result |
| Elixir / OTP | Repository-pinned mise toolchain | Build and full upstream checks |

Package metadata declares Node.js 20 or later. That declaration is not a claim that every intervening Node version has been tested. Release receipts must identify the exact plugin, Symphony integration and executable versions tested together.

The Linux x86_64 MVP executable must embed its OTP/ERTS runtime, so users do
not need Elixir or Erlang development tools. Its custom ERTS targets Ubuntu
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

Validate the installation and lifecycle with local checks. Exercise worker
delivery and recovery during a user-selected real job with the matching
`0.2.0-mvp.3` executable and managed-state version 2. Do not launch synthetic
model tasks to test this candidate. Local checks alone do not establish
delivery quality or model performance.

The hidden Windows launcher keeps an enabled WSL service session available. It must not change global WSL idle settings, Windows power settings or unrelated startup tasks. Native Ubuntu uses the user service manager directly.

Native Windows workers, distributed scheduling, automatic migration of desktop workers, Project State synchronization and ordinary sidebar visibility for managed workers are outside this MVP.

The local MVP adds typed resource references, explicit Project and
assignment ownership fences, PM registration and claim, and fenced handoff.
The runtime resolves provider identity and issue-body fingerprints; these
controls do not require the PM to calculate a manual hash. A healthy
worker may continue through handoff while PM responsibility changes. These
behaviors require the matching current managed-state version 2 runtime and remain subject to
the validation boundaries below.

## MVP validation status

No public artifact, production deployment, PM pilot, or model-performance test
result is claimed. Before a real job, validate the matching plugin and
`0.2.0-mvp.3` executable from current managed-state version 2 source, then retain the
installation, lifecycle, recovery, and delivery evidence with the local run.
