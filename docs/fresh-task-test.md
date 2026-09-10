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

Prompt guidance: [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)
and [Astra instruction-following guidance for the PM](https://developers.openai.com/api/docs/guides/latest-model#instruction-following).
Use clear roles, separate assignment instructions from reference data, and avoid
conflicting or repeated rules. These are prompting practices, not measured
claims about Luna's performance.
