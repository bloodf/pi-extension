/**
 * Purpose: Defines the versioned configuration and normalized runtime contracts
 *          shared by every provider-discovery module.
 *
 * Public API: ProviderDiscoveryConfig, ProviderDefinition, DiscoveredModel,
 *             DiscoveryResult, DEFAULT_CONFIG, DEFAULT_MODEL_DEFAULTS.
 *
 * Upstream deps: none.
 *
 * Downstream consumers: config, credentials, discovery, cache, menu, and the
 *                       extension entry point.
 *
 * Failure modes: types have no side effects; runtime validation lives in config.ts.
 *
 * Performance: constants and structural types only.
 */

export type ProviderApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages";
export type DiscoveryFormat = "openai" | "anthropic";

export type CredentialReference =
	| { kind: "env"; value: string }
	| { kind: "command"; value: string }
	| { kind: "none" };

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelDefaults {
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
}

export interface ModelOverride {
	name?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	cost?: Partial<ModelCost>;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ProviderDefinition {
	id: string;
	name: string;
	enabled: boolean;
	baseUrl: string;
	api: ProviderApi;
	discovery: {
		format: DiscoveryFormat;
		path: string;
		timeoutMs?: number;
	};
	credential: CredentialReference;
	headers?: Record<string, string>;
	defaults: ModelDefaults;
	overrides: Record<string, ModelOverride>;
	include?: string[];
	exclude?: string[];
}

export interface ProviderDiscoveryConfig {
	version: 1;
	cacheTtlMs: number;
	providers: ProviderDefinition[];
}

export interface DiscoveredModel {
	id: string;
	name: string;
	api: ProviderApi;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
}

export interface ProviderCatalog {
	provider: ProviderDefinition;
	models: DiscoveredModel[];
	source: "live" | "cache";
	fetchedAt: string;
	warning?: string;
}

export interface DiscoveryResult {
	catalogs: ProviderCatalog[];
	warnings: string[];
}

export interface RuntimePaths {
	agentDir: string;
	configPath: string;
	cachePath: string;
}

export type HostKind = "pi" | "omp";

export const DEFAULT_MODEL_DEFAULTS: ModelDefaults = {
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};

export const DEFAULT_CONFIG: ProviderDiscoveryConfig = {
	version: 1,
	cacheTtlMs: 24 * 60 * 60 * 1_000,
	providers: [],
};
