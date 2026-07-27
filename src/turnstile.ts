import type { RouteContext } from "emdash";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const REQUEST_TIMEOUT_MS = 6_000;

// Do NOT put an AbortSignal in ctx.http.fetch's init — it is not cloneable
// across the sandbox's RPC boundary ("DataCloneError: AbortSignal
// serialization is not enabled"). Use Promise.race for the timeout instead
// (see emdash-plugin-brevo's sendBrevoEmail for the same pattern).
export async function verifyTurnstile(token: string, secret: string, ctx: RouteContext, remoteIp?: string): Promise<boolean> {
	if (!token || !secret || !ctx.http) return false;
	const body = new URLSearchParams({ secret, response: token });
	if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Turnstile verification timed out")), REQUEST_TIMEOUT_MS);
	});
	const request = ctx.http.fetch(SITEVERIFY, { method: "POST", body });
	void request.then(() => {}, () => {});

	try {
		const res = await Promise.race([request, timeout]);
		if (!res.ok) return false;
		const data = (await res.json()) as { success?: boolean };
		return data.success === true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
