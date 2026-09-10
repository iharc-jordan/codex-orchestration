import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = JSON.parse(await readFile(new URL("../contracts/managed-contract-fixtures.json", import.meta.url), "utf8"));
const operations = ["bind_project", "register_pm", "claim", "enroll", "revise", "pause", "resume", "interrupt", "cancel", "review", "handoff"];

function assertAssignmentFence(args, scoped = true) {
  if (scoped) assert.equal(args.scope, "assignments");
  assert.equal(typeof args.project_id, "string");
  assert.ok(Array.isArray(args.assignments));
  assert.ok(args.assignments.length > 0);
  for (const fence of args.assignments) {
    assert.equal(typeof fence.assignment_id, "string");
    assert.equal(typeof fence.expected_revision, "number");
    assert.equal(typeof fence.expected_ownership_revision, "number");
  }
}

test("managed contract fixture covers the typed bridge envelope without private examples", () => {
  const http = fixture.http;
  assert.deepEqual(http.state.response, {
    revision: 0,
    cursor: 0,
    paused: false,
    disabled: false,
    projects: {},
    assignments: {}
  });
  assert.deepEqual(http.events.response, { after: 0, events: [], cursor: 0 });
  for (const operation of operations) {
    const example = http[operation];
    assert.equal(example.method, "POST");
    assert.equal(example.path, "/api/v1/managed/control");
    assert.equal(example.body.operation, operation);
    assert.equal(typeof example.body.request_id, "string");
    assert.equal(example.response.operation, operation);

    const args = example.body.args;
    if (operation === "register_pm") {
      assert.equal(typeof args.display_name, "string");
    } else if (operation === "pause" || operation === "resume") {
      assertAssignmentFence(args);
    } else if (operation === "handoff") {
      assertAssignmentFence(args, false);
    } else {
      assert.equal(typeof args.expected_revision, "number");
    }
  }
  assert.equal(typeof http.bind_project.body.args.project.project_id, "string");
  assert.equal(typeof http.enroll.body.args.project_id, "string");
  assert.equal(typeof http.enroll.body.args.route.model, "string");
  assert.equal(http.enroll.body.args.resources[0].kind, "repository");
  assert.equal(typeof http.review.body.args.disposition, "string");
  assert.doesNotMatch(JSON.stringify(fixture), /iharc-jordan|\/run\/symphony-managed|\/var\/lib\/symphony-managed/);
});

