import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MODEL_DEFAULTS,
	type ProviderDefinition,
} from "../src/types.js";

export function provider(
	overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
	return {
		id: "gateway",
		name: "Gateway",
		enabled: true,
		baseUrl: "https://gateway.example/v1",
		api: "openai-completions",
		discovery: { format: "openai", path: "/models", timeoutMs: 15_000 },
		credential: { kind: "env", value: "GATEWAY_API_KEY" },
		defaults: structuredClone(DEFAULT_MODEL_DEFAULTS),
		overrides: {},
		...overrides,
	};
}

export async function tempPath(name: string): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "pi-provider-discovery-")), name);
}
