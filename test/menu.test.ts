import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { registerProvidersCommand } from "../src/menu.js";
import { tempPath } from "./helpers.js";

test("registers /providers and adds a provider through shared UI primitives", async () => {
	const configPath = await tempPath("profile/provider-discovery.json");
	const paths = {
		agentDir: configPath.replace(/\/provider-discovery\.json$/, ""),
		configPath,
		cachePath: `${configPath}.cache`,
	};
	let commandName = "";
	let handler:
		| ((args: string, ctx: ExtensionCommandContext) => void | Promise<void>)
		| undefined;
	const api = {
		registerCommand(name: string, options: { handler: typeof handler }) {
			commandName = name;
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	registerProvidersCommand(api, paths);
	assert.equal(commandName, "providers");
	assert.ok(handler);

	const selections = [
		"Add provider",
		"OpenAI Chat Completions",
		"OpenAI",
		"Environment variable",
	];
	const inputs = [
		"gateway",
		"Gateway",
		"https://gateway.example/v1",
		"/models",
		"GATEWAY_API_KEY",
		"custom-agent/1.0",
	];
	let reloaded = false;
	const context = {
		ui: {
			select: async () => selections.shift(),
			input: async () => inputs.shift(),
			confirm: async () => true,
			notify() {},
		},
		reload: async () => {
			reloaded = true;
		},
	} as unknown as ExtensionCommandContext;
	await handler("", context);

	const config = await loadConfig(configPath);
	assert.equal(reloaded, true);
	assert.equal(config.providers[0]?.id, "gateway");
	assert.deepEqual(config.providers[0]?.credential, {
		kind: "env",
		value: "GATEWAY_API_KEY",
	});
	assert.deepEqual(config.providers[0]?.headers, {
		"User-Agent": "custom-agent/1.0",
	});
});
