import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createRmGuard,
  disposeRmGuard,
  explicitRmBypassReason,
  rmGuardCommandPrefix,
  withRmGuardPath,
} from "../command-safety";

const run = (executable: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(executable, args, { encoding: "utf8", env });

test("rm guard derives policy independently of HOME and blocks final expanded home argv", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rm-safety-"));
  const accountHome = join(root, "account-home");
  mkdirSync(accountHome);
  const guard = createRmGuard(accountHome);

  try {
    const exact = run(guard.executable, ["-rf", accountHome], { ...process.env, HOME: join(root, "poisoned-home") });
    assert.equal(exact.status, 64);
    assert.match(exact.stderr, /REFUSED rm of protected path/);
    assert.equal(existsSync(accountHome), true);

    const dotted = run(guard.executable, ["-rf", join(accountHome, ".")]);
    assert.equal(dotted.status, 64);
    assert.equal(existsSync(accountHome), true);
  } finally {
    disposeRmGuard(guard);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rm guard rejects expanded top-level home wipes but permits scoped deletion", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rm-expansion-"));
  const accountHome = join(root, "account-home");
  const first = join(accountHome, "first");
  const second = join(accountHome, "second");
  const scoped = join(accountHome, "cache", "item");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  mkdirSync(scoped, { recursive: true });
  writeFileSync(join(scoped, "data"), "test");
  const guard = createRmGuard(accountHome);

  try {
    const oneTopLevel = run(guard.executable, ["-rf", first]);
    assert.equal(oneTopLevel.status, 64);
    assert.match(oneTopLevel.stderr, /top-level home entry/);
    assert.equal(existsSync(first), true);

    const expansion = run(guard.executable, ["-rf", first, second]);
    assert.equal(expansion.status, 64);
    assert.match(expansion.stderr, /top-level home entry/);
    assert.equal(existsSync(first), true);
    assert.equal(existsSync(second), true);

    const allowed = run(guard.executable, ["-rf", scoped]);
    assert.equal(allowed.status, 0);
    assert.equal(existsSync(scoped), false);
  } finally {
    disposeRmGuard(guard);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rm guard PATH injection is private and explicit system-rm bypasses are rejected", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rm-path-"));
  const accountHome = join(root, "account-home");
  mkdirSync(accountHome);
  const guard = createRmGuard(accountHome);

  try {
    const env = withRmGuardPath({ PATH: "/usr/bin:/bin" }, guard);
    assert.equal(env.PATH?.split(":")[0], guard.dir);
    assert.match(rmGuardCommandPrefix(guard), /(?:^|\n)export PATH=/);
    assert.match(explicitRmBypassReason("/bin/rm -rf ./build") ?? "", /bypasses/);
    assert.match(explicitRmBypassReason("PATH=/bin rm -rf ./build") ?? "", /overriding PATH/);
    assert.match(explicitRmBypassReason("command -p rm -rf ./build") ?? "", /command -p/);
    assert.match(explicitRmBypassReason("env -i rm -rf ./build") ?? "", /empty environment/);
    assert.match(explicitRmBypassReason("sudo -n rm -rf ./build") ?? "", /sudo/);
    assert.equal(explicitRmBypassReason("rm -rf ./build"), undefined);
  } finally {
    disposeRmGuard(guard);
    rmSync(root, { recursive: true, force: true });
  }
});
