import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pruneOldRuns } from "../../core/run-archive.js";

function ageOf(target: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(target, t, t);
}

test("pruneOldRuns removes entries older than maxAge and keeps fresh ones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-archive-"));
  try {
    const oldDir = path.join(root, "old-run");
    const freshDir = path.join(root, "fresh-run");
    fs.mkdirSync(oldDir);
    fs.mkdirSync(freshDir);
    fs.writeFileSync(path.join(oldDir, "t.jsonl"), "x");
    fs.writeFileSync(path.join(freshDir, "t.jsonl"), "x");
    const oldFile = path.join(root, "old.log");
    fs.writeFileSync(oldFile, "x");

    // Age the old entries (dir + contents + loose file) beyond the cutoff.
    ageOf(path.join(oldDir, "t.jsonl"), 5 * 24 * 60 * 60 * 1000);
    ageOf(oldDir, 5 * 24 * 60 * 60 * 1000);
    ageOf(oldFile, 5 * 24 * 60 * 60 * 1000);

    const pruned = pruneOldRuns(root, 3 * 24 * 60 * 60 * 1000);

    assert.equal(pruned, 2);
    assert.ok(!fs.existsSync(oldDir), "old dir removed");
    assert.ok(!fs.existsSync(oldFile), "old file removed");
    assert.ok(fs.existsSync(freshDir), "fresh dir kept");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOldRuns judges a dir by its own mtime (not its children)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-archive-"));
  try {
    // A fresh run dir that happens to contain an old file must be KEPT
    // (the dir's own mtime is what matters, matching real run dirs).
    const freshDir = path.join(root, "fresh");
    fs.mkdirSync(freshDir);
    fs.writeFileSync(path.join(freshDir, "old.jsonl"), "x");
    ageOf(path.join(freshDir, "old.jsonl"), 10 * 24 * 60 * 60 * 1000);
    // freshDir keeps ~now mtime.

    const pruned = pruneOldRuns(root, 3 * 24 * 60 * 60 * 1000);

    assert.equal(pruned, 0);
    assert.ok(fs.existsSync(freshDir), "fresh dir kept regardless of old children");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOldRuns does not follow symlinks (no cycle walk)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-archive-"));
  try {
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    const link = path.join(root, "link");
    fs.symlinkSync(target, link);
    ageOf(link, 10 * 24 * 60 * 60 * 1000); // lutimes-ish via ageOf on the link path
    // Even if aged, removing the symlink must not touch the target dir contents.
    fs.writeFileSync(path.join(target, "keep.txt"), "x");

    assert.doesNotThrow(() => pruneOldRuns(root, 3 * 24 * 60 * 60 * 1000));
    assert.ok(fs.existsSync(path.join(target, "keep.txt")), "symlink target contents preserved");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOldRuns is a no-op for a missing directory", () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "run-archive-")), "nope");
  assert.ok(!fs.existsSync(missing));
  assert.equal(pruneOldRuns(missing), 0);
});
