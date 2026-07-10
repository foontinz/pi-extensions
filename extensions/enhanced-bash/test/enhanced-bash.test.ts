import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import enhancedBash from "../index";
import { BoundedBackgroundLog } from "../background-log";

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("background logs are capped without retaining stream data in memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bg-log-test-"));
  const path = join(directory, "output.log");
  try {
    const log = new BoundedBackgroundLog(path, 128);
    log.append(Buffer.from("a".repeat(512)));
    log.append(Buffer.from("b".repeat(512)));
    log.close();

    assert.equal(log.truncated, true);
    assert.equal(log.droppedBytes, 1024 - (128 - Buffer.byteLength("\n[background output truncated: log size limit reached]\n")));
    assert.ok(statSync(path).size <= 128);
    assert.match(await readFile(path, "utf8"), /background output truncated/);
    assert.ok(log.recoveryPath, "overflow creates a recoverable full-output file");
    assert.equal((await readFile(log.recoveryPath!, "utf8")).length, 1024);

    const cappedRecoveryPath = join(directory, "capped.log");
    const cappedRecovery = new BoundedBackgroundLog(cappedRecoveryPath, 128, 256);
    cappedRecovery.append(Buffer.from("z".repeat(1024)));
    cappedRecovery.close();
    assert.equal(cappedRecovery.recoveryTruncated, true);
    assert.ok(statSync(cappedRecovery.recoveryPath!).size <= 256);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("background jobs are rejected in print and JSON modes", async () => {
  for (const mode of ["print", "json"] as const) {
    let tool: any;
    const pi = {
      registerTool(value: unknown) { tool = value; },
      on() {},
      async sendMessage() {},
    } as unknown as ExtensionAPI;
    const ctx = { cwd: process.cwd(), hasUI: false, mode, isIdle: () => true } as unknown as ExtensionContext;

    enhancedBash(pi);
    await assert.rejects(
      () => tool.execute("non-ui", { command: "sleep 10", background: true }, undefined, undefined, ctx),
      /unavailable in print and JSON modes/,
    );
  }
});

test("session shutdown kills background process trees", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-enhanced-bash-tree-"));
  const childPidFile = join(cwd, "child.pid");
  let childPid: number | undefined;
  let tool: any;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    registerTool(value: unknown) { tool = value; },
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
    async sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = { cwd, hasUI: true, isIdle: () => true } as unknown as ExtensionContext;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  try {
    enhancedBash(pi);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const script = `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
    await tool.execute("bg-tree", { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, background: true }, undefined, undefined, ctx);
    await waitFor(() => existsSync(childPidFile));
    childPid = Number(readFileSync(childPidFile, "utf8"));
    assert.ok(alive(childPid));

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    await waitFor(() => !alive(childPid!));
  } finally {
    if (childPid) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("shell exit with inherited pipes finalizes after a bounded drain and shutdown kills the descendant", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-enhanced-bash-pipe-drain-"));
  const childPidFile = join(cwd, "child.pid");
  let childPid: number | undefined;
  let tool: any;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const messages: any[] = [];
  const pi = {
    registerTool(value: unknown) { tool = value; },
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
    async sendMessage(message: any) { messages.push(message); },
  } as unknown as ExtensionAPI;
  const ctx = { cwd, hasUI: true, isIdle: () => true } as unknown as ExtensionContext;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  try {
    enhancedBash(pi);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const script = `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); child.unref(); writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`;
    await tool.execute("bg-pipe-drain", { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, background: true }, undefined, undefined, ctx);
    await waitFor(() => existsSync(childPidFile));
    childPid = Number(readFileSync(childPidFile, "utf8"));
    assert.ok(alive(childPid));

    // The shell exits, but the descendant inherited stdout/stderr. Completion
    // must not wait indefinitely for ChildProcess's `close` event.
    await waitFor(() => messages.length === 1, 3_000);
    assert.match(messages[0].content, /bg bg_001 exited/);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    await waitFor(() => !alive(childPid!));
  } finally {
    if (childPid) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("foreground and background commands use the invocation cwd and background completion is custom", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-enhanced-bash-cwd-"));
  let tool: any;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const messages: Array<{ message: any; options: any }> = [];
  const pi = {
    registerTool(value: unknown) { tool = value; },
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
    async sendMessage(message: any, options: any) { messages.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => true,
  } as unknown as ExtensionContext;

  try {
    enhancedBash(pi);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

    const foreground = await tool.execute("fg", { command: "pwd", timeout: 5 }, undefined, undefined, ctx);
    assert.match(foreground.content[0].text, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const started = await tool.execute("bg", { command: "pwd", background: true }, undefined, undefined, ctx);
    const match = started.content[0].text.match(/log: (.+?)\. Do not monitor/);
    assert.ok(match, "background result includes its log path");
    const logPath = match[1];
    await waitFor(() => messages.length === 1);

    assert.match(readFileSync(logPath, "utf8"), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(messages[0].message.customType, "enhanced-bash-background");
    assert.equal(messages[0].options.triggerTurn, true);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    assert.equal(existsSync(logPath), false, "shutdown removes the closed background log directory");
  } finally {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});
