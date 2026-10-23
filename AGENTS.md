# PaperPath repository guidance

## Project status

PaperPath is a fictional community-volunteer application simulator. It is not connected to Alexa+ and does not submit applications to a real organization. Keep the interface and README clear about this. The project remains in development until all release gates in `docs/contracts.md` and the project plan have current evidence.

## Current execution override (October 16, 2026)

Luna is the primary coding route: low for orchestration/CLI/checks/checkpoints, high for bounded implementation, xhigh for complex integration/concurrency/persistence/recovery. Edit directly in an owned isolated worktree. Do not run OpenCode model admission/races, proposal-only JSON, custom coding harnesses, or per-task Sol pre-review; older root-plan instructions are superseded. Implement, run meaningful affected checks, repair findings, and present integrated diff plus receipts for independent Sol review at a coherent milestone. No routine root approval loop. Preserve $0, containment, security, branch, CI, and release gates below.

At each checkpoint lead with the end-to-end milestone completed (or explicitly not completed), tested source SHA, observed checks/evidence, and remaining mandatory end-to-end/release gates. Keep component progress separate from release readiness; never present a percentage as readiness.

## Local development and data

- Use Node.js 24.6.0 (`.node-version`). Run `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` as appropriate for each change.
- Keep local credentials, case data, databases, exports, logs, build output, and evidence under ignored paths such as `.local/`; never commit them. Do not hardcode or print provider credentials.
- The browser communicates with the locally running PaperPath server. Submitted analysis text is sent to the configured provider. Keep privacy copy accurate and avoid claims about provider retention that have not been verified.

## Branches, pull requests, and checks

- Work on a task branch named `codex/<short-task>`. Use a dedicated worktree for concurrent or isolated Codex work when useful; preserve existing user changes.
- Do not push feature work directly to `main`. Open a pull request and wait for the real GitHub Actions `checks` run to pass before integration. A workflow file, local YAML parse, or local test run is not evidence that GitHub CI passed.
- Review the actual changed paths and commits before pushing. Use the explicit source allowlist; never stage the entire worktree.
- Keep the standard Ubuntu runner and bounded job timeout. Do not add paid services, larger runners, secrets, deployment, or publishing steps.
- Branch protections may vary by repository plan. Verify the settings and required check names; when GitHub cannot enforce them, the Codex operator must apply the same merge gate manually and record the limitation.
- Obtain an independent review for release-critical changes. A local reviewer receipt is separate from GitHub's check-run status.

## Local learning log

- Maintain `.local/learnings.md` and `.local/learnings-map.md`; both must remain ignored and never enter commits or PRs.
- Update them after every completed project stage and at handoff. Record the actual date, source commit, changed paths, implementation model/writer when known, task/prompt or artifact hashes when available, commands and observed results, evidence paths, and unresolved gates. Distinguish source inspection from executed checks and avoid claims not supported by receipts.
- Use the installed `learn-viz` workflow: add a Mermaid diagram to each learning entry that explains a concept, keep an up-to-date timeline and a compact overview map, and verify Mermaid syntax/rendering before recording it as validated.

## Release and deployment

- Keep release checks tied to the exact integrated revision: tests, typecheck, lint, build, browser/PDF behavior, recovery/security, clean install, and independent review.
- Do not add continuous deployment until an eligible $0 hosting target and its release gates are proven. A green CI run alone does not mean the app is deployed or ready for submission.
