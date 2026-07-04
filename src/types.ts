// Shared types and defaults for the WhatsApp Local Sync plugin.

export interface PluginSettings {
	// --- Database ---
	/**
	 * Absolute path to WhatsApp's `ChatStorage.sqlite`. Empty = auto-detect the
	 * platform default (macOS group container / Windows AppData / Linux share).
	 */
	dbPathOverride: string;

	// --- Vault layout ---
	/** Root vault folder for all WhatsApp notes, e.g. "11-Whatsapp". */
	targetFolder: string;
	/** Subfolder (under targetFolder) for group-chat transcripts. */
	groupsSubfolder: string;
	/** Subfolder (under targetFolder) for personal (1:1) chat transcripts. */
	personalSubfolder: string;

	// --- What to sync ---
	syncGroups: boolean;
	syncPersonal: boolean;
	/**
	 * Only mirror messages from the last N days (0 = all history). Bounds the
	 * SQL window; per-chat dedup by row id handles incremental appends.
	 */
	maxDaysBack: number;
	/** Hard floor date (YYYY-MM-DD). Empty = no floor. */
	syncSince: string;
	/** Label used for messages you sent (WhatsApp stores no name for "me"). */
	ownName: string;

	// --- Sync behaviour ---
	/** Auto-sync interval in minutes. 0 disables the timer. */
	syncIntervalMinutes: number;
	/** Run a sync when Obsidian starts. */
	syncOnStartup: boolean;
	/** Verbose `[whatsapp]` console logging. */
	debugLogging: boolean;

	// --- Persisted runtime state (not user-editable in the UI) ---
	/** Per-conversation bookkeeping, keyed by WhatsApp JID (ZCONTACTJID). */
	chats: Record<string, ChatState>;
	/** ISO timestamp of the last successful sync. */
	lastSync: string | null;
}

/** Per-conversation incremental state. Message bodies live in the note file. */
export interface ChatState {
	jid: string;
	name: string;
	kind: "group" | "personal";
	notePath: string;
	/** Highest ZWAMESSAGE.Z_PK already written — the incremental cursor. */
	lastRowPk: number;
	/** ISO of the most recent message written (for index sorting). */
	lastActivityIso: string;
	/** YYYY-MM-DD of the last day header written into the transcript. */
	lastDateHeader: string;
	messageCount: number;
}

/** A single text message read from the WhatsApp SQLite database. */
export interface RawMessage {
	/** ZWAMESSAGE.Z_PK — monotonic rowid, used as the incremental cursor. */
	pk: number;
	/** ZWACHATSESSION.ZCONTACTJID — the stable chat identifier (e.g. "…@g.us"). */
	jid: string;
	/** Display name of the chat (partner name or JID fallback). */
	chatName: string;
	/**
	 * Resolved sender label for group messages: saved contact name → profile
	 * push-name → +phone → stable "Member-<hash>". Null only when no sender JID
	 * is present (own messages) — the caller substitutes the own-name / partner
	 * label.
	 */
	sender: string | null;
	/** ZWAMESSAGE.ZTEXT — message body (rows with null text are skipped). */
	text: string;
	/** ZWAMESSAGE.ZMESSAGEDATE — Mac absolute time (seconds since 2001-01-01). */
	macDate: number;
	/** ZWAMESSAGE.ZISFROMME — true when you sent it. */
	fromMe: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	dbPathOverride: "",
	targetFolder: "11-Whatsapp",
	groupsSubfolder: "Groups",
	personalSubfolder: "Personal",
	syncGroups: true,
	syncPersonal: true,
	maxDaysBack: 30,
	syncSince: "",
	ownName: "Me",
	syncIntervalMinutes: 30,
	syncOnStartup: false,
	debugLogging: false,
	chats: {},
	lastSync: null,
};
