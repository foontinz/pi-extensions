import assert from "node:assert/strict";
import test from "node:test";
import { MonitorLineFramer, type MonitorLine } from "../monitor-lines";

test("monitor line framing handles split UTF-8, CRLF, blank lines, and a final partial line", () => {
  const lines: MonitorLine[] = [];
  const framer = new MonitorLineFramer((line) => lines.push(line));
  const bytes = Buffer.from("💥\r\n\nlast", "utf8");

  framer.push(bytes.subarray(0, 2));
  framer.push(bytes.subarray(2, 5));
  framer.push(bytes.subarray(5));
  framer.end();

  assert.deepEqual(lines, [
    { text: "💥", truncated: false },
    { text: "", truncated: false },
    { text: "last", truncated: false },
  ]);
});

test("monitor line framing bounds an unterminated line and resumes after newline", () => {
  const lines: MonitorLine[] = [];
  const framer = new MonitorLineFramer((line) => lines.push(line), 4);

  framer.push(Buffer.from("abcdef"));
  framer.push(Buffer.from("gh\nok\n"));
  framer.end();

  assert.deepEqual(lines, [
    { text: "abcd… [line truncated]", truncated: true },
    { text: "ok", truncated: false },
  ]);
});
