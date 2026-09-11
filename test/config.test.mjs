import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { validateConfig } from "../dist/config.js";

test("configuration diagnostics distinguish unavailable storage from malformed JSON without leaking error content", async (t) => {
  const stub = t.mock.method(fs, "readFile");
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
  for (const code of ["EIO", "EACCES", "EROFS"]) {
    stub.mock.mockImplementation(async () => { throw Object.assign(new Error("private config contents"), { code }); });
    const diagnostic = await validateConfig();
    assert.equal(diagnostic.valid, false);
    assert.match(diagnostic.error, new RegExp(`^config_unreadable:.*\\(${code}\\)`));
    assert.doesNotMatch(diagnostic.error, /private config contents/);
  }
  stub.mock.mockImplementation(async () => "{private malformed contents");
  assert.equal((await validateConfig()).error, "config_invalid: Configuration must contain valid JSON");
  stub.mock.mockImplementation(async () => { throw Object.assign(new Error("private contents"), { code: "ENOENT" }); });
  assert.match((await validateConfig()).error, /^config_missing:/);
});
