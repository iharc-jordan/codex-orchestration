# Objective

Create a small alpha artifact. Execute only after explicit PM enrollment.

## Revision and starting point

Requirements revision: 1. Repository: `OWNER/FIXTURE_A`.
Starting commit: `START_COMMIT`.

## Acceptance criteria

- Create `fixtures/alpha.json` containing `{"name":"alpha","value":17}`.
- Create `tests/alpha.test.mjs` using Node's built-in test and assertion modules
  to read the artifact and assert its exact object.
- Run `node --test tests/alpha.test.mjs` and report the actual result.
- Commit the two owned files locally. Submit the full commit ID, repository,
  changed paths, complete artifact and test evidence using the result tool.
- Stop at REVIEW. The PM verifies and integrates the commit before acceptance.

## Permitted actions and ownership

Read this repository and write only the two named files in the assigned checkout.
Create a local Git commit. The PM owns remote publication, PRs, issue closure and
Project status. Do not change infrastructure or delegate. No shared resources
are claimed.
