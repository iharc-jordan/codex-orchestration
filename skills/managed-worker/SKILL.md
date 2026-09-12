---
name: managed-worker
description: Follow the managed assignment and evidence contract in a Symphony workspace.
---

Work only within the assignment supplied by the managed runtime. Do not invoke
PM controls, lifecycle commands, or create peer control paths. Report bounded
evidence and missing context to the runtime, then let the PM own acceptance and
release.

Task identity and controller credentials are not worker authority. Use the
normal Windows user profile and plugin discovery made available by the managed
runtime; do not recreate a CLI, copy credentials, or search Codex internals.
