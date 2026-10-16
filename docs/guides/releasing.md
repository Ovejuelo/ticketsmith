# Releasing

Releases go to npm (the CLI and MCP server) and to the Claude Code marketplace in this repository (the plugin). The plugin and the package always share one version.

## Cutting a release

```sh
pnpm release patch --dry-run   # preview the version and the CHANGELOG entry
pnpm release patch             # or minor / major
```

`scripts/release.ts`:
1. requires a clean `main`;
2. runs `pnpm check`;
3. bumps `package.json` and `plugin/.claude-plugin/plugin.json`;
4. adds a `CHANGELOG.md` entry from the conventional commits since the last tag (`feat`, `fix`, `perf`, `docs`, and `!` for breaking changes);
5. commits `chore(release): vX.Y.Z`, tags `vX.Y.Z` and pushes.

The tag starts `.github/workflows/release.yml`. The workflow checks that the tag matches both manifests, runs the checks, builds, publishes to npm with provenance and creates the GitHub Release from the CHANGELOG entry.

Users get the release without doing anything: the plugin's MCP server runs `ticketsmith@latest`, and the CLI announces new versions.

Versioning: while in `0.x`, a roadmap phase bumps the minor version and fixes bump the patch version.

## One-time setup

1. **First publish by hand.** npm needs the package to exist before trusted publishing can be configured:
   ```sh
   npm login
   pnpm build && npm publish --access public
   ```
2. **Trusted publishing:** on npmjs.com, open the package settings, go to *Trusted publishing* and add GitHub Actions with this repository and the workflow `release.yml`. From then on the workflow publishes through OIDC, with no stored token.
3. **Fallback:** if trusted publishing is unavailable, create an npm *automation* token and store it as the repository secret `NPM_TOKEN`. The workflow already passes it.

## Private terms guard

`pnpm check` runs `scripts/guard-private-terms.ts`. It fails when a file mentions a term listed in `.private-terms`, such as a company, customer or internal id. That file is git-ignored because the list itself is private: keep your own copy at the repository root. Without it, the guard is skipped (as in CI).
