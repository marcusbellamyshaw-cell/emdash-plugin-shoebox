import type { PluginAdminExports } from "emdash";
import { Settings } from "./components/Settings.js";
import { StatsWidget } from "./components/StatsWidget.js";

// The "Review Submissions" queue (Queue.tsx) was removed: submissions are
// reviewed and published directly in Content → Community Submissions, so the
// plugin no longer registers a queue page.
export const pages: PluginAdminExports["pages"] = {
	"/settings": Settings,
};
export const widgets: PluginAdminExports["widgets"] = {
	"shoebox-stats": StatsWidget,
};
