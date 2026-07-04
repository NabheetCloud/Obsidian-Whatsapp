// Reads the local WhatsApp Desktop SQLite database (ChatStorage.sqlite).
//
// We use sql.js (SQLite compiled to WebAssembly) so there is no native .node
// binary to compile against Obsidian's Electron ABI — the wasm is inlined into
// main.js by esbuild's binary loader, so this works offline with no assets to
// ship. Node built-ins (fs/os/path) are available because the plugin is
// desktop-only.

/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument --
 * Desktop-only module: it reads local SQLite files using Node's built-in `fs`,
 * `os`, and `path`. Under the review linter's TypeScript program these built-ins
 * resolve to `any` (its project does not load @types/node), so calls like
 * `readFileSync`, `copyFileSync`, and `new SQL.Database(...)` trip the type-aware
 * no-unsafe-* rules even though the code is correctly typed. The plugin's own
 * `tsc` build loads @types/node and type-checks this file cleanly, so these are
 * false positives specific to the linter's setup. */
import initSqlJs from "sql.js";
import wasmBinary from "sql.js/dist/sql-wasm.wasm";

import { copyFileSync, existsSync, accessSync, constants, rmSync, statSync, readFileSync, mkdtempSync } from "fs";
import { homedir, tmpdir, platform } from "os";
import { join, dirname } from "path";

import { RawMessage } from "./types";
import { info, debug, warn } from "./log";

type SqlStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlStatic["Database"]>;

let sqlPromise: Promise<SqlStatic> | null = null;

function getSql(): Promise<SqlStatic> {
	// sql.js accepts a Uint8Array at runtime; its types declare ArrayBuffer.
	if (!sqlPromise) sqlPromise = initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
	return sqlPromise;
}

/** Candidate ChatStorage.sqlite locations for the current OS. */
export function defaultDbPaths(): string[] {
	const home = homedir();
	switch (platform()) {
		case "darwin":
			return [
				join(home, "Library", "Group Containers", "group.net.whatsapp.WhatsApp.shared", "ChatStorage.sqlite"),
			];
		case "win32":
			return [join(home, "AppData", "Roaming", "WhatsApp", "Databases", "ChatStorage.sqlite")];
		case "linux":
			return [join(home, ".local", "share", "whatsapp", "ChatStorage.sqlite")];
		default:
			return [];
	}
}

/** Resolve the DB path: explicit override wins, else first existing default. */
export function resolveDbPath(override: string): string | null {
	const candidates = override.trim() ? [override.trim()] : defaultDbPaths();
	for (const path of candidates) {
		if (!existsSync(path)) {
			debug(`db: not found at ${path}`);
			continue;
		}
		try {
			accessSync(path, constants.R_OK);
			return path;
		} catch {
			warn(`db: exists but not readable: ${path}`);
		}
	}
	return null;
}

/**
 * Locate ContactsV2.sqlite — WhatsApp's saved-address-book store, which lives
 * beside ChatStorage.sqlite in the same container. It holds the display names
 * you saved plus the @lid → phone-number bridge, so it is the best source of
 * human sender names in LID-based builds. Returns null if absent/unreadable
 * (names then fall back to profile push-names + phone numbers).
 */
export function resolveContactsDbPath(chatStoragePath: string): string | null {
	const path = join(dirname(chatStoragePath), "ContactsV2.sqlite");
	if (!existsSync(path)) {
		debug(`db: ContactsV2.sqlite not found next to ${chatStoragePath}`);
		return null;
	}
	try {
		accessSync(path, constants.R_OK);
		return path;
	} catch {
		warn(`db: ContactsV2.sqlite exists but not readable: ${path}`);
		return null;
	}
}

type Cell = string | number | Uint8Array | null;

