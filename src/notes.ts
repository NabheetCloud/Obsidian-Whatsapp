// Note writing: transcript files (one per chat) and the conversation index.
// Filenames derive from a stable hash of the full JID (never a suffix slice —
// distinct chats can share trailing JID characters), and every write is
// race-tolerant (create → fall back to append/modify if it already exists).

import { normalizePath, Vault, TFile } from "obsidian";

/** FNV-1a 32-bit → base36. Stable, collision-resistant for our id space. */
export function hashId(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** Make a string safe for use inside a vault file name. */
export function sanitizeName(name: string): string {
	return (
		name
			// characters illegal in file names or that break wiki-links
			.replace(/[\\/:*?"<>|#^[\]]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 80) || "chat"
	);
}

/** Escape a value for safe use inside a double-quoted YAML scalar. */
export function yamlQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Ensure a vault folder exists (idempotent). */
export async function ensureFolder(vault: Vault, folder: string): Promise<void> {
	const path = normalizePath(folder);
	if (path === "" || path === "/") return;
	if (await vault.adapter.exists(path)) return;
	try {
		await vault.createFolder(path);
	} catch {
		// createFolder throws if it already exists (race); ignore.
	}
}

/**
 * Append `body` to `path`, creating the file (with `header` prepended) if it
 * does not exist yet. Tolerant of create/append races.
 */
export async function appendToNote(vault: Vault, path: string, header: string, body: string): Promise<void> {
	const normalized = normalizePath(path);
	if (await vault.adapter.exists(normalized)) {
		await vault.adapter.append(normalized, body);
		return;
	}
	try {
		await vault.create(normalized, header + body);
	} catch {
		// Lost a create race — the file now exists, so append instead.
		if (await vault.adapter.exists(normalized)) {
			await vault.adapter.append(normalized, body);
		} else {
			throw new Error(`Could not create or append note: ${normalized}`);
		}
	}
}

/** Overwrite (or create) a whole file — used for the regenerated index. */
export async function writeFile(vault: Vault, path: string, content: string): Promise<void> {
	const normalized = normalizePath(path);
	const existing = vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFile) {
		await vault.modify(existing, content);
		return;
	}
	try {
		await vault.create(normalized, content);
	} catch {
		const retry = vault.getAbstractFileByPath(normalized);
		if (retry instanceof TFile) await vault.modify(retry, content);
		else throw new Error(`Could not write file: ${normalized}`);
	}
}
