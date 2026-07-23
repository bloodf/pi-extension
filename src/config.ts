/**
 * Purpose: Resolves profile-local paths, validates untrusted JSON configuration,
 *          and persists configuration atomically without storing credentials.
 *
 * Public API: resolveRuntimePaths, loadConfig, saveConfig, validateConfig.
 *
 * Upstream deps: node:fs/promises, node:os, node:path, ./types.
 *
 * Downstream consumers: extension startup, menu, cache, and tests.
 *
 * Failure modes: malformed or unsafe configuration throws a redacted Error;
 *                missing config returns an empty default. Atomic save leaves the
 *                prior file intact if writing or rename fails.
 *
 * Performance: synchronous validation over provider/model override counts; disk
 *              access occurs once per load/save.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type CredentialReference,
	DEFAULT_CONFIG,
	DEFAULT_MODEL_DEFAULTS,
	type DiscoveryFormat,
	type ModelCost,
	type ModelDefaults,
	type ModelOverride,
	type ProviderApi,
	type ProviderDefinition,
	type ProviderDiscoveryConfig,
	type RuntimePaths,
} from "./types.js";

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const APIS: Record<ProviderApi, true> = {
	"openai-completions": true,
	"openai-responses": true,
	"anthropic-messages": true,
};
const FORMATS: Record<DiscoveryFormat, true> = {
	openai: true,
	anthropic: true,
};
const DEFAULT_TIMEOUT_MS = 15_000;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "")
		throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function boolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function positiveInteger(
	value: unknown,
	fallback: number,
	label: string,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	if (value === undefined) return fallback;
	if (
		!Number.isInteger(value) ||
		(value as number) <= 0 ||
		(value as number) > maximum
	) {
		throw new Error(
			`${label} must be a positive integer no greater than ${maximum}`,
		);
	}
	return value as number;
}

function nonNegativeNumber(
	value: unknown,
	fallback: number,
	label: string,
): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a non-negative number`);
	}
	return value;
}

function validateCost(
	value: unknown,
	fallback: ModelCost,
	label: string,
): ModelCost {
	if (value === undefined) return { ...fallback };
	const input = record(value, label);
	return {
		input: nonNegativeNumber(input.input, fallback.input, `${label}.input`),
		output: nonNegativeNumber(input.output, fallback.output, `${label}.output`),
		cacheRead: nonNegativeNumber(
			input.cacheRead,
			fallback.cacheRead,
			`${label}.cacheRead`,
		),
		cacheWrite: nonNegativeNumber(
			input.cacheWrite,
			fallback.cacheWrite,
			`${label}.cacheWrite`,
		),
	};
}

function validateInput(
	value: unknown,
	fallback: Array<"text" | "image">,
	label: string,
): Array<"text" | "image"> {
	if (value === undefined) return [...fallback];
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((item) => item !== "text" && item !== "image")
	) {
		throw new Error(`${label} must contain only text or image`);
	}
	return [...new Set(value as Array<"text" | "image">)];
}

function validateDefaults(value: unknown, label: string): ModelDefaults {
	const input = value === undefined ? {} : record(value, label);
	return {
		reasoning: boolean(input.reasoning, DEFAULT_MODEL_DEFAULTS.reasoning),
		input: validateInput(
			input.input,
			DEFAULT_MODEL_DEFAULTS.input,
			`${label}.input`,
		),
		cost: validateCost(
			input.cost,
			DEFAULT_MODEL_DEFAULTS.cost,
			`${label}.cost`,
		),
		contextWindow: positiveInteger(
			input.contextWindow,
			DEFAULT_MODEL_DEFAULTS.contextWindow,
			`${label}.contextWindow`,
		),
		maxTokens: positiveInteger(
			input.maxTokens,
			DEFAULT_MODEL_DEFAULTS.maxTokens,
			`${label}.maxTokens`,
		),
	};
}

function validateOverride(
	value: unknown,
	defaults: ModelDefaults,
	label: string,
): ModelOverride {
	const input = record(value, label);
	const output: ModelOverride = {};
	if (input.name !== undefined)
		output.name = string(input.name, `${label}.name`);
	if (input.reasoning !== undefined) {
		if (typeof input.reasoning !== "boolean")
			throw new Error(`${label}.reasoning must be boolean`);
		output.reasoning = input.reasoning;
	}
	if (input.input !== undefined)
		output.input = validateInput(input.input, defaults.input, `${label}.input`);
	if (input.cost !== undefined)
		output.cost = validateCost(input.cost, defaults.cost, `${label}.cost`);
	if (input.contextWindow !== undefined) {
		output.contextWindow = positiveInteger(
			input.contextWindow,
			defaults.contextWindow,
			`${label}.contextWindow`,
		);
	}
	if (input.maxTokens !== undefined)
		output.maxTokens = positiveInteger(
			input.maxTokens,
			defaults.maxTokens,
			`${label}.maxTokens`,
		);
	return output;
}

function validateBaseUrl(value: unknown, label: string): string {
	const raw = string(value, label);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`${label} must be a valid URL`);
	}
	const local =
		parsed.hostname === "localhost" ||
		parsed.hostname === "127.0.0.1" ||
		parsed.hostname === "[::1]";
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
		throw new Error(
			`${label} must use HTTPS, except localhost development endpoints`,
		);
	}
	parsed.hash = "";
	parsed.search = "";
	return parsed.toString().replace(/\/$/, "");
}

function validateDiscoveryPath(value: unknown, label: string): string {
	const path = string(value, label);
	if (
		!path.startsWith("/") ||
		path.includes("..") ||
		path.includes("://") ||
		path.includes("?") ||
		path.includes("#")
	) {
		throw new Error(
			`${label} must be an absolute endpoint path without traversal, query, or fragment`,
		);
	}
	return path;
}

function validateCredential(
	value: unknown,
	label: string,
): CredentialReference {
	const input = record(value, label);
	const kind = string(input.kind, `${label}.kind`);
	if (kind === "none") return { kind: "none" };
	const reference = string(input.value, `${label}.value`);
	if (kind === "env") {
		if (!ENV_NAME.test(reference))
			throw new Error(`${label}.value must be an environment variable name`);
		return { kind: "env", value: reference };
	}
	if (kind === "command") return { kind: "command", value: reference };
	throw new Error(`${label}.kind must be env, command, or none`);
}

function validateHeaders(
	value: unknown,
	label: string,
): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	const input = record(value, label);
	const output: Record<string, string> = {};
	for (const [name, raw] of Object.entries(input)) {
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
			throw new Error(`${label} contains an invalid header name`);
		output[name] = string(raw, `${label}.${name}`);
	}
	return Object.keys(output).length === 0 ? undefined : output;
}

function validatePatterns(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || item.trim() === "")
	) {
		throw new Error(`${label} must be an array of non-empty patterns`);
	}
	const patterns = [...new Set((value as string[]).map((item) => item.trim()))];
	return patterns.length === 0 ? undefined : patterns;
}

function validateProvider(value: unknown, index: number): ProviderDefinition {
	const label = `providers[${index}]`;
	const input = record(value, label);
	const id = string(input.id, `${label}.id`).toLowerCase();
	if (!PROVIDER_ID.test(id))
		throw new Error(`${label}.id must match ${PROVIDER_ID}`);
	const api = string(input.api, `${label}.api`) as ProviderApi;
	if (!APIS[api]) throw new Error(`${label}.api is unsupported`);
	const discovery = record(input.discovery, `${label}.discovery`);
	const format = string(
		discovery.format,
		`${label}.discovery.format`,
	) as DiscoveryFormat;
	if (!FORMATS[format])
		throw new Error(`${label}.discovery.format is unsupported`);
	const defaults = validateDefaults(input.defaults, `${label}.defaults`);
	const rawOverrides =
		input.overrides === undefined
			? {}
			: record(input.overrides, `${label}.overrides`);
	const overrides: Record<string, ModelOverride> = {};
	for (const [modelId, override] of Object.entries(rawOverrides)) {
		overrides[string(modelId, `${label}.overrides key`)] = validateOverride(
			override,
			defaults,
			`${label}.overrides.${modelId}`,
		);
	}
	const provider: ProviderDefinition = {
		id,
		name: string(input.name ?? id, `${label}.name`),
		enabled: boolean(input.enabled, true),
		baseUrl: validateBaseUrl(input.baseUrl, `${label}.baseUrl`),
		api,
		discovery: {
			format,
			path: validateDiscoveryPath(discovery.path, `${label}.discovery.path`),
			timeoutMs: positiveInteger(
				discovery.timeoutMs,
				DEFAULT_TIMEOUT_MS,
				`${label}.discovery.timeoutMs`,
				60_000,
			),
		},
		credential: validateCredential(input.credential, `${label}.credential`),
		defaults,
		overrides,
	};
	const headers = validateHeaders(input.headers, `${label}.headers`);
	const include = validatePatterns(input.include, `${label}.include`);
	const exclude = validatePatterns(input.exclude, `${label}.exclude`);
	if (headers) provider.headers = headers;
	if (include) provider.include = include;
	if (exclude) provider.exclude = exclude;
	return provider;
}

export function validateConfig(value: unknown): ProviderDiscoveryConfig {
	const input = record(value, "config");
	if (input.version !== 1) throw new Error("config.version must be 1");
	if (!Array.isArray(input.providers))
		throw new Error("config.providers must be an array");
	const providers = input.providers.map(validateProvider);
	const ids = new Set<string>();
	for (const provider of providers) {
		if (ids.has(provider.id))
			throw new Error(`duplicate provider id: ${provider.id}`);
		ids.add(provider.id);
	}
	return {
		version: 1,
		cacheTtlMs: positiveInteger(
			input.cacheTtlMs,
			DEFAULT_CONFIG.cacheTtlMs,
			"config.cacheTtlMs",
			30 * 24 * 60 * 60 * 1_000,
		),
		providers,
	};
}

function inferredDefaultAgentDir(argv: string[]): string {
	const executable = argv.join(" ").toLowerCase();
	return join(
		homedir(),
		executable.includes("omp") || executable.includes("oh-my-pi")
			? ".omp/agent"
			: ".pi/agent",
	);
}

export function resolveRuntimePaths(
	env: NodeJS.ProcessEnv = process.env,
	argv: string[] = process.argv,
): RuntimePaths {
	const explicitConfig = env.PI_PROVIDER_DISCOVERY_CONFIG?.trim();
	const agentDir = resolve(
		env.PI_CODING_AGENT_DIR?.trim() ||
			(explicitConfig
				? dirname(resolve(explicitConfig))
				: inferredDefaultAgentDir(argv)),
	);
	const configPath = resolve(
		explicitConfig || join(agentDir, "provider-discovery.json"),
	);
	return {
		agentDir,
		configPath,
		cachePath: join(agentDir, "cache", "provider-discovery.json"),
	};
}

export async function loadConfig(
	configPath: string,
): Promise<ProviderDiscoveryConfig> {
	try {
		return validateConfig(
			JSON.parse(await readFile(configPath, "utf8")) as unknown,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_CONFIG, providers: [] };
		}
		throw error;
	}
}

export async function saveConfig(
	configPath: string,
	config: ProviderDiscoveryConfig,
): Promise<void> {
	const validated = validateConfig(config);
	await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
	const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, configPath);
}
