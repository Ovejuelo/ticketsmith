/** Built-in playbook for classifying a ticket. Override with knowledge/playbooks/classify.md. */
export const CLASSIFY_PLAYBOOK = `# Playbook: classify a ticket

Decide which of the project's ticket types fits the ticket best. You only read: the ticket (jira_get_issue) and the project knowledge (knowledge_search, knowledge_read), especially resolved cases in knowledge/cases/ that look similar.

## Rules
- Choose exactly one of the type names you are given, or "other" when none fits.
- Judge by what the requester needs, not by the issue type alone: an issue typed "Service request" may really ask for new functionality, a bug fix or a report.
- Confidence is your honest probability (0 to 1) that a person would agree. Below 0.75 a person decides, so do not inflate it.
- The reason is one or two sentences that cite the ticket.
- Be quick: one ticket read and, if useful, one search for similar cases.
`
