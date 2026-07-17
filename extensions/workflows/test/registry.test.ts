import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { WorkflowResolver } from "../registry.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-registry-"));
  const agentDir = path.join(root, "agent");
  const builtins = path.join(root, "builtins");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(agentDir, "workflows"), { recursive: true });
  fs.mkdirSync(builtins, { recursive: true });
  fs.mkdirSync(path.join(project, ".pi", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "workflows", "user-one.workflow.js"), "user");
  fs.writeFileSync(path.join(builtins, "built.workflow.js"), "builtin");
  fs.writeFileSync(path.join(project, ".pi", "workflows", "project-one.js"), "project");
  return { root, agentDir, builtins, project, resolver: new WorkflowResolver(agentDir, builtins) };
}

test("registry supports only qualified stable names and trust-gates projects", () => {
  const f = fixture();
  try {
    assert.equal(f.resolver.resolveName("builtin:built", f.project, false).source, "builtin");
    assert.equal(f.resolver.resolveName("user:user-one", f.project, false).source, "user");
    assert.throws(() => f.resolver.resolveName("project:project-one", f.project, false), /require.*trust/i);
    assert.equal(f.resolver.resolveName("project:project-one", f.project, true).source, "project");
    assert.throws(() => f.resolver.resolveName("user-one", f.project, true), /qualified/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("registry rejects symlink escape and discovery uses canonical identities", () => {
  const f = fixture();
  try {
    const outside = path.join(f.root, "outside.js");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(f.agentDir, "workflows", "escape.js"));
    assert.throws(() => f.resolver.resolveName("user:escape", f.project, true), /escapes/);
    assert.deepEqual(f.resolver.discover(f.project, false).map((item) => item.qualifiedId), ["builtin:built", "user:user-one"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("relative paths resolve from the containing source directory and hash content", () => {
  const f = fixture();
  try {
    const containing = path.join(f.root, "parent");
    fs.mkdirSync(containing);
    fs.writeFileSync(path.join(containing, "child.js"), "child");
    const source = f.resolver.resolvePath("./child.js", containing);
    assert.equal(source.source, "child");
    assert.equal(source.sourceDirectory, fs.realpathSync(containing));
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
