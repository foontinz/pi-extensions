import assert from "node:assert/strict";
import test from "node:test";
import { parseToolList, validateToolSelection } from "../policy/tool-selection.js";

test("default subagent tools are limited to active read-only tools in default order", () => {
  const selection = validateToolSelection(
    ["bash", "edit", "exec_code", "find", "ls", "read"],
    undefined,
  );

  assert.equal(selection.ok, true);
  assert.deepEqual(selection.tools, ["read", "find", "ls"]);
});

test("explicit subagent tools may include active higher-risk tools and preserve requested order", () => {
  const selection = validateToolSelection(
    ["bash", "edit", "exec_code", "read"],
    ["bash", "read"],
  );

  assert.equal(selection.ok, true);
  assert.deepEqual(selection.tools, ["bash", "read"]);
});

test("explicit subagent tools must be active in the parent session", () => {
  const selection = validateToolSelection(["read"], ["read", "bash"]);

  assert.equal(selection.ok, false);
  assert.match(selection.message, /not active/);
  assert.deepEqual(selection.requestedTools, ["read", "bash"]);
});

test("explicit empty subagent tools are accepted", () => {
  const selection = validateToolSelection(["read", "bash"], []);

  assert.equal(selection.ok, true);
  assert.deepEqual(selection.tools, []);
});

test("omitted tools with no active safe defaults yields no tools", () => {
  const selection = validateToolSelection(["bash", "edit"], undefined);

  assert.equal(selection.ok, true);
  assert.deepEqual(selection.tools, []);
});

test("tool lists are trimmed and deduplicated", () => {
  const parsed = parseToolList([" read ", "bash", "read"]);

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.tools, ["read", "bash"]);
});

test("comma-separated frontmatter tool lists are parsed", () => {
  const parsed = parseToolList("read, bash, read");

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.tools, ["read", "bash"]);
});

test("empty tool names are rejected", () => {
  const parsed = parseToolList("read, , bash");

  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /empty tool names/);
});

test("recursive subagent tools are denied even when active", () => {
  const selection = validateToolSelection(["read", "run_agent", "stop_agent"], ["read", "run_agent"]);

  assert.equal(selection.ok, false);
  assert.match(selection.message, /recursive subagent tools/);
  assert.deepEqual(selection.requestedTools, ["read", "run_agent"]);
});
