import assert from "node:assert/strict";
import test from "node:test";
import {
	detectHost,
	resolveCredential,
	resolveHeaderValues,
	toHostCredential,
	toHostHeaders,
} from "../src/credentials.js";

test("resolves env and command references without persistence", async () => {
	assert.equal(
		await resolveCredential(
			{ kind: "env", value: "TEST_KEY" },
			{ TEST_KEY: "secret" },
		),
		"secret",
	);
	assert.equal(
		await resolveCredential(
			{ kind: "command", value: "ignored" },
			{},
			async () => "command-secret",
		),
		"command-secret",
	);
	assert.equal(await resolveCredential({ kind: "none" }, {}), undefined);
	await assert.rejects(
		resolveCredential({ kind: "env", value: "MISSING" }, {}),
		/MISSING is not set/,
	);
});

test("resolves referenced headers and preserves literals", async () => {
	assert.deepEqual(
		await resolveHeaderValues(
			{
				"X-Env": "$HEADER_TOKEN",
				"X-Braced": "$" + "{HEADER_TOKEN}",
				"X-Command": "!ignored",
				"User-Agent": "custom/1.0",
			},
			{ HEADER_TOKEN: "header-secret" },
			async () => "command-value",
		),
		{
			"X-Env": "header-secret",
			"X-Braced": "header-secret",
			"X-Command": "command-value",
			"User-Agent": "custom/1.0",
		},
	);
});

test("translates canonical references for Pi and OMP", () => {
	assert.equal(
		toHostCredential({ kind: "env", value: "API_KEY" }, "pi"),
		"$API_KEY",
	);
	assert.equal(
		toHostCredential({ kind: "env", value: "API_KEY" }, "omp"),
		"API_KEY",
	);
	assert.equal(
		toHostCredential({ kind: "command", value: "op read item" }, "pi"),
		"!op read item",
	);
	assert.equal(toHostCredential({ kind: "none" }, "omp"), "unused");
	assert.deepEqual(toHostHeaders({ "X-Key": "$HEADER_KEY" }, "omp"), {
		"X-Key": "HEADER_KEY",
	});
	assert.deepEqual(toHostHeaders({ "X-Key": "$HEADER_KEY" }, "pi"), {
		"X-Key": "$HEADER_KEY",
	});
});

test("detects host by the documented Pi unregisterProvider surface", () => {
	assert.equal(detectHost({ unregisterProvider() {} }), "pi");
	assert.equal(detectHost({}), "omp");
});
