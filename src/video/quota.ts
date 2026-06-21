export interface QuotaKv {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
}

export function quotaKey(date: string): string {
	return `youtube:quota:${date}`;
}

export async function getUsed(kv: QuotaKv, date: string): Promise<number> {
	const v = await kv.get<number>(quotaKey(date));
	return typeof v === "number" && v > 0 ? v : 0;
}

/**
 * Read-modify-write increment. Safe because the cron hook is dispatched
 * single-flight per plugin, so there is no concurrent writer for this key.
 */
export async function incrementUsed(kv: QuotaKv, date: string): Promise<number> {
	const next = (await getUsed(kv, date)) + 1;
	await kv.set(quotaKey(date), next);
	return next;
}

export async function hasQuota(kv: QuotaKv, date: string, dailyCap: number): Promise<boolean> {
	return (await getUsed(kv, date)) < dailyCap;
}
