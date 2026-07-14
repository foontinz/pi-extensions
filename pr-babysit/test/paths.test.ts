import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appPaths,
  decodePrKeyDirName,
  encodePrKey,
  ensureAppDirs,
  ensurePrDirs,
  parsePrKey,
  prPaths,
  resolveAppHome,
} from "../src/paths.ts";

test("PR keys are validated and canonicalized", () => {
  assert.deepEqual(parsePrKey("Foo/Bar_Baz#0042"), {
    host: "github.com",
    owner: "foo",
    repo: "bar_baz",
    number: 42,
    key: "foo/bar_baz#42",
  });
  assert.deepEqual(parsePrKey("GHE.Example.test/Owner/Repo#7"), {
    host: "ghe.example.test",
    owner: "owner",
    repo: "repo",
    number: 7,
    key: "ghe.example.test/owner/repo#7",
  });
  for (const invalid of ["42", "https://github.com/o/r/pull/1", "../r#1", "o/../r#1", "o/r#0", "o/r#x", "o/r#1/2", "https:@evil/o/r#1"]) {
    assert.throws(() => parsePrKey(invalid), /Invalid/);
  }
});

test("filesystem encoding is reversible and a single safe basename", () => {
  const key = "owner/repo.with-things#123";
  const encoded = encodePrKey(key);
  assert.match(encoded, /^pr-v1-[A-Za-z\d_-]+$/);
  assert.equal(decodePrKeyDirName(encoded), key);
  assert.equal(encoded.includes("/"), false);
  assert.notEqual(encodePrKey("owner/repo-with-things#123"), encoded);
  const enterprise = "ghe.example.test/owner/repo.with-things#123";
  assert.equal(decodePrKeyDirName(encodePrKey(enterprise)), enterprise);
  assert.notEqual(encodePrKey(enterprise), encoded);
  assert.throws(() => decodePrKeyDirName(`${encoded}=`), /Invalid/);
});

test("home override is evaluated per call and directory creation excludes worktree leaf", async () => {
  const first = await mkdtemp(join(tmpdir(), "pr-babysit-paths-a-"));
  const second = await mkdtemp(join(tmpdir(), "pr-babysit-paths-b-"));
  assert.equal(resolveAppHome({ PR_BABYSIT_HOME: first }), first);
  assert.equal(resolveAppHome({ PR_BABYSIT_HOME: second }), second);
  assert.throws(() => resolveAppHome({ PR_BABYSIT_HOME: " " }), /must not be empty/);

  const app = appPaths(first);
  const pr = prPaths("owner/repo#1", app);
  await ensureAppDirs(app);
  await ensurePrDirs(pr);
  assert.equal((await stat(pr.prDir)).isDirectory(), true);
  await assert.rejects(stat(pr.worktreePath), { code: "ENOENT" });
});
