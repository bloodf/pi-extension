import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG, DEFAULT_MODEL_DEFAULTS } from "../src/types.js";

const execFileAsync = promisify(execFile);
const server = createServer((request, response) => {
	if (request.url?.startsWith("/v1/models")) {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({ data: [{ id: "fixture-chat", name: "Fixture Chat" }] }),
		);
		return;
	}
	response.writeHead(404).end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

try {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-provider-host-e2e-"));
	await mkdir(join(agentDir, "cache"), { recursive: true });
	await writeFile(
		join(agentDir, "provider-discovery.json"),
		JSON.stringify({
			...DEFAULT_CONFIG,
			providers: [
				{
					id: "fixture",
					name: "Fixture",
					enabled: true,
					baseUrl: `http://localhost:${address.port}/v1`,
					api: "openai-completions",
					discovery: { format: "openai", path: "/models", timeoutMs: 5_000 },
					credential: { kind: "env", value: "FIXTURE_API_KEY" },
					defaults: DEFAULT_MODEL_DEFAULTS,
					overrides: {},
				},
			],
		}),
		{ mode: 0o600 },
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		FIXTURE_API_KEY: "fixture-secret",
	};
	const commands: Array<[string, string[]]> = [
		["pi", ["-e", resolve("."), "--list-models"]],
		["omp", ["models", "--extension", resolve("."), "--json"]],
	];
	for (const [host, args] of commands) {
		const { stdout, stderr } = await execFileAsync(host, args, {
			env,
			timeout: 60_000,
		});
		assert.match(
			`${stdout}\n${stderr}`,
			/fixture-chat/,
			`${host} did not list the discovered model`,
		);
	}
	console.log("Pi and OMP listed fixture/fixture-chat");
} finally {
	await server[Symbol.asyncDispose]();
}
