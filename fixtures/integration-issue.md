# Objective

Combine the accepted alpha and beta results into a reproducible manifest. Both
native blocking issues require current PM acceptance before execution; closing
or cancelling a prerequisite is insufficient.

## Revision and starting point

Requirements revision: 1. Repository: `OWNER/FIXTURE_A`.
Starting commit: `START_COMMIT`. Use the accepted prerequisite evidence supplied
by the managed runtime as the source for the manifest.

## Acceptance criteria

- Create `fixtures/integration.json` with `schema_version: 1`, a `sources` array
  containing alpha then beta, and `total: 42`.
- Each source has `repository`, `commit`, `path`, `name`, and `value`, faithfully
  copied from its accepted result. Use the full verified source commit IDs.
- Create `tests/integration.test.mjs` using Node's built-in test and assertion
  modules. Check schema version, source order, repository/path identities,
  40-character commit IDs, values 17 and 25, and the sum of 42.
- Run `node --test tests/integration.test.mjs` and report the actual result.
- Commit only the two owned files locally. Submit the full commit ID, complete
  manifest, prerequisite identities and test evidence through the result tool.
- Stop at REVIEW. The PM compares the manifest with accepted source commits and
  integrates the commit before acceptance.

## Permitted actions and ownership

Read this repository and supplied prerequisite evidence. Write only the two
named files in the assigned checkout and create a local Git commit. The PM owns
remote publication, PRs, issue closure and Project status. Do not modify the
prerequisite files, change infrastructure, or delegate. No shared resources are
claimed.
