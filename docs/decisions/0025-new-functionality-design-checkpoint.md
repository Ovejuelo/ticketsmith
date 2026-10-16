# 0025. New functionality: questions, one design run and plan approval before any code

- **Status:** accepted (2026-10-16); implements ADR 0015

## Context
New functionality is larger and more ambiguous than a fix (requirements §4.15). ADR 0015 decided on a design checkpoint before code; phase 9 implements it on top of the phase-8 worktree machinery.

## Decision
- **One design run** (playbook `feature-design`, read-only tools only) answers with understanding, assumptions, blocking questions, a spec and a plan; `spec.md` and `plan.md` are written for the person.
- **Questions are asynchronous:** `out/<KEY>/feature/questions.md` with an "Answer:" per question. The person answers there, or forwards the questions to the requester, and the next `ticketsmith feature <KEY>` continues. Nothing runs while any answer is empty.
- **The plan is the checkpoint:** `feature approve` (interactive only) or `feature reject --feedback`; a rejection makes the next run revise the design with the feedback. `feature implement` refuses anything but an approved plan.
- **State with real values, masked on the way out:** `state.json` (owner-only, in `out/` like every output) keeps the design, answers and feedback as written. Everything sent back to the agent is masked at that moment with the run's own vault, so placeholders are consistent within the run and resolvable by the tools; placeholders from another run are never reused, because each vault numbers from scratch.
- **Implementation reuses phase 8:** worktrees from `branches.feature` on `featureBranchPattern` (the same branch name in every repository), file tools confined to them, `code_run_tests`, tests re-run by Ticketsmith, push only on an interactive yes. The summary reports each acceptance criterion and the new migration files found in the diff. Schema changes are migration files in the repository; DDL is never run against a database.
- **Linked pull requests:** each description names the ticket and its sibling changes (the pull request URLs already created, or the branch names).

## Consequences
No code is written for new functionality without an approved plan, and the person stays in control at the two points that matter (answers and approval). One design run per round keeps cost down; a plan change costs another round. Multi-repository deliveries are tied together by branch name and description links, not by a host-specific feature.
