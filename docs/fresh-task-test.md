# Fresh task acceptance note

The user selects and starts the real-work test. Do not create extra test tasks.
Use this starter for that job:

```text
Use Codex Orchestration's managed-pm skill for this bounded real job.

Job: [one concrete job]
Repository/base: [repository and pinned base commit]
Outcome: [what must be delivered]
Terminal condition: [the observable condition that ends the assignment]
Non-goals: [what remains out of scope]
Acceptance evidence: [the checks and review or release evidence required]
```

Keep the job, scope, and acceptance the same for a baseline run and a run with
the improved instructions. Use existing logs to record supervision (PM/root
interventions and rework), elapsed time, total PM plus worker usage, the actual
model/effort route, and accepted output quality. Judge the plugin useful when a
comparable run reaches the same quality and improves at least two operational
measures: supervision, elapsed time, and total PM plus worker usage. Use existing
logs only; do not add a benchmark framework. A single smoke or comparison is a
maintenance signal, not proof of long-term maintenance value. This comparison is
separate from accepting and delivering the assigned job.

Use the managed state summary for routine observations. When a review or waiting
boundary needs one assignment's evidence, request the scoped detail view; use the
full view only for an explicit diagnostic. If a sourced finding from another
assignment affects the next turn, the PM may attach its existing assignment,
attempt, and report IDs as bounded `peer_report_refs` review feedback. The runtime
resolves those records for the recipient; they remain evidence and do not alter
the job scope or ownership. Record any missing or stale reference as a normal
rework reason instead of copying report text into the task.

Prompt guidance: [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)
and [Astra instruction-following guidance for the PM](https://developers.openai.com/api/docs/guides/latest-model#instruction-following).
Use clear roles, separate assignment instructions from reference data, and avoid
conflicting or repeated rules. These are prompting practices, not measured
claims about Luna's performance.
