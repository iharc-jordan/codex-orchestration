# Requirements

Only explicit later user direction supersedes these decisions.

## Persistent decisions
- Scope: Ordinary Codex tasks and managed orchestration assignments on supported hosts.
- Source: User, 2026-09-17, task 01a0ac49-3b93-79f0-b4bd-ccce6a45ccb1: "Implement this plan", referring to the approved project-file persistence plan.
- Decision: Preserve explicit lasting user decisions in a dedicated canonical REQUIREMENTS.md and load them automatically across task boundaries. Do not rely on native memory or assignment issue text as the only source of required behavior. Only explicit later user direction can reverse a decision.

## One plugin repository
- Scope: Codex orchestration plugin development and acceptance fixtures.
- Source: User, 2026-09-17, task 01a0ac49-3b93-79f0-b4bd-ccce6a45ccb1: "remove those and ensure only one orchestration plugin repo remains."
- Decision: Keep one orchestration plugin repository. Do not recreate extra orchestration fixture repositories unless the user explicitly changes this direction; use disposable local fixtures.
