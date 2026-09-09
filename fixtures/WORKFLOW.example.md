---
tracker:
  kind: github_projects
  provider:
    owner_type: user
    owner: OWNER
    project_number: 1
    status_field_name: Status
    token: $GITHUB_TOKEN
  active_states: [READY, ACTIVE, REVIEW, WAITING]
  terminal_states: [ACCEPTED, CANCELLED]
polling:
  interval_ms: 5000
workspace:
  root: /home/example/.local/state/codex-orchestration/workspaces
agent:
  max_concurrent_agents: 2
  max_turns: 20
codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
managed:
  enabled: true
  journal_path: /home/example/.local/state/codex-orchestration/journal/managed.log
  control_token_file: /home/example/.config/codex-orchestration/token
  checkout_node: /usr/bin/node
  checkout_helper_path: /opt/codex-orchestration/mcp/cli.mjs
  checkout_policy_file: /home/example/.config/codex-orchestration/checkout-policy.json
---

Complete only this enrolled assignment in its provided checkout. The issue
description owns the requirements and permitted actions. Preserve existing work
across continuation and recovery. Do not delegate or invoke PM controls.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}
Current status: {{ issue.state }}

{{ issue.description }}

Report the actual result and evidence through orchestration_report. Report
context_needed when required facts are missing. Stop at review; the PM owns
acceptance and authorization for any external release action.
