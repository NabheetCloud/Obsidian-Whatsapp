// Sync orchestration: read the WhatsApp DB once, group messages by chat,
// append only rows newer than each chat's stored cursor (Z_PK), and regenerate
// the conversation index. Per-chat writes are isolated so one bad chat cannot
// abort the whole run.

import { Vault } from "obsidian";

import { PluginSettings, ChatState, RawMessage } from "./types";
import { resolveDbPath, readMessagesSince } from "./db";
import { macTimeToDate, dateToMacTime } from "./mactime";
import { hashId, sanitizeName, yamlQuote, ensureFolder, appendToNote, writeFile } from "./notes";
import { info, debug, warn } from "./log";

export interface SyncSummary {
	chatsTouched: number;
	messagesWritten: number;
	errors: number;
}

export interface SyncOptions {
	shouldCancel: () => boolean;
	onProgress?: (done: number, total: number) => void;
}

interface Grouped {
	jid: string;
	kind: "group" | "personal";
	name: string;
	messages: RawMessage[];
}

/** Classify a WhatsApp JID; returns null for status/broadcast pseudo-chats. */
function classify(jid: string): "group" | "personal" | null {
	if (jid.endsWith("@g.us")) return "group";
	const lower = jid.toLowerCase();
	if (lower.includes("status") || lower.includes("broadcast")) return null;
	return "personal";
}

/** Compute the lower bound (Mac absolute time) for this run's SQL window. */
function windowStartMac(settings: PluginSettings): number {
	const bounds: number[] = [];
	if (settings.maxDaysBack > 0) {
		bounds.push(dateToMacTime(new Date(Date.now() - settings.maxDaysBack * 86_400_000)));
	}
	if (settings.syncSince.trim()) {
		const floor = new Date(`${settings.syncSince.trim()}T00:00:00Z`);
		if (!Number.isNaN(floor.getTime())) bounds.push(dateToMacTime(floor));
	}
	// The widest window is the smallest lower bound; 0 (epoch) means "all".
	return bounds.length ? Math.min(...bounds) : 0;
}

