import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeCode } from "../executor";
import installCodeRunner from "../index";
import { BoundedOutputPreview, RecoverableOutput, sliceUtf8Head, sliceUtf8Tail } from "../output";
import {
  cleanupStaleCodeHandleRegistries,
  findCodeHandle,
  getRegisteredHandles,
  listCodeHandles,
  MIN_CODE_HANDLE_MATCH_SCORE,
  rankCodeHandles,
  registerCodeHandle,
  searchCodeHandles,
  unregisterCodeHandle,
} from "../hooks";

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

  const forced = new RecoverableOutput("pi-code-runner-forced-test", 1024, 100);
  forced.append("stdout", Buffer.from("small", "utf8"));
  forced.ensurePersisted();
  const forcedPath = forced.finish();
  assert.ok(forcedPath, "a derived truncated preview can force recovery persistence");
  rmSync(dirname(forcedPath!), { recursive: true, force: true });
});

test("UTF-8 truncation keeps code-point boundaries and reserves marker budget", () => {
  assert.doesNotMatch(sliceUtf8Head("🙂🙂", 5), /�/);
  assert.doesNotMatch(sliceUtf8Tail("🙂🙂", 5), /�/);

  const preview = new BoundedOutputPreview(512, 20);
  preview.append(Buffer.from(`${"🙂".repeat(200)}\n${"tail\n".repeat(30)}`, "utf8"));
  const text = preview.toString();
  assert.doesNotMatch(text, /�/);
  assert.ok(Buffer.byteLength(text, "utf8") <= 512);
  assert.ok(text.split("\n").length <= 20);
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

test("handle discovery supports catalog, aliases, capabilities, related terms, and typos", () => {
  const suffix = process.pid;
  const browserName = `browser_test_${suffix}`;
  const searchName = `search_test_${suffix}`;
  registerCodeHandle({
    name: browserName,
    aliases: [`pw-${suffix}`],
    summary: "Automate a browser and interact with webpages.",
    keywords: ["browser", "screenshot", "form"],
    capabilities: ["capture webpage screenshots", "navigate pages and fill forms"],
    setupCode: "",
    docs: "Browser automation reference.",
  });
  registerCodeHandle({
    name: searchName,
    summary: "Search public information.",
    keywords: ["search", "research"],
    capabilities: ["find current information online"],
    setupCode: "",
    docs: "Web research reference.",
  });

  try {
    assert.equal(findCodeHandle(`PW-${suffix}`)?.name, browserName);
    const catalogNames = listCodeHandles().map((handle) => handle.name);
    assert.deepEqual(catalogNames, [...catalogNames].sort((a, b) => a.localeCompare(b)));

    const screenshot = searchCodeHandles("take a webpage screensht")[0];
    assert.equal(screenshot.handle.name, browserName);
    assert.ok(screenshot.score >= MIN_CODE_HANDLE_MATCH_SCORE);
    assert.ok(screenshot.reasons.some((reason) => reason.includes("fuzzy match")));

    const onlineLookup = searchCodeHandles("look up current information on the internet")[0];
    assert.equal(onlineLookup.handle.name, searchName);
    assert.ok(onlineLookup.score >= MIN_CODE_HANDLE_MATCH_SCORE);
  } finally {
    unregisterCodeHandle(browserName);
    unregisterCodeHandle(searchName);
  }
});

test("search_spec supports list, natural-language search, and exact get actions", async () => {
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const pi = {
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
      tools.set(tool.name, tool);
    },
  };
  installCodeRunner(pi as never);

  const name = `discovery_actions_${process.pid}`;
  registerCodeHandle({
    name,
    aliases: [`discover-${process.pid}`],
    summary: "Inspect action discovery.",
    keywords: ["inspect"],
    capabilities: ["inspect discovery actions"],
    setupCode: "",
    docs: "Complete action discovery documentation.",
  });

  try {
    const tool = tools.get("search_spec");
    assert.ok(tool);
    const list = await tool!.execute("id", { action: "list" });
    assert.match(list.content[0].text, new RegExp(name));

    const search = await tool!.execute("id", { action: "search", goal: "inspect discovery" });
    assert.match(search.content[0].text, new RegExp(name));
    assert.match(search.content[0].text, /action=get/);
    assert.doesNotMatch(search.content[0].text, /Complete action discovery documentation/);

    const get = await tool!.execute("id", { action: "get", name: `DISCOVER-${process.pid}` });
    assert.match(get.content[0].text, /Complete action discovery documentation/);
  } finally {
    unregisterCodeHandle(name);
  }
});

test("pure discovery ranker extracts camel-case documentation symbols", () => {
  const matches = rankCodeHandles("getContents", [{
    name: "contentClient",
    setupCode: "",
    docs: "## Content methods\n\nCall `getContents(urls)` to fetch pages.",
  }]);
  assert.equal(matches[0].handle.name, "contentClient");
  assert.ok(matches[0].score >= MIN_CODE_HANDLE_MATCH_SCORE);
  assert.ok(matches[0].reasons.some((reason) => reason.includes("documentation symbol")));
});

test("incidental documentation tokens do not count as useful discovery matches", () => {
  const name = `weak_match_test_${process.pid}`;
  registerCodeHandle({
    name,
    setupCode: "",
    docs: "This reference happens to mention an obscureword once.",
  });
  try {
    const match = searchCodeHandles("obscureword").find((item) => item.handle.name === name);
    assert.ok(match);
    assert.ok(match.score < MIN_CODE_HANDLE_MATCH_SCORE);
  } finally {
    unregisterCodeHandle(name);
  }
});

test("type-checker setup failures do not silently execute user code", async () => {
  const result = await executeCode(
    'console.log("SHOULD_NOT_RUN")',
    [{ name: "broken", setupCode: 'const broken: number = "x";', docs: "test" }],
    { timeout: 10_000 },
  );
  assert.equal(result.exitCode, 2);
  assert.doesNotMatch(result.output, /SHOULD_NOT_RUN/);
  assert.match(result.stderr ?? "", /handle-setup\.ts/);
});

test("combined output preserves observed stdout/stderr event order", async () => {
  const result = await executeCode(
    `
process.stdout.write("out-one\\n");
await new Promise((resolve) => setTimeout(resolve, 20));
process.stderr.write("err-one\\n");
await new Promise((resolve) => setTimeout(resolve, 20));
process.stdout.write("out-two\\n");
`,
    [],
    { typecheck: false, timeout: 5_000 },
  );
  assert.equal(result.exitCode, 0);
  const combined = result.combinedOutput ?? "";
  assert.ok(combined.indexOf("out-one") < combined.indexOf("err-one"));
  assert.ok(combined.indexOf("err-one") < combined.indexOf("out-two"));
  assert.match(combined, /\[stdout\]/);
  assert.match(combined, /\[stderr\]/);
});

test("timeout remains a failed result when user code handles SIGTERM with exit zero", async () => {
  const result = await executeCode(
    'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);',
    [],
    { typecheck: false, timeout: 150 },
  );
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr ?? "", /timed out/);
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
