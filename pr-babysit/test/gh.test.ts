import assert from "node:assert/strict";
import test from "node:test";

import {
  GhClient,
  GhCommandError,
  type GhRunner,
  parsePrUrl,
} from "../src/gh.ts";

const rawPr = {
  number: 7,
  url: "https://github.com/Owner/Repo/pull/7",
  title: "Test PR",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefName: "feature",
  headRefOid: "abc123",
  headRepository: { nameWithOwner: "Owner/Repo" },
  reviewDecision: "APPROVED",
  statusCheckRollup: [],
};

function jsonResult(value: unknown): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(value), stderr: "" };
}

test("PR URLs and gh metadata resolve to canonical keys", async () => {
  assert.deepEqual(parsePrUrl("https://github.com/Owner/Repo/pull/007/"), {
    host: "github.com",
    owner: "owner",
    repo: "repo",
    number: 7,
    key: "owner/repo#7",
  });
  assert.deepEqual(parsePrUrl("https://GHE.Example.test/Owner/Repo/pull/7"), {
    host: "ghe.example.test",
    owner: "owner",
    repo: "repo",
    number: 7,
    key: "ghe.example.test/owner/repo#7",
  });
  assert.throws(() => parsePrUrl("http://ghe.example.test/owner/repo/pull/7"), /https/);

  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push([...args]);
    return jsonResult(rawPr);
  };
  const resolved = await new GhClient(runner).resolvePr("OWNER/REPO#007");
  assert.equal(resolved.key, "owner/repo#7");
  assert.equal(resolved.headRefName, "feature");
  assert.equal(resolved.headRepository, "owner/repo");
  assert.deepEqual(calls[0]?.slice(0, 6), ["pr", "view", "7", "--repo", "github.com/owner/repo", "--json"]);
});

test("GitHub Enterprise PRs without nameWithOwner fall back to owner/name", async () => {
  const ghesPr = {
    ...rawPr,
    headRepository: { name: "Repo" },
    headRepositoryOwner: { login: "Owner" },
  };
  const runner: GhRunner = async () => jsonResult(ghesPr);
  const resolved = await new GhClient(runner).resolvePr("OWNER/REPO#7");
  assert.equal(resolved.headRepository, "owner/repo");

  // When even the owner is missing, fall back to the base repository.
  const nameOnly = { ...rawPr, headRepository: { name: "OtherRepo" }, headRepositoryOwner: null };
  const nameOnlyResolved = await new GhClient(async () => jsonResult(nameOnly)).resolvePr("OWNER/REPO#7");
  assert.equal(nameOnlyResolved.headRepository, "owner/otherrepo");
});

test("bare PR numbers resolve against the current repository", async () => {
  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "repo") return jsonResult({ nameWithOwner: "Owner/Repo", url: "https://github.com/Owner/Repo" });
    return jsonResult(rawPr);
  };
  const resolved = await new GhClient(runner).resolvePr("7", { cwd: "/tmp/repository" });
  assert.equal(resolved.key, "owner/repo#7");
  assert.deepEqual(calls[0], ["repo", "view", "--json", "nameWithOwner,url"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.[4], "github.com/owner/repo");
});

test("poll API calls paginate, flatten pages, and parse actors", async () => {
  const runner: GhRunner = async (args) => {
    const joined = args.join(" ");
    if (joined === "api --hostname github.com user") return jsonResult({ login: "FooNTinz" });
    if (args[0] === "pr") return jsonResult(rawPr);
    if (joined.includes("issues/7/comments")) {
      return jsonResult([[{
        id: 1,
        body: "hello",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        user: { login: "alice" },
      }], []]);
    }
    if (joined.includes("pulls/7/comments")) return jsonResult([[]]);
    if (joined.includes("pulls/7/reviews")) {
      return jsonResult([[{
        id: 3,
        body: "review",
        state: "COMMENTED",
        submitted_at: "2026-01-01T00:01:00Z",
        user: { login: "bob" },
      }]]);
    }
    throw new Error(`Unexpected gh call: ${joined}`);
  };
  const client = new GhClient(runner);
  assert.equal(await client.currentLogin(), "foontinz");
  const snapshot = await client.pollSnapshot(
    { host: "github.com", owner: "owner", repo: "repo", number: 7, key: "owner/repo#7" },
    { issueCommentsSince: null, reviewCommentsSince: null },
  );
  assert.equal(snapshot.issueComments[0]?.actor, "alice");
  assert.equal(snapshot.reviewComments.length, 0);
  assert.equal(snapshot.reviews[0]?.actor, "bob");
});

