# Disposable managed workflow

Use two empty repositories that you own. Replace `OWNER/FIXTURE_A`,
`OWNER/FIXTURE_B`, and `START_COMMIT` in the issue templates with the exact
repositories and verified starting commits. Keep these fixtures separate from
production work. They require Git and Node's built-in test runner; no package
installation is needed.

Create an alpha issue in repository A, a beta issue in repository B, and an
integration issue in repository A. Add both alpha and beta as native blocking
issues of integration. Add all three to the configured Project as READY. Also
add the negative-control issue, but never enroll that issue.

Explicitly enroll the three implementation issues through the installed plugin.
Alpha and beta may run concurrently. Verify integration stays undispatched when
either prerequisite is merely REVIEW, WAITING, or CANCELLED. Verify each result
against its actual commit and tests, integrate it using the PM's authorized Git
workflow, then accept it. Both current prerequisites must be ACCEPTED before
integration starts. Its result must identify the accepted source commits.

Throughout the run, the negative control must have no attempt, worker session,
or writable assignment checkout. Record exact plugin and Symphony revisions,
assignment revisions, attempt/thread IDs, Project transitions and test results.
Never publish credentials, private issue bodies, or raw worker logs as receipts.

These templates cover the dependency workflow. The separate lifecycle cases in
[the validation matrix](../docs/validation.md) are also required before release.