function str(v: Cell): string | null {
	return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** True for opaque base64/id-like tokens that must never be shown as a name. */
export function looksOpaque(value: string): boolean {
	const v = value.trim();
	if (!v) return true;
	// Base64 padding — a real name never ends in '=' (catches short tokens too).
	if (v.endsWith("=")) return true;
	// Long, space-free base64/id-ish run.
	if (/^[A-Za-z0-9+/_-]{16,}$/.test(v) && !/\s/.test(v)) return true;
	// Contains no letters at all (pure digits/symbols) — an id, not a name.
	if (!/[A-Za-z]/.test(v)) return true;
	return false;
}

/** FNV-1a 32-bit → base36 — a short, stable id derived from an opaque token. */
function shortHash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/**
 * Turn a JID into a clean, stable sender label:
 *   - "9198…@s.whatsapp.net" → "+9198…" (a real phone number)
 *   - "244…@lid"             → "Member-<hash>" (privacy LID — the raw 15-digit
 *                              id is never shown; the hash is stable so the same
 *                              person keeps the same label across syncs)
 * Returns null when there are no usable identifier characters.
 */
export function labelFromJid(jid: string | null): string | null {
	if (!jid) return null;
	const local = (jid.split("@")[0] ?? jid).trim();
	if (!local) return null;
	// Real phone-number JID → "+<digits>".
	if (jid.includes("s.whatsapp.net")) {
		const digits = local.replace(/[^0-9]/g, "");
		return digits ? `+${digits}` : null;
	}
	// Privacy Linked ID → stable placeholder, never the raw id.
	if (jid.includes("@lid")) return `Member-${shortHash(local)}`;
	// Unknown suffix: treat a bare number as a phone, otherwise hash it.
	if (/^[0-9+]+$/.test(local)) return `+${local.replace(/[^0-9]/g, "")}`;
	return `Member-${shortHash(local)}`;
}

/**
 * A JID → display-name / phone index built once per sync from the two stores
 * that actually hold names in LID-based builds:
 *   - ZWAPROFILEPUSHNAME (inside ChatStorage) — self-set profile names, keyed
 *     directly by @lid or phone JID.
 *   - ContactsV2's ZWAADDRESSBOOKCONTACT — the names you saved, keyed by BOTH
 *     the @lid and the phone JID, plus the phone number itself.
 * ZWAGROUPMEMBER.ZCONTACTNAME/ZFIRSTNAME are empty in these builds and are not
 * consulted.
 */
export interface NameIndex {
	/** Best display name, keyed by full JID (@lid or …@s.whatsapp.net). */
	nameByJid: Map<string, string>;
	/** "+phone" keyed by JID, from saved contacts (bridges @lid → number). */
	phoneByJid: Map<string, string>;
	contacts: number;
	pushNames: number;
}

function buildNameIndex(chatDb: SqlDatabase, contactsDb: SqlDatabase | null): NameIndex {
	const nameByJid = new Map<string, string>();
	const phoneByJid = new Map<string, string>();
	let pushNames = 0;
	let contacts = 0;

	// (1) Self-set profile push-names (lower priority) — keyed by @lid or phone.
	try {
		const res = chatDb.exec(
			"SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME WHERE ZJID IS NOT NULL AND ZPUSHNAME IS NOT NULL",
		);
		for (const row of res[0]?.values ?? []) {
			const jid = String(row[0]);
			const name = String(row[1]).trim();
			if (jid && name && !looksOpaque(name)) {
				nameByJid.set(jid, name);
				pushNames++;
			}
		}
	} catch {
		/* ZWAPROFILEPUSHNAME absent in this build — skip */
	}

	// (2) Saved address-book contacts (higher priority — overwrite push-names).
	if (contactsDb) {
		try {
			const res = contactsDb.exec(
				"SELECT ZLID, ZWHATSAPPID, ZPHONENUMBER, ZFULLNAME, ZGIVENNAME, ZBUSINESSNAME FROM ZWAADDRESSBOOKCONTACT",
			);
			for (const row of res[0]?.values ?? []) {
				const lid = str(row[0]);
				const waid = str(row[1]);
				const phone = str(row[2]);
				const name = str(row[3]) ?? str(row[4]) ?? str(row[5]);
				const phoneLabel = phone
					? phone.startsWith("+")
						? phone
						: `+${phone.replace(/[^0-9]/g, "")}`
					: null;
				let counted = false;
				for (const key of [lid, waid]) {
					if (!key) continue;
					if (name && !looksOpaque(name)) {
						nameByJid.set(key, name);
						if (!counted) {
							contacts++;
							counted = true;
						}
					}
					if (phoneLabel) phoneByJid.set(key, phoneLabel);
				}
			}
		} catch {
			/* ZWAADDRESSBOOKCONTACT shape changed — skip, fall back to push-names */
		}
	}

	return { nameByJid, phoneByJid, contacts, pushNames };
}

/**
 * Resolve a sender label from the name index, in priority order:
 *   saved contact name → profile push-name → +phone (contact bridge or phone
 *   JID) → stable "Member-<hash>" placeholder. Returns null only when neither a
 *   group member JID nor a from-JID is present (personal chats / own messages,
 *   where the caller substitutes the partner or own-name label).
 */
function resolveSenderLabel(memberJid: Cell, fromJid: Cell, index: NameIndex): string | null {
	const jids = [str(memberJid), str(fromJid)].filter((j): j is string => !!j);
	if (!jids.length) return null;
	// 1+2) A real name (contact wins over push-name; index already merged that).
	for (const j of jids) {
		const n = index.nameByJid.get(j);
		if (n) return n;
	}
	// 3a) A phone number bridged from a saved contact row (covers @lid senders).
	for (const j of jids) {
		const p = index.phoneByJid.get(j);
		if (p) return p;
	}
	// 3b) A JID that is itself a phone number.
	for (const j of jids) {
		const l = labelFromJid(j);
		if (l?.startsWith("+")) return l;
	}
	// 4) Last resort — stable placeholder for an unknown @lid sender.
	for (const j of jids) {
		const l = labelFromJid(j);
		if (l) return l;
	}
	return null;
}

/**
 * Copy a DB into a private, per-run temp directory and open it read-only (never
 * touch the live file). `mkdtempSync` creates the directory with an unguessable
 * name and owner-only (0700) permissions, so the copied database — which holds
 * your messages/contacts — is never world-readable (e.g. in a shared /tmp on
 * Linux) and can't be pre-created or symlinked by another local user.
 */
function openSnapshot(SQL: SqlStatic, dbPath: string, tag: string): { db: SqlDatabase; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), `wa-${tag}-`));
	const file = join(dir, "snapshot.sqlite");
	copyFileSync(dbPath, file);
	const sizeMb = Math.round(statSync(file).size / (1024 * 1024));
	debug(`db: copied ${sizeMb} MB snapshot to ${file}`);
	return { db: new SQL.Database(readFileSync(file)), dir };
}

