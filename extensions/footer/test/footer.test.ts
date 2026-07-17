import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCwd, formatTokens, layoutRow, partitionExtensionStatuses } from "../index.ts";

test("formatTokens", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(8_700), "8.7k");
	assert.equal(formatTokens(77_000), "77k");
	assert.equal(formatTokens(1_300_000), "1.3M");
	assert.equal(formatTokens(12_000_000), "12M");
});

test("formatCwd replaces home with ~", () => {
	assert.equal(formatCwd("/home/u/project", "/home/u"), "~/project");
	assert.equal(formatCwd("/home/u", "/home/u"), "~");
	assert.equal(formatCwd("/opt/other", "/home/u"), "/opt/other");
	assert.equal(formatCwd("/home/u2/x", "/home/u"), "/home/u2/x");
});

test("layoutRow right-aligns when it fits", () => {
	assert.equal(layoutRow("left", "right", 20), "left           right");
	assert.equal(layoutRow("left", "", 20), "left");
	assert.equal(layoutRow("0123456789", "0123456789", 21), null);
});

test("Skill Forge is pinned below token usage while other statuses stay inline", () => {
	assert.deepEqual(partitionExtensionStatuses(new Map([
		["mcp", "MCP: 2/2"],
		["skill-forge", "forge 3 ready · caught up · on"],
		["tool-view", "tools: minimized"],
	])), {
		inline: "MCP: 2/2",
		belowStats: "forge 3 ready · caught up · on",
	});
});
