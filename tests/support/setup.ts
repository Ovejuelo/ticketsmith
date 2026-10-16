/**
 * Runs before every test file. Tests that commit (worktrees, `ticketsmith code`) need a git
 * identity; CI machines have none, and the developer's own must not end up in test repositories.
 */
process.env['GIT_AUTHOR_NAME'] = 'Ticketsmith Test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@example.com'
process.env['GIT_COMMITTER_NAME'] = 'Ticketsmith Test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@example.com'
