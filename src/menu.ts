/**
 * Purpose: Provides the portable /providers configuration and diagnostics menu
 *          using only UI primitives shared by Pi and OMP.
 *
 * Public API: registerProvidersCommand.
 *
 * Upstream deps: Pi extension types (erased at runtime), config, credentials,
 *                discovery, and shared types.
 *
 * Downstream consumers: extension entry point and interactive users.
 *
 * Failure modes: cancelled dialogs make no changes; invalid input is reported
 *                without saving. Successful writes reload and immediately return.
 *
 * Performance: no network except explicit test/refresh actions; menu state is
 *              loaded from disk per invocation.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, validateConfig } from "./config.js";
import { resolveCredential, resolveHeaderValues } from "./credentials.js";
import {
	buildDiscoveryEndpoint,
	discoverProviders,
	fetchProviderModels,
} from "./discovery.js";
import {
	type CredentialReference,
	DEFAULT_MODEL_DEFAULTS,
	type DiscoveryFormat,
	type ModelDefaults,
	type ProviderApi,
	type ProviderDefinition,
	type ProviderDiscoveryConfig,
	type RuntimePaths,
} from "./types.js";

const API_LABELS: Record<string, ProviderApi> = {
	"OpenAI Chat Completions": "openai-completions",
	"OpenAI Responses": "openai-responses",
	"Anthropic Messages": "anthropic-messages",
};
const FORMAT_LABELS: Record<string, DiscoveryFormat> = {
	OpenAI: "openai",
	Anthropic: "anthropic",
};

async function requiredInput(
	ctx: ExtensionCommandContext,
	title: string,
	current?: string,
): Promise<string | undefined> {
	const value = await ctx.ui.input(title, current);
	if (value === undefined) return undefined;
	if (!value.trim()) {
		ctx.ui.notify(`${title} cannot be empty`, "error");
		return undefined;
	}
	return value.trim();
}

async function chooseCredential(
	ctx: ExtensionCommandContext,
	current?: CredentialReference,
): Promise<CredentialReference | undefined> {
	const choice = await ctx.ui.select("Credential source", [
		"Environment variable",
		"Command",
		"None",
	]);
	if (!choice) return undefined;
	if (choice === "None") return { kind: "none" };
	if (choice === "Environment variable") {
		const value = await requiredInput(
			ctx,
			"Environment variable name",
			current?.kind === "env" ? current.value : undefined,
		);
		return value ? { kind: "env", value } : undefined;
	}
	const value = await requiredInput(
		ctx,
		"Credential command (stdout only)",
		current?.kind === "command" ? current.value : undefined,
	);
	return value ? { kind: "command", value } : undefined;
}

async function chooseApi(
	ctx: ExtensionCommandContext,
	current?: ProviderApi,
): Promise<ProviderApi | undefined> {
	const currentLabel = Object.entries(API_LABELS).find(
		([, api]) => api === current,
	)?.[0];
	const choice = await ctx.ui.select("Request API", Object.keys(API_LABELS));
	return choice
		? API_LABELS[choice]
		: currentLabel
			? API_LABELS[currentLabel]
			: undefined;
}

async function chooseFormat(
	ctx: ExtensionCommandContext,
	current?: DiscoveryFormat,
): Promise<DiscoveryFormat | undefined> {
	const currentLabel = Object.entries(FORMAT_LABELS).find(
		([, format]) => format === current,
	)?.[0];
	const choice = await ctx.ui.select(
		"Discovery response format",
		Object.keys(FORMAT_LABELS),
	);
	return choice
		? FORMAT_LABELS[choice]
		: currentLabel
			? FORMAT_LABELS[currentLabel]
			: undefined;
}

function defaultDiscoveryPath(
	baseUrl: string,
	format: DiscoveryFormat,
): string {
	if (format === "openai") return "/models";
	return new URL(baseUrl).pathname.replace(/\/$/u, "").endsWith("/v1")
		? "/models"
		: "/v1/models";
}

async function addProvider(
	ctx: ExtensionCommandContext,
	config: ProviderDiscoveryConfig,
): Promise<ProviderDefinition | undefined> {
	const id = await requiredInput(ctx, "Provider ID (lowercase)");
	if (!id) return undefined;
	const name = await requiredInput(ctx, "Display name", id);
	if (!name) return undefined;
	const baseUrl = await requiredInput(
		ctx,
		"API base URL",
		"https://example.com/v1",
	);
	if (!baseUrl) return undefined;
	const api = await chooseApi(ctx);
	if (!api) return undefined;
	const format = await chooseFormat(
		ctx,
		api === "anthropic-messages" ? "anthropic" : "openai",
	);
	if (!format) return undefined;
	const path = await requiredInput(
		ctx,
		"Models endpoint path",
		defaultDiscoveryPath(baseUrl, format),
	);
	if (!path) return undefined;
	const credential = await chooseCredential(ctx);
	if (!credential) return undefined;
	const userAgent = await ctx.ui.input(
		"Optional User-Agent header",
		"pi-provider-discovery/0.1.0",
	);
	const provider: ProviderDefinition = {
		id,
		name,
		enabled: true,
		baseUrl,
		api,
		discovery: { format, path, timeoutMs: 15_000 },
		credential,
		defaults: structuredClone(DEFAULT_MODEL_DEFAULTS),
		overrides: {},
	};
	if (userAgent?.trim()) provider.headers = { "User-Agent": userAgent.trim() };
	try {
		return validateConfig({
			...config,
			providers: [...config.providers, provider],
		}).providers.at(-1);
	} catch (error) {
		ctx.ui.notify(
			error instanceof Error ? error.message : "Invalid provider",
			"error",
		);
		return undefined;
	}
}

async function editConnection(
	ctx: ExtensionCommandContext,
	provider: ProviderDefinition,
): Promise<ProviderDefinition | undefined> {
	const baseUrl = await requiredInput(ctx, "API base URL", provider.baseUrl);
	if (!baseUrl) return undefined;
	const api = await chooseApi(ctx, provider.api);
	if (!api) return undefined;
	const format = await chooseFormat(ctx, provider.discovery.format);
	if (!format) return undefined;
	const path = await requiredInput(
		ctx,
		"Models endpoint path",
		provider.discovery.path,
	);
	if (!path) return undefined;
	return {
		...provider,
		baseUrl,
		api,
		discovery: { ...provider.discovery, format, path },
	};
}

async function editJsonField(
	ctx: ExtensionCommandContext,
	title: string,
	current: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
	const raw = await ctx.ui.input(title, JSON.stringify(current));
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("value must be a JSON object");
		return parsed as Record<string, unknown>;
	} catch (error) {
		ctx.ui.notify(
			error instanceof Error ? error.message : "Invalid JSON",
			"error",
		);
		return undefined;
	}
}

async function editDefaults(
	ctx: ExtensionCommandContext,
	defaults: ModelDefaults,
): Promise<ModelDefaults | undefined> {
	const contextWindow = await requiredInput(
		ctx,
		"Default context window",
		String(defaults.contextWindow),
	);
	if (!contextWindow) return undefined;
	const maxTokens = await requiredInput(
		ctx,
		"Default maximum output tokens",
		String(defaults.maxTokens),
	);
	if (!maxTokens) return undefined;
	const reasoning = await ctx.ui.confirm(
		"Reasoning",
		"Default discovered models to reasoning-capable?",
	);
	const image = await ctx.ui.confirm(
		"Image input",
		"Default discovered models to image-capable?",
	);
	return {
		...defaults,
		contextWindow: Number(contextWindow),
		maxTokens: Number(maxTokens),
		reasoning,
		input: image ? ["text", "image"] : ["text"],
	};
}

async function testProvider(
	ctx: ExtensionCommandContext,
	provider: ProviderDefinition,
): Promise<void> {
	ctx.ui.notify(`Testing ${provider.name}…`, "info");
	try {
		const credential = await resolveCredential(provider.credential);
		const headers = await resolveHeaderValues(provider.headers);
		const models = await fetchProviderModels(provider, credential, headers);
		ctx.ui.notify(
			`${provider.name}: ${models.length} models discovered`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(
			`${provider.name}: ${error instanceof Error ? error.message : "test failed"}`,
			"error",
		);
	}
}

async function saveAndReload(
	ctx: ExtensionCommandContext,
	paths: RuntimePaths,
	config: ProviderDiscoveryConfig,
): Promise<void> {
	try {
		await saveConfig(paths.configPath, config);
		ctx.ui.notify("Provider configuration saved", "info");
		await ctx.reload();
	} catch (error) {
		ctx.ui.notify(
			error instanceof Error ? error.message : "Unable to save configuration",
			"error",
		);
	}
}

async function providerMenu(
	ctx: ExtensionCommandContext,
	paths: RuntimePaths,
	config: ProviderDiscoveryConfig,
	providerIndex: number,
): Promise<boolean> {
	const provider = config.providers[providerIndex];
	if (!provider) return false;
	const action = await ctx.ui.select(provider.name, [
		"Test connection",
		"Edit connection",
		"Edit credential reference",
		"Edit headers",
		"Edit model defaults",
		"Edit model overrides",
		provider.enabled ? "Disable" : "Enable",
		"Remove",
		"Back",
	]);
	if (!action || action === "Back") return false;
	if (action === "Test connection") {
		await testProvider(ctx, provider);
		return false;
	}
	let replacement: ProviderDefinition | undefined;
	if (action === "Edit connection")
		replacement = await editConnection(ctx, provider);
	if (action === "Edit credential reference") {
		const credential = await chooseCredential(ctx, provider.credential);
		if (credential) replacement = { ...provider, credential };
	}
	if (action === "Edit headers") {
		const headers = await editJsonField(
			ctx,
			"Headers (values may use $ENV_VAR or !command)",
			provider.headers ?? {},
		);
		if (headers)
			replacement = { ...provider, headers: headers as Record<string, string> };
	}
	if (action === "Edit model defaults") {
		const defaults = await editDefaults(ctx, provider.defaults);
		if (defaults) replacement = { ...provider, defaults };
	}
	if (action === "Edit model overrides") {
		const overrides = await editJsonField(
			ctx,
			"Exact model overrides",
			provider.overrides,
		);
		if (overrides)
			replacement = { ...provider, overrides } as ProviderDefinition;
	}
	if (action === "Disable" || action === "Enable")
		replacement = { ...provider, enabled: !provider.enabled };
	if (action === "Remove") {
		if (!(await ctx.ui.confirm("Remove provider", `Remove ${provider.name}?`)))
			return false;
		await saveAndReload(ctx, paths, {
			...config,
			providers: config.providers.filter((_, index) => index !== providerIndex),
		});
		return true;
	}
	if (!replacement) return false;
	const providers = [...config.providers];
	providers[providerIndex] = replacement;
	await saveAndReload(ctx, paths, { ...config, providers });
	return true;
}

async function showDiagnostics(
	ctx: ExtensionCommandContext,
	paths: RuntimePaths,
	config: ProviderDiscoveryConfig,
): Promise<void> {
	const result = await discoverProviders(config, paths.cachePath);
	const lines = [
		`Config: ${paths.configPath}`,
		...config.providers.map((provider) => {
			const catalog = result.catalogs.find(
				(item) => item.provider.id === provider.id,
			);
			return `${provider.id}: ${provider.enabled ? "enabled" : "disabled"}, ${catalog?.models.length ?? 0} models, ${catalog?.source ?? "unavailable"}, ${buildDiscoveryEndpoint(provider)}`;
		}),
	];
	ctx.ui.notify(lines.join("\n"), result.warnings.length ? "warning" : "info");
}

async function runMenu(
	ctx: ExtensionCommandContext,
	paths: RuntimePaths,
): Promise<void> {
	for (;;) {
		let config: ProviderDiscoveryConfig;
		try {
			config = await loadConfig(paths.configPath);
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error
					? error.message
					: "Unable to load provider configuration",
				"error",
			);
			return;
		}
		const providerLabels = config.providers.map(
			(provider) =>
				`${provider.enabled ? "●" : "○"} ${provider.name} (${provider.id})`,
		);
		const choice = await ctx.ui.select("Provider discovery", [
			...providerLabels,
			"Add provider",
			"Refresh all models",
			"Diagnostics",
			"Exit",
		]);
		if (!choice || choice === "Exit") return;
		const providerIndex = providerLabels.indexOf(choice);
		if (providerIndex >= 0) {
			if (await providerMenu(ctx, paths, config, providerIndex)) return;
			continue;
		}
		if (choice === "Add provider") {
			const provider = await addProvider(ctx, config);
			if (provider) {
				await saveAndReload(ctx, paths, {
					...config,
					providers: [...config.providers, provider],
				});
				return;
			}
		}
		if (choice === "Refresh all models") {
			const result = await discoverProviders(config, paths.cachePath, {
				force: true,
			});
			ctx.ui.notify(
				`Refreshed ${result.catalogs.length} providers${result.warnings.length ? `; ${result.warnings.join("; ")}` : ""}`,
				result.warnings.length ? "warning" : "info",
			);
			await ctx.reload();
			return;
		}
		if (choice === "Diagnostics") await showDiagnostics(ctx, paths, config);
	}
}

export function registerProvidersCommand(
	pi: ExtensionAPI,
	paths: RuntimePaths,
): void {
	pi.registerCommand("providers", {
		description: "Configure and refresh dynamic model providers",
		handler: async (_args, ctx) => runMenu(ctx, paths),
	});
}
