import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import {
	loadConfig,
	resolveRuntimePaths,
	saveConfig,
	validateConfig,
} from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { provider, tempPath } from "./helpers.js";

test("validates and normalizes a provider config", () => {
	const config = validateConfig({
		version: 1,
		providers: [{ ...provider(), id: "GATEWAY" }],
	});
	assert.equal(config.providers[0]?.id, "gateway");
	assert.equal(config.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs);
	assert.equal(config.providers[0]?.discovery.timeoutMs, 15_000);
});

test("rejects unsafe endpoints, duplicate IDs, and literal env credentials", () => {
	assert.throws(
		() =>
			validateConfig({
				version: 1,
				providers: [provider({ baseUrl: "http://gateway.example/v1" })],
			}),
		/HTTPS/,
	);
	assert.throws(
		() => validateConfig({ version: 1, providers: [provider(), provider()] }),
		/duplicate provider id/,
	);
	assert.throws(
		() =>
			validateConfig({
				version: 1,
				providers: [
					provider({ credential: { kind: "env", value: "sk-secret" } }),
				],
			}),
		/environment variable name/,
	);
	assert.throws(
		() =>
			validateConfig({
				version: 1,
				providers: [
					provider({ discovery: { format: "openai", path: "/../keys" } }),
				],
			}),
		/traversal/,
	);
});

test("saves and reloads config atomically with private permissions", async () => {
	const path = await tempPath("nested/provider-discovery.json");
	const config = { ...DEFAULT_CONFIG, providers: [provider()] };
	await saveConfig(path, config);
	assert.deepEqual(await loadConfig(path), validateConfig(config));
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await stat(dirname(path))).mode & 0o077, 0);
});

test("resolves explicit, Pi, and OMP profile paths", () => {
	assert.equal(
		resolveRuntimePaths(
			{ PI_PROVIDER_DISCOVERY_CONFIG: "/tmp/custom/providers.json" },
			["node", "pi"],
		).configPath,
		"/tmp/custom/providers.json",
	);
	assert.equal(
		resolveRuntimePaths({ PI_CODING_AGENT_DIR: "/tmp/profile-a" }, [
			"node",
			"omp",
		]).agentDir,
		"/tmp/profile-a",
	);
	assert.match(
		resolveRuntimePaths({}, ["/usr/local/bin/pi"]).agentDir,
		/\.pi\/agent$/,
	);
	assert.match(
		resolveRuntimePaths({}, ["/usr/local/bin/omp"]).agentDir,
		/\.omp\/agent$/,
	);
});
