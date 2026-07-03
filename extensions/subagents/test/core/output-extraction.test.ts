import assert from "node:assert/strict";
import test from "node:test";
import { detectAssistantFailure, extractLastAssistantText } from "../../core/in-process-runner.js";

const userMsg = { role: "user", content: [{ type: "text", text: "do it" }] };
const toolResult = { role: "toolResult", content: [{ type: "text", text: "ok" }] };

test("returns the terminal assistant's text when present", () => {
  const messages = [
    userMsg,
    { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "preamble" }, { type: "toolCall", name: "edit" }] },
    toolResult,
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done. Changed a=1 to a=2." }] },
  ];
  assert.equal(extractLastAssistantText(messages), "Done. Changed a=1 to a=2.");
});

test("falls back to earlier assistant text when the last assistant is tool-calls-only", () => {
  // Reproduces the reported empty-output case: the run ends on a tool call.
  const messages = [
    userMsg,
    { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "I'll make the edit and verify." }, { type: "toolCall", name: "edit" }] },
    toolResult,
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }] },
  ];
  assert.equal(extractLastAssistantText(messages), "I'll make the edit and verify.");
});

test("ignores thinking-only blocks and returns empty when no assistant text exists", () => {
  const messages = [
    userMsg,
    { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", name: "bash" }] },
    toolResult,
  ];
  assert.equal(extractLastAssistantText(messages), "");
});

test("detectAssistantFailure surfaces a terminal error stopReason", () => {
  const messages = [
    userMsg,
    { role: "assistant", stopReason: "error", content: [], errorMessage: "boom" },
  ];
  assert.deepEqual(detectAssistantFailure(messages), { reason: "error", message: "boom" });
});

test("detectAssistantFailure maps aborted to stop", () => {
  const messages = [{ role: "assistant", stopReason: "aborted", content: [] }];
  assert.deepEqual(detectAssistantFailure(messages), { reason: "stop", message: "assistant was aborted" });
});

test("detectAssistantFailure flags a length-truncated stop", () => {
  const messages = [userMsg, { role: "assistant", stopReason: "length", content: [{ type: "text", text: "partial" }] }];
  assert.deepEqual(detectAssistantFailure(messages), { reason: "error", message: "assistant response was truncated (token limit)" });
});

test("detectAssistantFailure falls back to a default when errorMessage is empty", () => {
  const messages = [{ role: "assistant", stopReason: "error", content: [], errorMessage: "" }];
  assert.deepEqual(detectAssistantFailure(messages), { reason: "error", message: "assistant returned an error" });
});

test("string content is extracted as text", () => {
  const messages = [userMsg, { role: "assistant", stopReason: "stop", content: "plain string answer" }];
  assert.equal(extractLastAssistantText(messages), "plain string answer");
});

test("detectAssistantFailure returns undefined for a normal stop", () => {
  const messages = [
    userMsg,
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
  ];
  assert.equal(detectAssistantFailure(messages), undefined);
});

test("detectAssistantFailure only considers the most recent assistant message", () => {
  const messages = [
    { role: "assistant", stopReason: "error", content: [], errorMessage: "earlier failure" },
    toolResult,
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] },
  ];
  assert.equal(detectAssistantFailure(messages), undefined);
});
