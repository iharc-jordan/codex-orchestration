import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = JSON.parse(await readFile(new URL("../contracts/managed-contract-fixtures.json", import.meta.url), "utf8"));
const operations = ["bind_project", "enroll", "revise", "pause", "resume", "interrupt", "cancel", "review"];

test("managed contract fixture covers the typed bridge envelope without private examples", () => {
  const http = fixture.http;
  assert.deepEqual(http.state.response, {
    revision: 0,
    cursor: 0,
    paused: false,
    disabled: false,
    binding: null,
    assignments: {}
  });
  assert.deepEqual(http.events.response, { after: 0, events: [], cursor: 0 });
  for (const operation of operations) {
    const example = http[operation];
    assert.equal(example.method, "POST");
    assert.equal(example.path, "/api/v1/managed/control");
    assert.equal(example.body.operation, operation);
    assert.equal(typeof example.body.request_id, "string");
    assert.equal(typeof example.body.args.expected_revision, "number");
    assert.equal(example.response.operation, operation);
  }
  assert.equal(typeof http.bind_project.body.args.project.project_id, "string");
  assert.equal(typeof http.enroll.body.args.route.model, "string");
  assert.equal(typeof http.review.body.args.disposition, "string");
  assert.doesNotMatch(JSON.stringify(fixture), /iharc-jordan|\/run\/symphony-managed|\/var\/lib\/symphony-managed/);
});

