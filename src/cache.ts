/**
 * Purpose: Stores last-known-good public model metadata for resilient startup
 *          when a provider's discovery endpoint is unavailable.
 *
 * Public API: loadCache, saveCache, getCacheEntry, putCacheEntry, isCacheFresh.
 *
 * Upstream deps: node:fs/promises, node:path, ./types.
 *
 * Downstream consumers: discovery orchestration and tests.
 *
 * Failure modes: missing/corrupt cache degrades to an empty cache; failed atomic
 *                writes leave the prior cache intact. Secrets are never accepted.
 *
 * Performance: one small JSON read and at most one atomic write per startup.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiscoveredModel } from "./types.js";

export interface CacheEntry {
	endpoint: string;
	fetchedAt: string;
	models: DiscoveredModel[];
}

export interface CacheDocument {
	version: 1;
	entries: Record<string, CacheEntry>;
}

const EMPTY_CACHE: CacheDocument = { version: 1, entries: {} };

function validModel(value: unknown): value is DiscoveredModel {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const model = value as Record<string, unknown>;
	return (
		typeof model.id === "string" &&
		typeof model.name === "string" &&
		(model.api === "openai-completions" ||
			model.api === "openai-responses" ||
			model.api === "anthropic-messages") &&
		typeof model.reasoning === "boolean" &&
		Array.isArray(model.input) &&
		model.input.every((item) => item === "text" || item === "image") &&
		typeof model.contextWindow === "number" &&
		typeof model.maxTokens === "number" &&
		!!model.cost &&
		typeof model.cost === "object"
	);
}

function parseCache(value: unknown): CacheDocument {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { ...EMPTY_CACHE, entries: {} };
	const document = value as Record<string, unknown>;
	if (
		document.version !== 1 ||
		!document.entries ||
		typeof document.entries !== "object" ||
		Array.isArray(document.entries)
	) {
		return { ...EMPTY_CACHE, entries: {} };
	}
	const entries: Record<string, CacheEntry> = {};
	for (const [providerId, raw] of Object.entries(
		document.entries as Record<string, unknown>,
	)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw as Record<string, unknown>;
		if (
			typeof entry.endpoint === "string" &&
			typeof entry.fetchedAt === "string" &&
			!Number.isNaN(Date.parse(entry.fetchedAt)) &&
			Array.isArray(entry.models) &&
			entry.models.length > 0 &&
			entry.models.every(validModel)
		) {
			entries[providerId] = entry as unknown as CacheEntry;
		}
	}
	return { version: 1, entries };
}

export async function loadCache(path: string): Promise<CacheDocument> {
	try {
		return parseCache(JSON.parse(await readFile(path, "utf8")) as unknown);
	} catch {
		return { ...EMPTY_CACHE, entries: {} };
	}
}

export async function saveCache(
	path: string,
	cache: CacheDocument,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, path);
}

export function getCacheEntry(
	cache: CacheDocument,
	providerId: string,
	endpoint: string,
): CacheEntry | undefined {
	const entry = cache.entries[providerId];
	return entry?.endpoint === endpoint ? entry : undefined;
}

export function putCacheEntry(
	cache: CacheDocument,
	providerId: string,
	entry: CacheEntry,
): void {
	cache.entries[providerId] = entry;
}

export function isCacheFresh(
	entry: CacheEntry,
	ttlMs: number,
	now = Date.now(),
): boolean {
	return now - Date.parse(entry.fetchedAt) < ttlMs;
}
