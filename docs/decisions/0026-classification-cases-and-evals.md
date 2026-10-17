# 0026. Classification, resolved cases and evals

- **Status:** accepted (2026-10-16)

## Context
Each ticket needs the right path (a playbook, a code fix or new functionality). Issue types alone are not enough: on the first project, "Service request" holds data changes and new functionality alike. Changing playbooks or models also needs a way to tell whether results got better or worse (requirements §4.3, §4.12, §4.13).

## Decision
- **Types live in `knowledge/ticket-types.md`** (YAML front matter): name, description, `route` (process, code or feature), playbook and signals (issue types, labels, components, keywords). Onboarding drafts it from the source's issue types and never overwrites it.
- **Rules first, then a short LLM run, then a person.** Rules are free and deterministic. Under the threshold, a read-only run with `jira_get_issue` and `knowledge_*` decides on a small budget; when it is unsure too, a person chooses in the terminal, and scripts stop with what to run. `process` follows the route but never starts code changes by itself.
- **Cases are masked knowledge** (`knowledge/cases/<KEY>.md`), built from `out/<KEY>/` plus the person's note. They are offered at the end of runs in a terminal and the agent finds them with `knowledge_search`.
- **Evals are masked snapshots** (`evals/<KEY>.yaml`, shareable), served to the tools in place of the ticket source. `eval` measures classification; `eval --full` adds the playbook run and an LLM judge within a budget. A regression against the previous run fails the command.

## Consequences
Most tickets are classified for free; the LLM and the person are asked only when it matters, and each human decision is recorded. The project can now measure before raising autonomy, as requirements §4.13 demands. Snapshots do not capture database state, so `--full` scores on data-dependent tickets drift with the data.
