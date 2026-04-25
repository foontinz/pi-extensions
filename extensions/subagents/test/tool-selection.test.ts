import assert from "node:assert/strict";
import test from "node:test";
import { __subagentsTest } from "../index.js";

test("default subagent tools are limited to active read-only tools", () => {
  const selection = __subagentsTest.validateToolSelection(
    ["bash", "edit", "exec_code", "find", "ls", "read"],
    undefined,
  );

  assert.equal(selection.ok, true);
  assert.deepEqual(selection.tools, ["find", "ls", "read"]);
});

test("explicit subagent tools may include active higher-risk tools", () => {
  const selection = __subagentsTest.validateToolSelection(
    ["bash", "edit", "exec_code", "read"],
    ["bash", "read"],
  );

  assert.equal(selection.ok, true);
  assert.deepEqual(selection.tools, ["bash", "read"]);
});

test("explicit subagent tools must be active in the parent session", () => {
  const selection = __subagentsTest.validateToolSelection(["read"], ["read", "bash"]);

  assert.equal(selection.ok, false);
  assert.match(selection.message, /not active/);
  assert.deepEqual(selection.requestedTools, ["bash", "read"]);
});
