import assert from "node:assert/strict";
import test from "node:test";

import { displayStatus, isTerminalPrState, main, paneLabel, parseInvocation, recoveryHint } from "../src/cli.ts";
import { createPrState } from "../src/state.ts";

test("CLI parser canonicalizes keys and enforces command-specific syntax", () => {
  assert.deepEqual(parseInvocation(["watch", "Owner/Repo#0042"]), { command: "watch", input: "Owner/Repo#0042" });
  assert.deepEqual(parseInvocation(["watch", "https://github.com/o/r/pull/2"]), {
    command: "watch",
    input: "https://github.com/o/r/pull/2",
  });
  assert.deepEqual(parseInvocation(["watch", "2"]), { command: "watch", input: "2" });
  assert.deepEqual(parseInvocation(["status"]), { command: "status", all: false });
  assert.deepEqual(parseInvocation(["status", "--all"]), { command: "status", all: true });
  assert.deepEqual(parseInvocation(["status", "-a"]), { command: "status", all: true });
  assert.deepEqual(parseInvocation(["unwatch", "o/r#1", "--force"]), {
    command: "unwatch",
    key: "o/r#1",
    force: true,
  });
  assert.deepEqual(parseInvocation(["unwatch", "ghe.example.test/o/r#1"]), {
    command: "unwatch",
    key: "ghe.example.test/o/r#1",
    force: false,
  });
  assert.deepEqual(parseInvocation(["ack", "00000000-0000-4000-8000-000000000001"]), {
    command: "ack",
    escalationId: "00000000-0000-4000-8000-000000000001",
  });
  assert.deepEqual(parseInvocation(["run", "--pr", "o/r#2", "--once"]), {
    command: "run",
    key: "o/r#2",
    once: true,
  });
  assert.throws(() => parseInvocation(["run", "o/r#2"]), /accepts --pr/);
  assert.throws(() => parseInvocation(["status", "extra"]), /no positional/);
  assert.throws(() => parseInvocation(["ack", "not-an-id"]), /UUID/);
  assert.throws(() => parseInvocation(["unknown"]), /Unknown command/);
});

test("CLI maps usage errors to exit 2 without a stack", async () => {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await main(["watch"], { out: (line) => out.push(line), error: (line) => errors.push(line) });
  assert.equal(code, 2);
  assert.equal(out.length, 0);
  assert.match(errors.join("\n"), /requires exactly one/);
  assert.doesNotMatch(errors.join("\n"), /\n\s+at /);
});

test("help documents prerequisites, retained state, and concrete recovery actions", async () => {
  const out: string[] = [];
  assert.equal(await main(["--help"], { out: (line) => out.push(line), error: () => undefined }), 0);
  const help = out.join("\n");
  for (const expected of ["gh CLI", "provider", "GitHub.com or Enterprise", "[host/]owner/repo#N", "stale pane", "dirty unwatch", "ack <escalation-id>", "GH_HOST", "PR_BABYSIT_HOME", "merged PR"]) {
    assert.match(help, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.match(recoveryHint("config.json must set provider and model"), /provider\/model/);
  assert.match(recoveryHint("gh pr view failed: HTTP 403"), /gh auth status/);
  assert.match(
    recoveryHint("gh pr view.headRepository.nameWithOwner must be a string"),
    /unexpected data|GitHub Enterprise schema/,
  );
  assert.doesNotMatch(
    recoveryHint("gh pr view.headRepository.nameWithOwner must be a string"),
    /gh auth status/,
  );
  assert.match(recoveryHint("worktree has uncommitted changes"), /--force/);
});

test("pane labels always lead with repository, PR number, and a cropped PR name", () => {
  assert.equal(
    paneLabel({ key: "owner/repo#42", title: "Keep pane labels useful" }, "watching"),
    "repo #42 · Keep pane labels useful · watching",
  );
  assert.equal(
    paneLabel({ key: "ghe.example.test/owner/repo#7", title: "A title that is deliberately much longer than forty characters" }, "agent running"),
    "repo #7 · A title that is deliberately much longe… · agent running",
  );
  assert.equal(
    paneLabel({ key: "owner/repo#1", title: null }, "watching"),
    "repo #1 · untitled PR · watching",
  );
});

test("terminal PR states are identifiable for default status filtering and remain displayable with --all", () => {
  const state = createPrState({ key: "owner/repo#1" });
  assert.equal(displayStatus(state), "initializing");
  assert.equal(isTerminalPrState(state), false);
  state.status = "watching";
  state.cursors.prState = "MERGED";
  assert.equal(displayStatus(state), "merged");
  assert.equal(isTerminalPrState(state), true);
  state.cursors.prState = "CLOSED";
  assert.equal(displayStatus(state), "closed");
  assert.equal(isTerminalPrState(state), true);
});