function two(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}
function dayString(d: Date): string {
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
function timeString(d: Date): string {
	return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function senderLabel(msg: RawMessage, chatName: string, ownName: string, kind: "group" | "personal"): string {
	if (msg.fromMe) return ownName;
	if (msg.sender && msg.sender.trim()) return msg.sender.trim();
	return kind === "personal" ? chatName : "Unknown";
}

function noteHeader(name: string, jid: string, kind: "group" | "personal"): string {
	return (
		`---\n` +
		`source: whatsapp\n` +
		`chat_id: ${yamlQuote(jid)}\n` +
		`chat_name: ${yamlQuote(name)}\n` +
		`kind: ${kind}\n` +
		`---\n\n` +
		`# ${name}\n`
	);
}

export async function syncOnce(vault: Vault, settings: PluginSettings, opts: SyncOptions): Promise<SyncSummary> {
	const summary: SyncSummary = { chatsTouched: 0, messagesWritten: 0, errors: 0 };

	const dbPath = resolveDbPath(settings.dbPathOverride);
	if (!dbPath) {
		throw new Error(
			"WhatsApp database (ChatStorage.sqlite) not found. Open WhatsApp Desktop at least once, " +
				"or set the database path in the plugin settings.",
		);
	}
	info(`WhatsApp: reading database at ${dbPath}`);

	const sinceMac = windowStartMac(settings);
	const rows = await readMessagesSince(dbPath, sinceMac);
	if (opts.shouldCancel()) {
		info("WhatsApp: cancelled after read.");
		return summary;
	}

	// Group by chat, filtering out disabled kinds and status/broadcast.
	const groups = new Map<string, Grouped>();
	for (const row of rows) {
		const kind = classify(row.jid);
		if (!kind) continue;
		if (kind === "group" && !settings.syncGroups) continue;
		if (kind === "personal" && !settings.syncPersonal) continue;
		let g = groups.get(row.jid);
		if (!g) {
			g = { jid: row.jid, kind, name: row.chatName, messages: [] };
			groups.set(row.jid, g);
		}
		g.messages.push(row);
	}

	const targetRoot = settings.targetFolder.trim() || "11-Whatsapp";
	await ensureFolder(vault, targetRoot);
	await ensureFolder(vault, `${targetRoot}/${settings.groupsSubfolder}`);
	await ensureFolder(vault, `${targetRoot}/${settings.personalSubfolder}`);

	const total = groups.size;
	info(`WhatsApp: ${total} chat(s) with messages in window; writing new messages…`);

	let index = 0;
	for (const g of groups.values()) {
		index++;
		if (opts.shouldCancel()) {
			info("WhatsApp: cancelled mid-sync.");
			break;
		}
		opts.onProgress?.(index, total);

		try {
			const prior = settings.chats[g.jid];
			const lastPk = prior?.lastRowPk ?? 0;
			// Incremental dedup by rowid — exact even for same-second messages.
			const fresh = g.messages.filter((m) => m.pk > lastPk);
			debug(`chat ${index}/${total}: "${g.name}" — ${fresh.length} new of ${g.messages.length}`);
			if (fresh.length === 0) continue;

			info(`WhatsApp: chat ${index}/${total}: "${g.name}" — +${fresh.length} message(s)`);

			const subfolder = g.kind === "group" ? settings.groupsSubfolder : settings.personalSubfolder;
			const fileName = `${sanitizeName(g.name)} ${hashId(g.jid)}.md`;
			const notePath = `${targetRoot}/${subfolder}/${fileName}`;

			// Build the body, emitting a `## YYYY-MM-DD` header on each day change.
			let lastDay = prior?.lastDateHeader ?? "";
			let body = "";
			let maxPk = lastPk;
			let lastActivityIso = prior?.lastActivityIso ?? "";
			for (const m of fresh) {
				const when = macTimeToDate(m.macDate);
				const day = dayString(when);
				if (day !== lastDay) {
					body += `\n## ${day}\n\n`;
					lastDay = day;
				}
				const who = senderLabel(m, g.name, settings.ownName, g.kind);
				body += `**${timeString(when)}** — ${who}: ${m.text}\n\n`;
				if (m.pk > maxPk) maxPk = m.pk;
				lastActivityIso = when.toISOString();
			}

			await appendToNote(vault, notePath, noteHeader(g.name, g.jid, g.kind), body);

			const state: ChatState = {
				jid: g.jid,
				name: g.name,
				kind: g.kind,
				notePath,
				lastRowPk: maxPk,
				lastActivityIso,
				lastDateHeader: lastDay,
				messageCount: (prior?.messageCount ?? 0) + fresh.length,
			};
			settings.chats[g.jid] = state;
			summary.chatsTouched++;
			summary.messagesWritten += fresh.length;
		} catch (e) {
			summary.errors++;
			warn(`WhatsApp: failed to write chat "${g.name}" (${g.jid}): ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	try {
		await regenerateIndex(vault, settings, targetRoot);
	} catch (e) {
		warn(`WhatsApp: could not regenerate index: ${e instanceof Error ? e.message : String(e)}`);
	}

	info(
		`WhatsApp: sync done — ${summary.messagesWritten} message(s) across ${summary.chatsTouched} chat(s), ${summary.errors} error(s).`,
	);
	return summary;
}

/** Rewrite `_Conversation Index.md` from the persisted chat state. */
async function regenerateIndex(vault: Vault, settings: PluginSettings, targetRoot: string): Promise<void> {
	const all = Object.values(settings.chats).sort((a, b) => b.lastActivityIso.localeCompare(a.lastActivityIso));
	const groups = all.filter((c) => c.kind === "group");
	const personal = all.filter((c) => c.kind === "personal");

	const line = (c: ChatState): string => {
		const link = c.notePath.replace(/\.md$/, "");
		const when = c.lastActivityIso ? c.lastActivityIso.slice(0, 10) : "";
		return `- [[${link}|${c.name}]] — ${c.messageCount} msgs · ${when}`;
	};

	let md = `# WhatsApp — Conversation Index\n\n`;
	md += `_${all.length} conversation(s). Regenerated on each sync by the WhatsApp Local Sync plugin._\n\n`;
	md += `## Personal (${personal.length})\n\n`;
	md += personal.length ? personal.map(line).join("\n") : "_none yet_";
	md += `\n\n## Groups (${groups.length})\n\n`;
	md += groups.length ? groups.map(line).join("\n") : "_none yet_";
	md += "\n";

	await writeFile(vault, `${targetRoot}/_Conversation Index.md`, md);
}