test("GitHub Enterprise URLs, GH_HOST keys, login, and API calls target the explicit host", async () => {
  const enterprisePr = {
    ...rawPr,
    url: "https://ghe.example.test/Owner/Repo/pull/7",
  };
  const calls: string[][] = [];
  const runner: GhRunner = async (args) => {
    calls.push([...args]);
    const joined = args.join(" ");
    if (joined === "api --hostname ghe.example.test user") return jsonResult({ login: "EnterpriseUser" });
    if (args[0] === "pr") return jsonResult(enterprisePr);
    if (joined.includes("issues/7/comments")) return jsonResult([[]]);
    if (joined.includes("pulls/7/comments")) return jsonResult([[]]);
    if (joined.includes("pulls/7/reviews")) return jsonResult([[]]);
    throw new Error(`Unexpected enterprise gh call: ${joined}`);
  };
  const client = new GhClient(runner);
  const resolved = await client.resolvePr("Owner/Repo#7", { host: "GHE.Example.test" });
  assert.equal(resolved.key, "ghe.example.test/owner/repo#7");
  assert.equal(resolved.host, "ghe.example.test");
  assert.deepEqual(calls[0]?.slice(0, 6), ["pr", "view", "7", "--repo", "ghe.example.test/owner/repo", "--json"]);
  assert.equal(await client.currentLogin({ host: resolved.host }), "enterpriseuser");
  await client.pollSnapshot(resolved, { issueCommentsSince: null, reviewCommentsSince: null });
  assert.ok(calls.some((args) => args[0] === "api" && args[1] === "--hostname" && args[2] === "ghe.example.test"));
});

test("bare PR numbers preserve the current Enterprise repository hostname", async () => {
  const calls: string[][] = [];
  const client = new GhClient(async (args) => {
    calls.push([...args]);
    if (args[0] === "repo") return jsonResult({ nameWithOwner: "Owner/Repo", url: "https://ghe.example.test/Owner/Repo" });
    return jsonResult({ ...rawPr, url: "https://ghe.example.test/Owner/Repo/pull/7" });
  });
  const resolved = await client.resolvePr("7", { cwd: "/tmp/enterprise-repository" });
  assert.equal(resolved.key, "ghe.example.test/owner/repo#7");
  assert.equal(calls[1]?.[4], "ghe.example.test/owner/repo");
});

test("gh errors retain rate-limit classification", () => {
  const error = new GhCommandError(["api", "user"], "HTTP 403: API rate limit exceeded", {
    exitCode: 1,
    stderr: "secondary rate limit",
  });
  assert.equal(error.rateLimited, true);
  assert.equal(error.forbidden, true);
  assert.equal(error.exitCode, 1);
  assert.equal(new GhCommandError([], "HTTP 403: forbidden").forbidden, true);
});

test("rate-limit reset considers exhausted REST and GraphQL resources", async () => {
  const client = new GhClient(async () => jsonResult({
    resources: {
      core: { remaining: 0, reset: 1_800_000_000 },
      graphql: { remaining: 0, reset: 1_800_000_100 },
      search: { remaining: 10, reset: 1_900_000_000 },
    },
  }));
  assert.equal((await client.rateLimitResetAt())?.toISOString(), "2027-01-15T08:01:40.000Z");
});
