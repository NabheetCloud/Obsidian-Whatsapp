// WhatsApp (a Core Data app) stores timestamps as "Mac absolute time":
// seconds since 2001-01-01 00:00:00 UTC. Convert to/from JS Date here.

const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);

/** Mac absolute time (seconds) → JS Date. */
export function macTimeToDate(mac: number): Date {
	return new Date(MAC_EPOCH_MS + mac * 1000);
}

/** JS Date → Mac absolute time (seconds). */
export function dateToMacTime(date: Date): number {
	return (date.getTime() - MAC_EPOCH_MS) / 1000;
}
