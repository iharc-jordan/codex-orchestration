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
  assert.deepEqual(fixture.workflow_managed, {
    enabled: true,
    store_path: "$SYMPHONY_STATE_ROOT\\managed.sqlite3",
    control_token_file: "$SYMPHONY_CONTROL_TOKEN_FILE",
    event_limit: 100,
    event_wait_ms: 5000
  });
  assert.doesNotMatch(JSON.stringify(fixture.workflow_managed), /journal|managed\.log/i);
  assert.deepEqual(http.state.response, {
    revision: 0,
    cursor: 0,
    paused: false,
    disabled: false,
    projects: {},
    assignments: {}
  });
  assert.deepEqual(http.events.response, { after: 0, events: [], cursor: 0 });
  assert.deepEqual(Object.keys(http.state_views), ["summary", "detail", "full"]);
  assert.equal(http.state_views.summary.path, "/api/v1/managed/state?view=summary&project_id=PVT_one");
  assert.equal(http.state_views.detail.path, "/api/v1/managed/state?view=detail&project_id=PVT_one&assignment_id=item-one&include_history=true");
  assert.equal(http.state_views.full.path, "/api/v1/managed/state?view=full&include_history=true");
  assert.equal(http.state_views.summary.response.usage.cached_input_tokens, 120);
  assert.equal(http.state_views.summary.response.usage.telemetry_complete, true);
  assert.equal(http.state_views.summary.response.usage.runtime_complete, true);
  assert.equal(http.state_views.summary.response.usage.accounting_status, "known");
  const summaryAssignment = http.state_views.summary.response.assignments["item-one"];
  assert.deepEqual(summaryAssignment.last_report, {
    report_id: "report-fixture-1",
    attempt_id: "managed-item-one-attempt-1",
    updated_at: "2026-09-16T16:00:00Z",
    truncated: true
  });
  assert.equal(summaryAssignment.worker.activity, "running verification");
  assert.equal(summaryAssignment.route.escalation_reason, "Fixture requires connected-runtime review");
  assert.equal(summaryAssignment.usage.cached_input_tokens, 120);
  assert.equal(summaryAssignment.usage.telemetry_complete, true);
  assert.equal(summaryAssignment.usage.runtime_complete, true);
  assert.equal(summaryAssignment.usage.accounting_status, "known");
  assert.equal(summaryAssignment.ownership.ownership_revision, 1);
  assert.equal(http.state_views.detail.response.assignment.reports["report-fixture-1"].kind, "result");
  assert.equal(http.state_views.detail.response.project.project_id, "PVT_one");
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
  assert.deepEqual(http.review_peer_refs.body.args.peer_report_refs, [{
    source_assignment_id: "item-one",
    source_attempt_id: "managed-item-one-attempt-1",
    report_id: "report-fixture-1"
  }]);
  assert.equal(http.review_peer_refs.body.args.disposition, "rework");
  assert.doesNotMatch(JSON.stringify(fixture), /iharc-jordan|\/run\/symphony-managed|\/var\/lib\/symphony-managed/);
});

