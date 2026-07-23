/**
 * Purpose: Loads profile configuration, discovers model catalogs, registers
 *          providers before startup completes, and exposes /providers.
 *
 * Public API: default async Pi/OMP extension factory.
 *
 * Upstream deps: Pi extension type contract (erased at runtime), config,
 *                credentials, discovery, menu, and shared types.
 *
 * Downstream consumers: Pi and OMP extension loaders declared in package.json.
 *
 * Failure modes: invalid config or unavailable uncached providers are omitted
 *                with redacted warnings; /providers remains registered for repair.
 *
 * Performance: async startup uses fresh 24-hour cache when available; stale or
 *              missing catalogs fetch concurrently with bounded timeouts.
 */

import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveRuntimePaths } from "./config.js";
import { detectHost, toHostCredential, toHostHeaders } from "./credentials.js";
import { discoverProviders } from "./discovery.js";
import { registerProvidersCommand } from "./menu.js";

export default async function providerDiscoveryExtension(
	pi: ExtensionAPI,
): Promise<void> {
	const paths = resolveRuntimePaths();
	registerProvidersCommand(pi, paths);
	try {
		const config = await loadConfig(paths.configPath);
		const result = await discoverProviders(config, paths.cachePath);
		const host = detectHost(pi);
		for (const catalog of result.catalogs) {
			const runtimeHeaders =
				toHostHeaders(catalog.provider.headers, host) ?? {};
			if (
				!Object.keys(runtimeHeaders).some(
					(name) => name.toLowerCase() === "user-agent",
				)
			) {
				runtimeHeaders["User-Agent"] = "pi-provider-discovery/0.1.0";
			}
			const providerConfig: ProviderConfig = {
				baseUrl: catalog.provider.baseUrl,
				apiKey: toHostCredential(catalog.provider.credential, host),
				api: catalog.provider.api,
				headers: runtimeHeaders,
				authHeader:
					catalog.provider.discovery.format === "openai" &&
					catalog.provider.credential.kind !== "none",
				models: catalog.models,
			};
			pi.registerProvider(catalog.provider.id, providerConfig);
		}
		for (const warning of result.warnings)
			console.warn(`[provider-discovery] ${warning}`);
	} catch (error) {
		console.warn(
			`[provider-discovery] ${error instanceof Error ? error.message : "startup failed"}`,
		);
	}
}
