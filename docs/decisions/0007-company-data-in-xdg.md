# 0007. Company data lives in XDG directories, never in the repo

- **Status:** accepted (2026-10-15)

## Context
Profiles, outputs, audit logs and knowledge contain company data.

## Decision
Config in `~/.config/ticketsmith`, data in `~/.local/share/ticketsmith/<profile>`, secrets in the keychain.

## Consequences
The repo can be shared safely; tests use anonymized fixtures.
