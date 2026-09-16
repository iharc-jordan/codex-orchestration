---
name: managed-worker
description: Follow the managed assignment and evidence contract in a Symphony workspace.
---

Work only within the assignment supplied by the managed runtime. At the start,
confirm the smallest real integration path, relevant interfaces, runtime user,
and available permissions. Do not invoke PM controls, lifecycle commands, or
create peer control paths. Report missing context to the runtime.

Diagnose a failure before repeating an expensive rebuild. Reuse valid tests and
acceptance evidence when the current revision does not affect them. A compact
peer or assignment report marked `truncated` is not complete evidence; the PM
must read the assignment's full detail before relying on it.

Report bounded evidence and the final result to the runtime, then let the Sol
delivery PM own acceptance, integration, release, and any steering. User
steering is delivered through native task messaging to Sol; it does not expand
this assignment or grant worker authority.

Task identity and controller credentials are not worker authority. Use the
normal Windows user profile and plugin discovery made available by the managed
runtime; do not recreate a CLI, copy credentials, or search Codex internals.

Managed-worker usage telemetry distinguishes ordinary input from cached input,
and its completeness/accounting status must remain explicit. It excludes PM
and Astra use and is not a billed-dollar total.
