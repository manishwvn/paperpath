# Amazon Developer Hackathon working rules

## Scope and objective

Optimize for a convincing, eligible cash-prize entry: Alexa+ first, Bee second. External spending stays $0. Preserve Rebuttal and unrelated projects. Until the user starts the implementation session, work is research, workflow, and planning documents only; do not scaffold applications, activate schedules, or publish.

The user authorizes autonomous task decomposition, appropriate subagents, routine engineering decisions, testing, and repair. Do not require them to remind you to delegate or to review code. This does not authorize paid services, new Codex MCP server registrations or third-party connector connections, unknown personal declarations, or deletion of pre-existing files. The planned application's local MCP server/client is authorized implementation work in the next session. Follow the global installation and destructive-command policies. Never create a custom skill.

## Discover, inspect, reuse, prove

Read Appendix A of `IMPLEMENTATION_PLAN.md` before making architecture choices. Existing stack and product details in `IMPLEMENTATION_PLAN.md` are hypotheses. Do not scaffold from them until the missing capability proofs pass. Preserve confirmed event constraints; change an implementation choice when evidence warrants it. Read only the saved sections needed for the current step; do not reload the entire plan/research on every wake or helper task.

For the first substantive design/build or a newly required capability:

1. Name the user outcome, difficult capability, acceptance evidence, and constraints. Check existing code, dependencies, installed skills, and callable native tools first.
2. Read the installed `find-skills` skill. Follow global discovery rules: skills.sh, 2–3 focused `npx skills@1.7.2 find` queries, and native plugin search. Search official MCP Registry metadata when a server would fill an actual gap; there is no exposed native registry-search tool in the audited session. Use GitHub to inspect implementations and extend a weak shortlist. Do not treat web search results as a complete comparison.
3. Inspect 2–3 concrete competing approaches, including a native/standard-library option where relevant. Read the actual source or example, license, dependency requirements, hooks/scripts, account costs, and relevant maintenance/compatibility evidence. Fetch current library documentation through Context7 where available. Popularity is a discovery signal, not proof of quality.
4. Record the inspected URLs/files, reusable parts, adaptation needed, rejection reasons, and unknowns in the capability review. Installing nothing is valid when existing capabilities suffice. Do not install a workflow merely to tick a discovery box or overwrite project guidance with third-party instructions.
5. In the implementation session, run a bounded capability probe using the selected existing example/component before full scaffolding. Record exact versions, command, observed result, and evidence path. Source inspection is not execution. For PaperPath, prove real MCP negotiation/tool calls and two PDF outputs with a shared corrected value and readable rendering. For Bee, prove actual Watch/Bee data access before building its product.
6. Choose the smallest verified combination and update the plan. State which code must be custom and why existing components do not provide it. Keep uncertain parts provisional. Do not force a generic starter or add a hosted platform by habit.

Reuse dated receipts rather than repeating completed exploration. Reopen only the affected comparison when a probe fails, a requirement changes, a dependency conflicts, or a needed capability is missing. Mid-session transition from discussion to implementation must pass this gate too. Tiny edits, pure questions, and helpers whose parent already researched do not restart discovery.

## Small tasks and delegation

Before substantive work, identify dependencies and independent tasks. Use up to three helpers when parallel work will resolve separate questions or shorten the critical path. Use fewer for sequential/tiny tasks. Never maintain idle fleets or duplicate the same exploration in parent and child.

- GPT-6.1 Sol: architecture, integration, difficult diagnosis, and independent review. Use medium effort normally; increase for demonstrated difficulty.
- GPT-6 Luna: bounded searches, evidence collection, mechanical edits, and focused execution, at xhigh or max only.
- OpenCode/Muse: most bounded implementation after the existing zero-cost and inherited-execution admission gate passes. Use observed quality and repair rate to decide workload; model parity and free access are not assumed.

Current user execution requirement: OpenCode through its actual CLI is mandatory for implementation. Resolve native-client issues before considering a fallback. Only if OpenCode proves unusable may implementation fall back to GPT-6 Luna at xhigh/max. Keep independent audit and review on GPT-6.1 Sol. Minimize Sol orchestration tokens; do not use Sol as an application implementation fallback. Preserve the zero-cost, containment and free-model admission requirements.

Give each helper a small task, minimal context, exact ownership, acceptance criteria, and a stop condition. Use fresh bounded context for explicit model overrides. Tell writers they are not alone and must preserve others' work. Give workers exclusive files or worktrees; root owns shared integration. Do not use a fixed-effort custom role that conflicts with the model policy. Reuse an existing helper for a related follow-up.

Worker receipts contain only changed/inspected paths, decisions or findings, check results, evidence, and blockers. Trust bounded exploration receipts unless contradictory evidence appears. Keep an independent Sol review for release-critical changes; do not spawn multiple reviewers for every small edit.

## Usage, verification, and finishing

Check native five-hour/weekly usage around meaningful work waves, not every command. Account limits are shared across chats. Preserve release capacity, checkpoint before a limit, and obey real reset times. Use existing process sessions and a concise task ledger first; create controller code only for a demonstrated missing capability. Native heartbeat activation belongs to the implementation session.

Build one working journey before expanding. Define checks from failure risks and event judging criteria; do not set arbitrary test-count targets. Run the project's defined test/typecheck/lint commands, inspect actual UI/PDF results, and bind release evidence to the final integrated revision. Rerun affected checks after changes; do not repeatedly rerun unchanged passing suites.

After two failed repair rounds, diagnose, change the approach, or cut an optional feature. Do not repeat an unchanged strategy, weaken checks, or invent successful execution. Record resumable state and the next bounded task at handoffs. Pass these applicable rules explicitly to future separate application repositories, since their Git roots may stop instruction discovery at their own roots.

No routine approval questions. If an unavailable login/device action or unknown required declaration blocks one step, state the exact blocker and continue independent authorized work. Never delete a file that predated the session without explicit user authorization. Session-created disposable artifacts may be cleaned under the global policy; preserve useful evidence.

These are working instructions, not a filesystem sandbox or a guarantee of model compliance. Report observed behavior and remaining limitations accurately.
