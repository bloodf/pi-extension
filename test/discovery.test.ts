import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { discoverProviders, fetchProviderModels } from "../src/discovery.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { provider, tempPath } from "./helpers.js";

test("discovers OpenAI models with bearer auth, metadata, overrides, and filters", async () => {
	const definition = provider({
		include: ["gpt-*"],
		exclude: ["*-legacy"],
		overrides: { "gpt-new": { reasoning: true, maxTokens: 32_000 } },
		headers: { "User-Agent": "gateway-client/1.0" },
	});
	let requestHeaders: Headers | undefined;
	const models = await fetchProviderModels(
		definition,
		"secret",
		definition.headers ?? {},
		async (_url, init) => {
			requestHeaders = new Headers(init?.headers);
			return Response.json({
				object: "list",
				data: [
					{
						id: "gpt-new",
						name: "GPT New",
						capabilities: {
							contextWindow: 200_000,
							maxOutput: 16_000,
							reasoning: true,
							vision: true,
						},
					},
					{ id: "gpt-new" },
					{
						id: "gpt-capabilities",
						capabilities: {
							contextWindow: 100_000,
							maxOutput: 12_000,
							reasoning: false,
							vision: false,
						},
					},
					{ id: "gpt-legacy" },
					{ id: "embedding-only" },
				],
			});
		},
	);
	assert.equal(requestHeaders?.get("authorization"), "Bearer secret");
	assert.equal(requestHeaders?.get("user-agent"), "gateway-client/1.0");
	assert.deepEqual(
		models.map((model) => model.id),
		["gpt-capabilities", "gpt-new"],
	);
	assert.equal(models[0]?.contextWindow, 100_000);
	assert.equal(models[0]?.maxTokens, 12_000);
	assert.equal(models[0]?.reasoning, false);
	assert.deepEqual(models[0]?.input, ["text"]);
	assert.equal(models[1]?.contextWindow, 200_000);
	assert.equal(models[1]?.maxTokens, 32_000);
	assert.equal(models[1]?.reasoning, true);
	assert.deepEqual(models[1]?.input, ["text", "image"]);
});

test("paginates Anthropic models and maps official capabilities", async () => {
	const definition = provider({
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		discovery: { format: "anthropic", path: "/v1/models", timeoutMs: 15_000 },
	});
	const urls: string[] = [];
	const models = await fetchProviderModels(
		definition,
		"anthropic-secret",
		{},
		async (input, init) => {
			const url = String(input);
			urls.push(url);
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("x-api-key"), "anthropic-secret");
			assert.equal(headers.get("anthropic-version"), "2023-06-01");
			if (!url.includes("after_id")) {
				return Response.json({
					data: [
						{
							id: "claude-a",
							display_name: "Claude A",
							max_input_tokens: 200_000,
							max_tokens: 64_000,
							capabilities: {
								image_input: { supported: true },
								thinking: { supported: true },
							},
						},
					],
					has_more: true,
					last_id: "claude-a",
				});
			}
			return Response.json({
				data: [{ id: "claude-b", display_name: "Claude B" }],
				has_more: false,
			});
		},
	);
	assert.equal(urls.length, 2);
	assert.match(urls[1] ?? "", /after_id=claude-a/);
	assert.deepEqual(
		models.map((model) => model.id),
		["claude-a", "claude-b"],
	);
	assert.equal(models[0]?.reasoning, true);
	assert.deepEqual(models[0]?.input, ["text", "image"]);
});

test("rejects redirects and malformed catalog responses", async () => {
	await assert.rejects(
		fetchProviderModels(
			provider(),
			"secret",
			{},
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/models" },
				}),
		),
		/redirect rejected/,
	);
	await assert.rejects(
		fetchProviderModels(provider(), "secret", {}, async () =>
			Response.json({ data: "wrong" }),
		),
		/must be an array/,
	);
});

test("uses fresh cache and falls back to last-known-good data without caching secrets", async () => {
	const cachePath = await tempPath("cache/provider-discovery.json");
	const config = { ...DEFAULT_CONFIG, cacheTtlMs: 1, providers: [provider()] };
	let requests = 0;
	const live = await discoverProviders(config, cachePath, {
		env: { GATEWAY_API_KEY: "never-write-this-secret" },
		now: () => 1_000,
		fetchImpl: async () => {
			requests += 1;
			return Response.json({ data: [{ id: "gpt-live" }] });
		},
	});
	assert.equal(live.catalogs[0]?.source, "live");
	const cached = await discoverProviders(config, cachePath, {
		env: {},
		now: () => 1_000,
		fetchImpl: async () => {
			throw new Error("must not fetch");
		},
	});
	assert.equal(cached.catalogs[0]?.source, "cache");
	assert.equal(requests, 1);
	const fallback = await discoverProviders(config, cachePath, {
		force: true,
		env: {},
		now: () => 2_000,
		fetchImpl: async () => {
			throw new Error("offline");
		},
	});
	assert.equal(fallback.catalogs[0]?.source, "cache");
	assert.match(
		fallback.catalogs[0]?.warning ?? "",
		/GATEWAY_API_KEY is not set/,
	);
	assert.doesNotMatch(
		await readFile(cachePath, "utf8"),
		/never-write-this-secret/,
	);
});
