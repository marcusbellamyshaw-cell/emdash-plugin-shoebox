import type { PluginDescriptor } from "emdash";

export { createPlugin } from "./sandbox-entry.js";

export function shoeboxPlugin(): PluginDescriptor {
	return {
		id: "ebt-shoebox",
		version: "1.0.0",
		entrypoint: "ebt-plugin-shoebox",
		options: {},
		capabilities: [
			"content:read",
			"content:write",
			"media:read",
			"media:write",
			"network:request:unrestricted",
			"email:send",
			"hooks.page-fragments:register",
		],
		allowedHosts: [
			"api.cloudflare.com",
			"api.brevo.com",
			"r2.cloudflarestorage.com",
		],
		storage: {
			sessions: {
				indexes: ["ip", "status", "createdAt", ["ip", "status"]],
			},
			submissions: {
				indexes: ["ip", "status", "createdAt", "textHash", ["ip", "createdAt"]],
			},
			analytics: {
				indexes: ["event", "date", ["event", "date"]],
			},
		},
		adminEntry: "ebt-plugin-shoebox/admin",
		adminPages: [
			{ path: "/settings", label: "Shoebox Settings", icon: "gear" },
			{ path: "/submissions", label: "Review Submissions", icon: "inbox" },
		],
		adminWidgets: [
			{ id: "shoebox-stats", title: "Shoebox Submissions", size: "third" },
		],
	};
}
