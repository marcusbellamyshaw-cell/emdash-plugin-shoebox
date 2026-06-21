#!/usr/bin/env node
// One-time helper: mint a YouTube refresh token for the EBT channel.
// Usage: YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... node scripts/youtube-consent.mjs
// Uses the OAuth "out-of-band"/loopback flow. Requires a Desktop-app OAuth client.

import http from "node:http";
import { URL } from "node:url";
import { exec } from "node:child_process";

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
	console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET first.");
	process.exit(1);
}

const PORT = 53682;
const redirectUri = `http://127.0.0.1:${PORT}`;
const scope = "https://www.googleapis.com/auth/youtube.upload";
const authUrl =
	`https://accounts.google.com/o/oauth2/v2/auth?response_type=code` +
	`&client_id=${encodeURIComponent(clientId)}` +
	`&redirect_uri=${encodeURIComponent(redirectUri)}` +
	`&scope=${encodeURIComponent(scope)}` +
	`&access_type=offline&prompt=consent`;

const server = http.createServer(async (req, res) => {
	const code = new URL(req.url, redirectUri).searchParams.get("code");
	if (!code) {
		res.writeHead(400).end("No code");
		return;
	}
	res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Done. You can close this tab.</p>");
	server.close();
	const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		}).toString(),
	});
	const json = await tokenRes.json();
	if (!json.refresh_token) {
		console.error("No refresh_token returned. Revoke prior access and retry with prompt=consent.", json);
		process.exit(1);
	}
	console.log("\nRefresh token:\n" + json.refresh_token + "\n");
	console.log("Store it as a Worker secret:\n  wrangler secret put YOUTUBE_REFRESH_TOKEN");
	process.exit(0);
});

server.listen(PORT, () => {
	console.log("Opening browser for consent…\n" + authUrl);
	const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
	exec(`${cmd} "${authUrl}"`);
});
