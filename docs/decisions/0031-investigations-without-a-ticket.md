# 0031. Investigations without a ticket: a read-only agent run from a question

- **Status:** accepted (2026-10-20)

## Context
Every agent command (`process`, `code`, `feature`) starts from a ticket key and requires a ticket source. Teams also want to review a feature, a flow or the data before anyone reports a problem. Until now that only worked through the MCP in an interactive Claude Code session, with no saved result, budget or run record.

## Decision
- A separate feature, `features/investigate/`, with the command `investigate "<question>"`. It reuses the agent run of `process` (`runStructured`, the per-run tool server, `revealDeep`) but not its code: a feature never imports another feature, and what they share already lives in `core/agent`, `core/output` and `core/security`.
- It needs at least one of a ticket source, databases or repositories, and no ticket source in particular.
- **Read-only by tool filter:** the tool server gets `only: !code_* && !db_propose_change`, the same rule as the feature design run and evals. The tools the agent cannot use do not exist in its session.
- **The question is masked with the run's vault** (`AgentToolServer.mask`) before it goes into the prompt. A person may type an email or an account id; the agent sees the same placeholder the tools use, and the audit records the masked question. The folder slug is derived from the masked question too.
- A new answer schema, `InvestigationSchema`, instead of reusing `TicketAnalysis`: there is no ticket type, JIRA comment or single probable cause, but a list of findings, each with severity, confidence and evidence (`EvidenceSchema`). A built-in `investigate` playbook, overridable per project like the others.
- Output in `out/investigations/<date>-<slug>/` (`question.md`, `analysis.md`, `run.json`), apart from ticket folders; a repeated question on the same day gets `-2`, `-3`…

## Consequences
Projects without a ticket source get an agent command for the first time. The agent still cannot run the code, so findings come from reading code and data; the playbook says so and forbids claiming runtime checks. Saving an investigation as a knowledge case is left out: cases are keyed by ticket.
