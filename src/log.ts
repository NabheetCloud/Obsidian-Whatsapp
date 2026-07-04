// Logging split into an always-on baseline path (`info`) and a debug-gated
// verbose path (`debug`). The baseline lines let a user tell a slow-but-working
// sync from a genuinely stuck one without turning on the debug toggle.

const PREFIX = "[whatsapp]";

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
	debugEnabled = enabled;
}

/** Always printed. Sync start/finish, per-chat progress, final summary. */
export function info(message: string): void {
	console.log(`${PREFIX} ${message}`);
}

/** Printed only when Debug logging is on. Per-message / per-row detail. */
export function debug(message: string): void {
	if (debugEnabled) console.log(`${PREFIX} ${message}`);
}

export function warn(message: string): void {
	console.warn(`${PREFIX} ${message}`);
}

export function errorLog(message: string, err?: unknown): void {
	const normalized = err instanceof Error ? err : err === undefined ? undefined : new Error(String(err));
	if (normalized) console.error(`${PREFIX} ${message}`, normalized);
	else console.error(`${PREFIX} ${message}`);
}