/** Close a snapshot and best-effort delete its private temp directory. */
function closeSnapshot(snap: { db: SqlDatabase | null; dir: string }): void {
	if (snap.db) snap.db.close();
	if (!snap.dir) return;
	try {
		rmSync(snap.dir, { recursive: true, force: true });
	} catch {
		/* best-effort temp cleanup */
	}
}

export interface ProbeResult {
	total: number;
	/** Whether ContactsV2.sqlite was found beside ChatStorage. */
	hasContactsDb: boolean;
	/** Saved contact names loaded from ContactsV2. */
	contacts: number;
	/** Profile push-names loaded from ZWAPROFILEPUSHNAME. */
	pushNames: number;
	/** A few resolved recent group senders, for a sanity check. */
	samples: string[];
}

/**
 * Validate connectivity without writing anything, build the name index, and
 * resolve a few recent group senders so the user can confirm names come out
 * readable. Throws the SQLite error if the core tables/columns are missing.
 */
export async function probeDatabase(dbPath: string): Promise<ProbeResult> {
	const SQL = await getSql();
	const chat: { db: SqlDatabase | null; dir: string } = { db: null, dir: "" };
	const contacts: { db: SqlDatabase | null; dir: string } = { db: null, dir: "" };
	try {
		const c = openSnapshot(SQL, dbPath, "probe");
		chat.db = c.db;
		chat.dir = c.dir;

		const contactsPath = resolveContactsDbPath(dbPath);
		if (contactsPath) {
			const cc = openSnapshot(SQL, contactsPath, "probe-contacts");
			contacts.db = cc.db;
			contacts.dir = cc.dir;
		}

		const index = buildNameIndex(chat.db, contacts.db);

		const countRes = chat.db.exec("SELECT COUNT(*) FROM ZWAMESSAGE WHERE ZTEXT IS NOT NULL");
		const total = Number(countRes[0]?.values?.[0]?.[0] ?? 0);

		const stmt = chat.db.prepare(`
			SELECT gm.ZMEMBERJID AS member_jid, m.ZFROMJID AS from_jid, m.ZTEXT AS text
			FROM ZWAMESSAGE m
			JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
			LEFT JOIN ZWAGROUPMEMBER gm ON m.ZGROUPMEMBER = gm.Z_PK
			WHERE m.ZTEXT IS NOT NULL AND s.ZCONTACTJID LIKE '%@g.us'
			ORDER BY m.ZMESSAGEDATE DESC
			LIMIT 8
		`);
		const samples: string[] = [];
		while (stmt.step()) {
			const r = stmt.getAsObject() as Record<string, Cell>;
			const who = resolveSenderLabel(r.member_jid, r.from_jid, index);
			const jid = str(r.member_jid) ?? str(r.from_jid);
			samples.push(`${JSON.stringify(who)}  ←  ${JSON.stringify(jid)}  "${String(r.text ?? "").slice(0, 24)}"`);
		}
		stmt.free();

		info(`probe: ${total} text messages; ${index.contacts} saved contact(s); ${index.pushNames} profile push-name(s)`);
		info(
			contactsPath
				? `probe: ContactsV2.sqlite = ${contactsPath}`
				: "probe: ContactsV2.sqlite NOT FOUND — names limited to push-names + phone numbers",
		);
		for (const s of samples) info(`probe sample: ${s}`);

		return { total, hasContactsDb: !!contactsPath, contacts: index.contacts, pushNames: index.pushNames, samples };
	} finally {
		closeSnapshot(chat);
		closeSnapshot(contacts);
	}
}

