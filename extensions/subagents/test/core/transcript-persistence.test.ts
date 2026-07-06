import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// The transcript-advertisement guard in in-process-runner.ts / index.ts relies on
// SessionManager only creating the JSONL file once an assistant message arrives.
// Pin that behavior so a future SDK change that breaks the assumption is caught.

test("SessionManager.create does not write the transcript file until an assistant message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-"));
  try {
    const sm = SessionManager.create("/tmp", dir, { id: "job-abc" });
    const file = sm.getSessionFile()!;
    // Path is known immediately, but nothing is on disk yet (an errored/aborted
    // run that never produced output must NOT advertise this path).
    assert.ok(file, "session file path is resolved eagerly");
    assert.equal(fs.existsSync(file), false, "no file before any assistant output");

    // A user message alone still does not flush the file.
    sm.appendMessage({ role: "user", content: "hi" } as never);
    assert.equal(fs.existsSync(file), false, "still no file after only a user message");

    // The first assistant message flushes the full transcript to disk.
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }] } as never);
    assert.equal(fs.existsSync(file), true, "file exists once the agent produced output");
    assert.match(fs.readFileSync(file, "utf8"), /"role":"assistant"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
