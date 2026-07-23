/**
 * Purpose: Fetches, validates, normalizes, filters, and caches OpenAI-compatible
 *          or Anthropic-compatible model catalogs without leaking credentials.
 *
 * Public API: buildDiscoveryEndpoint, fetchProviderModels, discoverProviders.
 *
 * Upstream deps: global fetch/AbortController, ./cache, ./credentials, ./types.
 *
 * Downstream consumers: extension startup, /providers refresh, and tests.
 *
 * Failure modes: bounded network/response/parser failures return a redacted
 *                provider warning and fall back to matching last-known-good cache.
 *                Invalid/empty responses never replace good cache entries.
 *
 * Performance: fresh cache avoids network; live fetches run concurrently, each
 *              bounded to 15 seconds by default and 4 MiB per response page.
 */

import {
	getCacheEntry,
	isCacheFresh,
	loadCache,
	putCacheEntry,
	saveCache,
} from "./cache.js";
import {
	executeCredentialCommand,
	resolveCredential,
	resolveHeaderValues,
} from "./credentials.js";
import type {
	DiscoveredModel,
	DiscoveryResult,
	ModelCost,
	ModelDefaults,
	ModelOverride,
	ProviderCatalog,
	ProviderDefinition,
	ProviderDiscoveryConfig,
} from "./types.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ANTHROPIC_PAGES = 100;

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

interface DiscoveryOptions {
	force?: boolean;
	fetchImpl?: FetchLike;
	env?: NodeJS.ProcessEnv;
	runCommand?: (command: string) => Promise<string>;
	now?: () => number;
}

function rawRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function rawArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function booleanCapability(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const supported = (value as Record<string, unknown>).supported;
		return typeof supported === "boolean" ? supported : undefined;
	}
	return undefined;
}

function normalizedCost(value: unknown, fallback: ModelCost): ModelCost {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { ...fallback };
	const cost = value as Record<string, unknown>;
	return {
		input: nonNegativeNumber(cost.input) ?? fallback.input,
		output: nonNegativeNumber(cost.output) ?? fallback.output,
		cacheRead:
			nonNegativeNumber(cost.cacheRead ?? cost.cache_read) ??
			fallback.cacheRead,
		cacheWrite:
			nonNegativeNumber(cost.cacheWrite ?? cost.cache_write) ??
			fallback.cacheWrite,
	};
}

function normalizedInput(
	value: unknown,
	fallback: Array<"text" | "image">,
): Array<"text" | "image"> {
	if (!Array.isArray(value)) return [...fallback];
	const input = value.filter(
		(item): item is "text" | "image" => item === "text" || item === "image",
	);
	return input.length > 0 ? [...new Set(input)] : [...fallback];
}

