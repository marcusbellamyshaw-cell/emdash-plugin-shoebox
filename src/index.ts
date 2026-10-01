import type { PluginDescriptor } from "emdash";

export { createPlugin } from "./sandbox-entry.js";

export function shoeboxPlugin(): PluginDescriptor {
	return {
		id: "ebt-shoebox",
		version: "1.5.1",
		entrypoint: "emdash-plugin-shoebox",
		options: {},
		capabilities: [
			"content:read",
			"content:write",
			"network:request",
			"hooks.page-fragments:register",
		],
		allowedHosts: ["api.brevo.com", "oauth2.googleapis.com", "www.googleapis.com", "upload.googleapis.com", "challenges.cloudflare.com"],
		// Composite indexes (e.g. ["ip","createdAt"]) are honored by the runtime
		// definePlugin path (see sandbox-entry.ts) but the PluginDescriptor.storage
		// type here only types single-column indexes, so cast to keep them while
		// staying tsc-clean. Keep in sync with the storage block in sandbox-entry.ts.
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
		} as unknown as PluginDescriptor["storage"],
		adminEntry: "emdash-plugin-shoebox/admin",
		adminPages: [
			{ path: "/settings", label: "Shoebox Settings", icon: "gear" },
			// "Review Submissions" queue removed — submissions are reviewed and published in Content → Community Submissions; publishing is the approval.
		],
		adminWidgets: [
			{ id: "shoebox-stats", title: "Shoebox Submissions", size: "third" },
		],
	};
}
