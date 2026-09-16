# Temporary Codex Browser precautions

Until the installed Codex build is verified to fix `openai/codex#36645`, do not assign in-app Browser work to delegated user-visible tasks or internal subagents. Keep essential in-app Browser work in the root task; use appropriate CLI, external-browser, or device evidence for delegated verification.

Before root in-app Browser work:

- Use only the root task's own binding and one task-created tab.
- Discard stale handles without generic cleanup.
- Do not call `tabs.finalize({keep:[]})` or close the task's last tab.
- Use APIs supported by the current tool documentation; these precautions do not authorize an unavailable API.

The historical failure involved automatic session-end teardown targeting a provisional `client-new-thread:*` route. It occurred despite task-local tab ownership, no explicit close/finalize call, no further Browser delegation, and other tabs remaining. Ownership precautions are therefore not proof that the crash is prevented.

This is a temporary host workaround, not a model limitation. Do not retire it merely because the model or app version changed; first verify the fix applies to the installed build. Keep the global restriction and this reference consistent when retiring it.
