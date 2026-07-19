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

function createHarness(
  cwd: string,
  options: { hasUI?: boolean; mode?: "tui" | "rpc" | "print" | "json"; idle?: boolean } = {},
) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  const notifications: string[] = [];
  let idle = options.idle ?? true;
  const pi = {
    registerTool(value: any) { tools.set(value.name, value); },
    registerCommand(name: string, value: any) { commands.set(name, value); },
    on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
    sendMessage(message: any, sendOptions: any) { messages.push({ message, options: sendOptions }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    isIdle: () => idle,
    ui: { notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionContext;
  enhancedBash(pi);
  return { tools, handlers, commands, messages, notifications, ctx, setIdle(value: boolean) { idle = value; } };
}

async function startHarness(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, harness.ctx);
}

async function shutdownHarness(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, harness.ctx);
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
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

test("background jobs and monitors are rejected in print and JSON modes", async () => {
  for (const mode of ["print", "json"] as const) {
    const harness = createHarness(process.cwd(), { hasUI: false, mode });
    await assert.rejects(
      () => harness.tools.get("bash").execute("non-ui", { command: "sleep 10", background: true }, undefined, undefined, harness.ctx),
      /unavailable in print and JSON modes/,
    );
    await assert.rejects(
      () => harness.tools.get("monitor").execute("non-ui", { command: "echo ready", description: "ready" }, undefined, undefined, harness.ctx),
      /unavailable in print and JSON modes/,
    );
  }
});

test("a stale background start cannot delete a task from the replacement session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-enhanced-bash-generation-"));
  const harness = createHarness(cwd);

  try {
    await startHarness(harness);
    const bash = harness.tools.get("bash");
    const staleStart = bash.execute(
      "stale",
      { command: "sleep 20", background: true },
      undefined,
      undefined,
      harness.ctx,
    ).catch((error: Error) => error);

    await harness.handlers.get("session_start")?.({ type: "session_start", reason: "new" }, harness.ctx);
    const current = await bash.execute(
      "current",
      { command: "sleep 20", background: true },
      undefined,
      undefined,
      harness.ctx,
    );
    const staleResult = await staleStart;
    assert.ok(staleResult instanceof Error);

    await harness.commands.get("background-tasks").handler("", harness.ctx);
    assert.match(harness.notifications.at(-1) ?? "", new RegExp(current.details.taskId));
    await harness.tools.get("stop_background_task").execute(
      "stop-current",
      { task_id: current.details.taskId },
      undefined,
      undefined,
      harness.ctx,
    );
  } finally {
    await shutdownHarness(harness);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session shutdown kills background process trees", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-enhanced-bash-tree-"));
  const childPidFile = join(cwd, "child.pid");
  const harness = createHarness(cwd);
  let childPid: number | undefined;

  try {
    await startHarness(harness);
    const script = `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
    await harness.tools.get("bash").execute("bg-tree", { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, background: true }, undefined, undefined, harness.ctx);
    await waitFor(() => existsSync(childPidFile));
    childPid = Number(readFileSync(childPidFile, "utf8"));
    assert.ok(alive(childPid));

    await shutdownHarness(harness);
    await waitFor(() => !alive(childPid!));
  } finally {
    if (childPid) try { process.kill(childPid, "SIGKILL"); } catch {}
    await shutdownHarness(harness);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stop_background_task kills a descendant that created its own process group", { skip: process.platform === "win32" }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-enhanced-bash-detached-child-"));
  const childPidFile = join(cwd, "detached-child.pid");
  const harness = createHarness(cwd);
  let childPid: number | undefined;

  try {
    await startHarness(harness);
    const childScript = "setInterval(() => {}, 1000)";
    const parentScript = `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { detached: true, stdio: "ignore" }); child.unref(); writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
    const started = await harness.tools.get("monitor").execute(
      "detached-tree",
      {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`,
        description: "detached tree",
        persistent: true,
      },
      undefined,
      undefined,
      harness.ctx,
    );
    await waitFor(() => existsSync(childPidFile));
    childPid = Number(readFileSync(childPidFile, "utf8"));
    assert.ok(alive(childPid));

    await harness.tools.get("stop_background_task").execute(
      "stop-detached-tree",
      { task_id: started.details.taskId },
      undefined,
      undefined,
      harness.ctx,
    );
    await waitFor(() => !alive(childPid!), 3_000);
  } finally {
    if (childPid) try { process.kill(childPid, "SIGKILL"); } catch {}
    await shutdownHarness(harness);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("shell exit with inherited pipes kills the residual process group before completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-enhanced-bash-pipe-drain-"));
  const childPidFile = join(cwd, "child.pid");
  const harness = createHarness(cwd);
  let childPid: number | undefined;

  try {
    await startHarness(harness);
    const script = `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); child.unref(); writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`;
    await harness.tools.get("bash").execute("bg-pipe-drain", { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, background: true }, undefined, undefined, harness.ctx);
    await waitFor(() => existsSync(childPidFile));
    childPid = Number(readFileSync(childPidFile, "utf8"));

    await waitFor(() => harness.messages.length === 1, 3_000);
    assert.match(harness.messages[0].message.content, /bg bg_001 exited/);
    await waitFor(() => !alive(childPid!), 3_000);
  } finally {
    if (childPid) try { process.kill(childPid, "SIGKILL"); } catch {}
    await shutdownHarness(harness);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("foreground and user bash commands receive the rm guard and explicit bypasses fail closed", { skip: process.platform === "win32" }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-enhanced-bash-rm-guard-"));
  const harness = createHarness(cwd);
  let guardDir: string | undefined;

  try {
    await startHarness(harness);
    const bash = harness.tools.get("bash");
    const foreground = await bash.execute("guard-path", { command: "command -v rm" }, undefined, undefined, harness.ctx);
    const match = foreground.content[0].text.match(/(\/[^\s]*pi-rm-guard-[^\s/]+)\/rm/);
    const detectedGuardDir = match?.[1];
    assert.ok(detectedGuardDir, `guarded rm was not first in PATH: ${foreground.content[0].text}`);
    guardDir = detectedGuardDir;
    assert.equal(existsSync(detectedGuardDir), true);

    await assert.rejects(
      () => bash.execute("bypass", { command: "/bin/rm -rf ./build" }, undefined, undefined, harness.ctx),
      /explicit \/bin\/rm.*bypasses/,
    );

    const userBash = await harness.handlers.get("user_bash")?.(
      { type: "user_bash", command: "command -v rm", cwd, excludeFromContext: false },
      harness.ctx,
    ) as any;
    let output = "";
    const userResult = await userBash.operations.exec("command -v rm", cwd, {
      onData(data: Buffer) { output += data.toString("utf8"); },
    });
    assert.equal(userResult.exitCode, 0);
    assert.match(output, /pi-rm-guard-[^\s/]+\/rm/);
  } finally {
    await shutdownHarness(harness);
    if (guardDir) assert.equal(existsSync(guardDir), false, "shutdown removes the private rm guard");
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("foreground and background commands use invocation cwd and completion wakes an idle agent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-enhanced-bash-cwd-"));
  const harness = createHarness(cwd);

  try {
    await startHarness(harness);
    const bash = harness.tools.get("bash");
    const foreground = await bash.execute("fg", { command: "pwd", timeout: 5 }, undefined, undefined, harness.ctx);
    assert.match(foreground.content[0].text, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const started = await bash.execute("bg", { command: "pwd; command -v rm", background: true }, undefined, undefined, harness.ctx);
    const logPath = started.details.logFile;
    await waitFor(() => harness.messages.length === 1);

    assert.match(readFileSync(logPath, "utf8"), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(readFileSync(logPath, "utf8"), /pi-rm-guard-[^\s/]+\/rm/);
    assert.equal(harness.messages[0].message.customType, "enhanced-bash-background");
    assert.equal(harness.messages[0].options.triggerTurn, true);
    assert.equal(harness.messages[0].options.deliverAs, "followUp");

    await shutdownHarness(harness);
    assert.equal(existsSync(logPath), false, "shutdown removes the closed background log directory");
  } finally {
    await shutdownHarness(harness);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("monitor delivers stdout events, keeps stderr in the log, and combines process completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-monitor-events-"));
  const harness = createHarness(cwd);

  try {
    await startHarness(harness);
    const result = await harness.tools.get("monitor").execute(
      "monitor",
      { command: "printf 'one\\n'; printf 'diagnostic\\n' >&2; printf 'last'", description: "test stream" },
      undefined,
      undefined,
      harness.ctx,
    );
    await waitFor(() => harness.messages.length === 1);

    const notification = harness.messages[0];
    assert.match(notification.message.content, /\[1\] one/);
    assert.match(notification.message.content, /\[2\] last/);
    assert.doesNotMatch(notification.message.content, /diagnostic/);
    assert.match(notification.message.content, /monitor mon_001 exited/);
    assert.equal(notification.options.deliverAs, "followUp");
    assert.equal(notification.message.details.monitorEvents[0].lines.length, 2);
    assert.equal(notification.message.details.jobs[0].status, "exited");
    assert.match(readFileSync(result.details.logFile, "utf8"), /diagnostic/);
  } finally {
    await shutdownHarness(harness);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("monitor bounds event floods and reports suppressed lines", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-monitor-flood-"));
  const harness = createHarness(cwd);

  try {
    await startHarness(harness);
    const script = `for (let i = 0; i < 100; i++) console.log("event-" + i);`;
    await harness.tools.get("monitor").execute(
      "monitor-flood",
      { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, description: "flood" },
      undefined,
      undefined,
      harness.ctx,
    );
    await waitFor(() => harness.messages.length === 1);

    const details = harness.messages[0].message.details.monitorEvents[0];
    assert.equal(details.lines.length, 64);
    assert.equal(details.droppedLines, 36);
    assert.match(harness.messages[0].message.content, /36 additional line\(s\).*suppressed/);
  } finally {
    await shutdownHarness(harness);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("monitor holds later events until the previous wake has settled", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-monitor-coalesce-"));
  const harness = createHarness(cwd);

  try {
    await startHarness(harness);
    const script = `console.log("first"); setTimeout(() => console.log("second"), 450); setInterval(() => {}, 1000);`;
    const started = await harness.tools.get("monitor").execute(
      "monitor-coalesce",
      { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, description: "two events", persistent: true },
      undefined,
      undefined,
      harness.ctx,
    );
    await waitFor(() => harness.messages.length === 1);
    assert.match(harness.messages[0].message.content, /first/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(harness.messages.length, 1, "second wake remains coalesced while the first is in flight");

    await harness.handlers.get("agent_settled")?.({ type: "agent_settled" }, harness.ctx);
    await waitFor(() => harness.messages.length === 2);
    assert.match(harness.messages[1].message.content, /second/);

    await harness.tools.get("stop_background_task").execute(
      "stop",
      { task_id: started.details.taskId },
      undefined,
      undefined,
      harness.ctx,
    );
  } finally {
    await shutdownHarness(harness);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("monitor timeout kills the task and wakes a busy agent with steer delivery", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-monitor-timeout-"));
  const harness = createHarness(cwd, { idle: false });

  try {
    await startHarness(harness);
    await harness.tools.get("monitor").execute(
      "monitor-timeout",
      {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
        description: "timeout test",
        timeout_ms: 1_000,
      },
      undefined,
      undefined,
      harness.ctx,
    );
    await waitFor(() => harness.messages.length === 1, 3_000);

    assert.match(harness.messages[0].message.content, /monitor mon_001 timed_out/);
    assert.equal(harness.messages[0].options.deliverAs, "steer");
    assert.equal(harness.messages[0].options.triggerTurn, true);
  } finally {
    await shutdownHarness(harness);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("foreground idle sleeps are rejected in favor of monitor", async () => {
  const harness = createHarness(process.cwd());
  await assert.rejects(
    () => harness.tools.get("bash").execute("sleep", { command: "sleep 1" }, undefined, undefined, harness.ctx),
    /Use monitor.*Do not retry with shorter sleeps/,
  );
});
