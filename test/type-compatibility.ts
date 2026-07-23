import type { ProviderConfig as PiProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ProviderConfig as OmpProviderConfig } from "@oh-my-pi/pi-coding-agent";

const sharedProviderConfig = {
	baseUrl: "https://gateway.example/v1",
	apiKey: "$API_KEY",
	api: "openai-completions" as const,
	headers: { "User-Agent": "pi-provider-discovery/0.1.0" },
	authHeader: true,
	models: [
		{
			id: "model-id",
			name: "Model",
			api: "openai-completions" as const,
			reasoning: false,
			input: ["text"] as Array<"text" | "image">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		},
	],
} satisfies PiProviderConfig;

const ompCompatibilityCheck: OmpProviderConfig = sharedProviderConfig;
void ompCompatibilityCheck;