/**
 * Read all text messages newer than `sinceMac` (Mac absolute time), ordered
 * oldest-first so callers can append them chronologically. Copies the DB to a
 * temp file first so we never read a file WhatsApp is mid-write on.
 */
export async function readMessagesSince(dbPath: string, sinceMac: number): Promise<RawMessage[]> {
	const SQL = await getSql();

	const chat: { db: SqlDatabase | null; dir: string } = { db: null, dir: "" };
	const contacts: { db: SqlDatabase | null; dir: string } = { db: null, dir: "" };
	try {
		const c = openSnapshot(SQL, dbPath, "chatstorage");
		chat.db = c.db;
		chat.dir = c.dir;

		// Open the saved-contacts store too (best source of human names).
		const contactsPath = resolveContactsDbPath(dbPath);
		if (contactsPath) {
			const cc = openSnapshot(SQL, contactsPath, "contacts");
			contacts.db = cc.db;
			contacts.dir = cc.dir;
		}

		const index = buildNameIndex(chat.db, contacts.db);
		info(
			`WhatsApp: name index — ${index.contacts} saved contact(s), ${index.pushNames} profile name(s)` +
				(contactsPath ? "." : "; ContactsV2.sqlite not found, names limited to push-names + phone."),
		);

		// Names live in ZWAPROFILEPUSHNAME / ContactsV2 (see buildNameIndex);
		// ZWAGROUPMEMBER only supplies the sender's @lid via ZMEMBERJID.
		const sql = `
			SELECT
				m.Z_PK AS pk,
				s.ZCONTACTJID AS jid,
				COALESCE(s.ZPARTNERNAME, s.ZCONTACTJID) AS chat_name,
				gm.ZMEMBERJID AS member_jid,
				m.ZFROMJID AS from_jid,
				m.ZTEXT AS text,
				m.ZMESSAGEDATE AS mac_date,
				m.ZISFROMME AS from_me
			FROM ZWAMESSAGE m
			JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
			LEFT JOIN ZWAGROUPMEMBER gm ON m.ZGROUPMEMBER = gm.Z_PK
			WHERE m.ZTEXT IS NOT NULL AND m.ZMESSAGEDATE > $since
			ORDER BY m.ZMESSAGEDATE ASC
		`;

		const stmt = chat.db.prepare(sql);
		stmt.bind({ $since: sinceMac });

		const out: RawMessage[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as Record<string, Cell>;
			const jid = typeof row.jid === "string" ? row.jid : "";
			if (!jid) continue;
			out.push({
				pk: Number(row.pk),
				jid,
				chatName: typeof row.chat_name === "string" ? row.chat_name : jid,
				sender: resolveSenderLabel(row.member_jid, row.from_jid, index),
				text: typeof row.text === "string" ? row.text : String(row.text ?? ""),
				macDate: Number(row.mac_date),
				fromMe: Number(row.from_me) === 1,
			});
		}
		stmt.free();
		info(`WhatsApp: read ${out.length} message(s) from the database.`);
		return out;
	} finally {
		closeSnapshot(chat);
		closeSnapshot(contacts);
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- Closes the file-scoped disable for the Node-interop code above. */
