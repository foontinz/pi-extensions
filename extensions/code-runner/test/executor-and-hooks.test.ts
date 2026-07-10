import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeCode } from "../executor";
import { BoundedOutputPreview, RecoverableOutput } from "../output";
import { cleanupStaleCodeHandleRegistries, getRegisteredHandles, registerCodeHandle, unregisterCodeHandle } from "../hooks";

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("bounded previews retain both ends and recoverable output persists the full stream", () => {
  const preview = new BoundedOutputPreview(20, 4);
  preview.append(Buffer.from("first\nsecond\nthird\nfourth\nfifth\n", "utf8"));
  const text = preview.toString();
  assert.match(text, /first/);
  assert.match(text, /fifth/);
  assert.match(text, /output truncated/);

  const recovery = new RecoverableOutput("pi-code-runner-test", 8, 100);
  recovery.append("stdout", Buffer.from("alpha"));
  recovery.append("stderr", Buffer.from("beta"));
  const path = recovery.finish();
  assert.ok(path, "output exceeding the budget gets a recovery file");
  try {
    const full = readFileSync(path!, "utf8");
    assert.match(full, /\[stdout\]\nalpha/);
    assert.match(full, /\[stderr\]\nbeta/);
  } finally {
    rmSync(dirname(path!), { recursive: true, force: true });
  }
});

test("recoverable output enforces a hard disk safety limit", () => {
  const recovery = new RecoverableOutput("pi-code-runner-limit-test", 4, 100, 10);
  assert.equal(recovery.append("stdout", Buffer.from("0123456789abcdef")), false);
  const path = recovery.finish();
  assert.ok(path);
  try {
    const full = readFileSync(path!, "utf8");
    assert.match(full, /0123456789/);
    assert.match(full, /safety limit/);
    assert.doesNotMatch(full, /abcdef/);
  } finally {
    rmSync(dirname(path!), { recursive: true, force: true });
  }
});

test("stale PID registries are removed without clearing the active registry", () => {
  const stalePath = join(dirname(fileURLToPath(import.meta.url)), "..", ".handle-registry.999999999.json");
  writeFileSync(stalePath, "[]", "utf8");
  cleanupStaleCodeHandleRegistries();
  assert.equal(existsSync(stalePath), false);
});

test("handles can be unregistered without clearing registrations from other extensions", () => {
  const name = `code_runner_test_${process.pid}`;
  unregisterCodeHandle(name);
  registerCodeHandle({ name, setupCode: "", docs: "test handle" });
  assert.ok(getRegisteredHandles().some((handle) => handle.name === name));
  assert.equal(unregisterCodeHandle(name), true);
  assert.ok(!getRegisteredHandles().some((handle) => handle.name === name));
  assert.equal(unregisterCodeHandle(name), false);
});

test("exec_code bounds visible output and retains a full recovery file", async () => {
  const result = await executeCode(
    'console.log("BEGIN"); console.log("x".repeat(60 * 1024)); console.log("END");',
    [],
    { typecheck: false, timeout: 10_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /BEGIN/);
  assert.match(result.output, /END/);
  assert.ok(result.fullOutputPath, "large output should be recoverable");
  try {
    const full = readFileSync(result.fullOutputPath!, "utf8");
    assert.match(full, /BEGIN/);
    assert.match(full, /END/);
    assert.ok(full.length > 60 * 1024);
  } finally {
    rmSync(dirname(result.fullOutputPath!), { recursive: true, force: true });
  }
});

test("aborting exec_code kills descendants in its detached process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-code-runner-tree-test-"));
  const childPidFile = join(directory, "child.pid");
  let childPid: number | undefined;
  const controller = new AbortController();
  const code = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`;

  try {
    const execution = executeCode(code, [], {
      typecheck: false,
      timeout: 20_000,
      signal: controller.signal,
    });
    await waitFor(() => existsSync(childPidFile));
    childPid = Number(readFileSync(childPidFile, "utf8"));
    assert.ok(processAlive(childPid));

    controller.abort();
    const result = await execution;
    assert.notEqual(result.exitCode, 0);
    await waitFor(() => !processAlive(childPid!));
  } finally {
    if (childPid && processAlive(childPid)) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