function patternMatches(id: string, pattern: string): boolean {
	const escaped = pattern
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`, "u").test(id);
}

function selectedByFilters(provider: ProviderDefinition, id: string): boolean {
	if (
		provider.include?.length &&
		!provider.include.some((pattern) => patternMatches(id, pattern))
	)
		return false;
	return !provider.exclude?.some((pattern) => patternMatches(id, pattern));
}

function applyOverride(
	model: DiscoveredModel,
	override: ModelOverride | undefined,
): DiscoveredModel {
	if (!override) return model;
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		input: override.input ? [...override.input] : model.input,
		cost: override.cost ? { ...model.cost, ...override.cost } : model.cost,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
	};
}

function normalizeOpenAIModel(
	raw: unknown,
	provider: ProviderDefinition,
): DiscoveredModel {
	const model = rawRecord(raw, "OpenAI model");
	if (typeof model.id !== "string" || model.id.trim() === "")
		throw new Error("OpenAI model id must be a non-empty string");
	const defaults = provider.defaults;
	const capabilities =
		model.capabilities && typeof model.capabilities === "object"
			? (model.capabilities as Record<string, unknown>)
			: {};
	const imageSupport = booleanCapability(
		capabilities.image_input ?? capabilities.vision,
	);
	const explicitInput = normalizedInput(model.input, defaults.input);
	const input =
		imageSupport === true
			? [...new Set<"text" | "image">([...explicitInput, "image"])]
			: explicitInput;
	const normalized: DiscoveredModel = {
		id: model.id,
		name: typeof model.name === "string" && model.name ? model.name : model.id,
		api: provider.api,
		reasoning:
			typeof model.reasoning === "boolean"
				? model.reasoning
				: (booleanCapability(capabilities.thinking ?? capabilities.reasoning) ??
					defaults.reasoning),
		input,
		cost: normalizedCost(model.cost, defaults.cost),
		contextWindow:
			positiveNumber(
				model.context_window ??
					model.max_input_tokens ??
					capabilities.contextWindow,
			) ?? defaults.contextWindow,
		maxTokens:
			positiveNumber(
				model.max_tokens ?? model.max_output_tokens ?? capabilities.maxOutput,
			) ?? defaults.maxTokens,
	};
	return applyOverride(normalized, provider.overrides[model.id]);
}

function normalizeAnthropicModel(
	raw: unknown,
	provider: ProviderDefinition,
): DiscoveredModel {
	const model = rawRecord(raw, "Anthropic model");
	if (typeof model.id !== "string" || model.id.trim() === "")
		throw new Error("Anthropic model id must be a non-empty string");
	const defaults: ModelDefaults = provider.defaults;
	const capabilities =
		model.capabilities && typeof model.capabilities === "object"
			? (model.capabilities as Record<string, unknown>)
			: {};
	const input =
		booleanCapability(capabilities.image_input) === true
			? (["text", "image"] as Array<"text" | "image">)
			: [...defaults.input];
	const normalized: DiscoveredModel = {
		id: model.id,
		name:
			typeof model.display_name === "string" && model.display_name
				? model.display_name
				: model.id,
		api: provider.api,
		reasoning: booleanCapability(capabilities.thinking) ?? defaults.reasoning,
		input,
		cost: { ...defaults.cost },
		contextWindow:
			positiveNumber(model.max_input_tokens) ?? defaults.contextWindow,
		maxTokens: positiveNumber(model.max_tokens) ?? defaults.maxTokens,
	};
	return applyOverride(normalized, provider.overrides[model.id]);
}

function deduplicateAndFilter(
	provider: ProviderDefinition,
	models: DiscoveredModel[],
): DiscoveredModel[] {
	const ids = new Set<string>();
	const output: DiscoveredModel[] = [];
	for (const model of models) {
		if (ids.has(model.id) || !selectedByFilters(provider, model.id)) continue;
		ids.add(model.id);
		output.push(model);
	}
	return output.sort((left, right) => left.id.localeCompare(right.id));
}

export function buildDiscoveryEndpoint(provider: ProviderDefinition): string {
	return `${provider.baseUrl.replace(/\/+$/u, "")}/${provider.discovery.path.replace(/^\/+/, "")}`;
}

async function readLimitedJson(response: Response): Promise<unknown> {
	if (!response.body) throw new Error("discovery response has no body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error("discovery response exceeds 4 MiB");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new Error("discovery response is not valid JSON");
	}
}

async function fetchJson(
	url: URL,
	headers: Record<string, string>,
	timeoutMs: number,
	fetchImpl: FetchLike,
): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers,
			redirect: "manual",
			signal: controller.signal,
		});
		if (response.status >= 300 && response.status < 400)
			throw new Error(
				`discovery redirect rejected at ${url.origin}${url.pathname}`,
			);
		if (!response.ok)
			throw new Error(
				`discovery returned HTTP ${response.status} at ${url.origin}${url.pathname}`,
			);
		return await readLimitedJson(response);
	} catch (error) {
		if (controller.signal.aborted)
			throw new Error(`discovery timed out at ${url.origin}${url.pathname}`);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function setHeaderUnlessPresent(
	headers: Record<string, string>,
	name: string,
	value: string,
): void {
	if (
		!Object.keys(headers).some(
			(header) => header.toLowerCase() === name.toLowerCase(),
		)
	)
		headers[name] = value;
}

export async function fetchProviderModels(
	provider: ProviderDefinition,
	credential: string | undefined,
	resolvedHeaders: Record<string, string>,
	fetchImpl: FetchLike = fetch,
): Promise<DiscoveredModel[]> {
	const endpoint = new URL(buildDiscoveryEndpoint(provider));
	const headers = { accept: "application/json", ...resolvedHeaders };
	setHeaderUnlessPresent(headers, "user-agent", "pi-provider-discovery/0.1.0");
	if (credential) {
		if (provider.discovery.format === "anthropic")
			setHeaderUnlessPresent(headers, "x-api-key", credential);
		else
			setHeaderUnlessPresent(headers, "authorization", `Bearer ${credential}`);
	}
	if (provider.discovery.format === "anthropic")
		setHeaderUnlessPresent(headers, "anthropic-version", "2023-06-01");

	if (provider.discovery.format === "openai") {
		const payload = rawRecord(
			await fetchJson(
				endpoint,
				headers,
				provider.discovery.timeoutMs ?? 15_000,
				fetchImpl,
			),
			"OpenAI response",
		);
		return deduplicateAndFilter(
			provider,
			rawArray(payload.data, "OpenAI response.data").map((model) =>
				normalizeOpenAIModel(model, provider),
			),
		);
	}

	const models: DiscoveredModel[] = [];
	const cursors = new Set<string>();
	for (let page = 0; page < MAX_ANTHROPIC_PAGES; page += 1) {
		endpoint.searchParams.set("limit", "1000");
		const payload = rawRecord(
			await fetchJson(
				endpoint,
				headers,
				provider.discovery.timeoutMs ?? 15_000,
				fetchImpl,
			),
			"Anthropic response",
		);
		models.push(
			...rawArray(payload.data, "Anthropic response.data").map((model) =>
				normalizeAnthropicModel(model, provider),
			),
		);
		if (payload.has_more !== true)
			return deduplicateAndFilter(provider, models);
		if (
			typeof payload.last_id !== "string" ||
			!payload.last_id ||
			cursors.has(payload.last_id)
		) {
			throw new Error(
				"Anthropic discovery returned an invalid pagination cursor",
			);
		}
		cursors.add(payload.last_id);
		endpoint.searchParams.set("after_id", payload.last_id);
	}
	throw new Error(`Anthropic discovery exceeded ${MAX_ANTHROPIC_PAGES} pages`);
}

export async function discoverProviders(
	config: ProviderDiscoveryConfig,
	cachePath: string,
	options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
	const cache = await loadCache(cachePath);
	const now = options.now ?? Date.now;
	let cacheChanged = false;
	const warnings: string[] = [];
	const catalogs = (
		await Promise.all(
			config.providers
				.filter((provider) => provider.enabled)
				.map(async (provider): Promise<ProviderCatalog | undefined> => {
					const endpoint = buildDiscoveryEndpoint(provider);
					const cached = getCacheEntry(cache, provider.id, endpoint);
					if (
						!options.force &&
						cached &&
						isCacheFresh(cached, config.cacheTtlMs, now())
					) {
						return {
							provider,
							models: cached.models,
							source: "cache",
							fetchedAt: cached.fetchedAt,
						};
					}
					try {
						const runCommand = options.runCommand ?? executeCredentialCommand;
						const credential = await resolveCredential(
							provider.credential,
							options.env ?? process.env,
							runCommand,
						);
						const headers = await resolveHeaderValues(
							provider.headers,
							options.env ?? process.env,
							runCommand,
						);
						const models = await fetchProviderModels(
							provider,
							credential,
							headers,
							options.fetchImpl ?? fetch,
						);
						if (models.length === 0)
							throw new Error("discovery returned no usable models");
						const fetchedAt = new Date(now()).toISOString();
						putCacheEntry(cache, provider.id, { endpoint, fetchedAt, models });
						cacheChanged = true;
						return { provider, models, source: "live", fetchedAt };
					} catch (error) {
						const warning = `${provider.id}: ${error instanceof Error ? error.message : "discovery failed"}`;
						warnings.push(warning);
						return cached
							? {
									provider,
									models: cached.models,
									source: "cache",
									fetchedAt: cached.fetchedAt,
									warning,
								}
							: undefined;
					}
				}),
		)
	).filter((catalog): catalog is ProviderCatalog => catalog !== undefined);
	if (cacheChanged) await saveCache(cachePath, cache);
	return { catalogs, warnings };
}
