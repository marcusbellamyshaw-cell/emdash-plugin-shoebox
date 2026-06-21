export type FetchFn = typeof fetch;

export interface YoutubeCreds {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Exchange a stored refresh token for a short-lived access token. */
export async function getAccessToken(creds: YoutubeCreds, fetchFn: FetchFn): Promise<string> {
	const body = new URLSearchParams({
		client_id: creds.clientId,
		client_secret: creds.clientSecret,
		refresh_token: creds.refreshToken,
		grant_type: "refresh_token",
	});
	const res = await fetchFn(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	if (!res.ok) {
		throw new Error(`oauth token refresh failed: ${res.status} ${await res.text().catch(() => "")}`);
	}
	const json = (await res.json()) as { access_token?: string };
	if (!json.access_token) throw new Error("oauth response missing access_token");
	return json.access_token;
}
