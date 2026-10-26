# Error auto-report → AI fix PR

A self-healing loop that stays safe for a money platform: errors report
themselves, AI drafts a fix, and a human merges. **Nothing is auto-deployed.**

## The loop

```
  panel / API error ──▶ /telemetry/error ──▶ error_reports (grouped)
                                                   │
                                   admin Error Monitor (Risk & Ops)
                                     │                        │
                           "Diagnose with AI"          "Open fix PR"
                                     │                        │
                        AI diagnosis + suggested fix   GitHub issue (label: autofix)
                                                              │
                                              claude-autofix.yml workflow
                                                              │
                                                     Claude opens a DRAFT PR
                                                              │
                                                      CI runs → you review → you merge
```

- **Capture** — `web/panel/telemetry.js` reports uncaught panel errors; the API
  reports unhandled 5xx. Grouped by signature so a recurring error is one row.
- **Triage** — Error Monitor lists groups; "Diagnose with AI" stores an AI
  diagnosis + suggested fix (needs AI configured in Integrations).
- **Escalate** — "Open fix PR" files a labelled GitHub issue; the workflow turns
  it into a **draft** PR. The issue ref is saved on the error row.

## Why not fully automatic?

On a fintech backend an unreviewed AI edit can leak funds, break auth, or cause
an outage. So the fix is always a **draft PR behind CI and your merge click** —
the same gate every change in this repo already passes.

## Setup

1. **AI** (for Diagnose): Integrations → AI, configure a model.
2. **Escalation** (for Open fix PR):
   - Environment secret `GITHUB_AUTOFIX_TOKEN` — a token with `issues:write`.
     (Secret lives in the environment only, never the database.)
   - `GITHUB_AUTOFIX_REPO` = `owner/name` (env, or site-setting
     `github_autofix_repo`). `GITHUB_AUTOFIX_LABEL` defaults to `autofix`.
3. **Workflow**: `.github/workflows/claude-autofix.yml` (included) +
   repo secret `ANTHROPIC_API_KEY`. Create the `autofix` label.

Without escalation configured, "Open fix PR" returns a clear message and changes
nothing; "Diagnose" still works on its own.
