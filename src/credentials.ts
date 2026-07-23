/**
 * Purpose: Resolves credential/header references for discovery and translates
 *          canonical references into Pi- or OMP-compatible runtime values.
 *
 * Public API: resolveCredential, resolveHeaderValues, toHostCredential,
 *             toHostHeaders, detectHost, executeCredentialCommand.
 *
 * Upstream deps: node:child_process, ./types.
 *
 * Downstream consumers: discovery pipeline, provider registration, diagnostics,
 *                       and tests.
 *
 * Failure modes: missing env vars, failed commands, empty command output, or
 *                timeouts throw redacted errors that never include secret values.
 *
 * Performance: environment references are constant-time; commands are bounded
 *              to 10 seconds and 64 KiB stdout.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialReference, HostKind } from "./types.js";

const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const BRACED_ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const execAsync = promisify(exec);

export async function executeCredentialCommand(
	command: string,
): Promise<string> {
	try {
		const { stdout } = await execAsync(command, {
			timeout: 10_000,
			maxBuffer: 64 * 1024,
			windowsHide: true,
		});
		const value = stdout.trim();
		if (!value) throw new Error("empty");
		return value;
	} catch {
		throw new Error(
			"credential command failed, timed out, or returned empty output",
		);
	}
}

export async function resolveCredential(
	reference: CredentialReference,
	env: NodeJS.ProcessEnv = process.env,
	runCommand: (command: string) => Promise<string> = executeCredentialCommand,
): Promise<string | undefined> {
	if (reference.kind === "none") return undefined;
	if (reference.kind === "command") return runCommand(reference.value);
	const value = env[reference.value];
	if (!value)
		throw new Error(
			`credential environment variable ${reference.value} is not set`,
		);
	return value;
}

async function resolveHeaderValue(
	value: string,
	env: NodeJS.ProcessEnv,
	runCommand: (command: string) => Promise<string>,
): Promise<string> {
	if (value.startsWith("!")) return runCommand(value.slice(1).trim());
	const variable =
		ENV_REFERENCE.exec(value)?.[1] ?? BRACED_ENV_REFERENCE.exec(value)?.[1];
	if (!variable) return value;
	const resolved = env[variable];
	if (!resolved)
		throw new Error(`header environment variable ${variable} is not set`);
	return resolved;
}

export async function resolveHeaderValues(
	headers: Record<string, string> | undefined,
	env: NodeJS.ProcessEnv = process.env,
	runCommand: (command: string) => Promise<string> = executeCredentialCommand,
): Promise<Record<string, string>> {
	const output: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		output[name] = await resolveHeaderValue(value, env, runCommand);
	}
	return output;
}

export function detectHost(extensionApi: object): HostKind {
	return "unregisterProvider" in extensionApi ? "pi" : "omp";
}

export function toHostCredential(
	reference: CredentialReference,
	host: HostKind,
): string {
	if (reference.kind === "none") return "unused";
	if (reference.kind === "command") return `!${reference.value}`;
	return host === "pi" ? `$${reference.value}` : reference.value;
}

export function toHostHeaders(
	headers: Record<string, string> | undefined,
	host: HostKind,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const output: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const variable =
			ENV_REFERENCE.exec(value)?.[1] ?? BRACED_ENV_REFERENCE.exec(value)?.[1];
		output[name] = host === "omp" && variable ? variable : value;
	}
	return output;
}
