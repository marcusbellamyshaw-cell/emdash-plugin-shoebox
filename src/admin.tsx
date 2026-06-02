import type { PluginAdminExports } from "emdash";
import { Settings } from "./components/Settings.js";
import { StatsWidget } from "./components/StatsWidget.js";
import { Queue } from "./components/Queue.js";

export const pages: PluginAdminExports["pages"] = {
	"/settings": Settings,
	"/submissions": Queue,
};
export const widgets: PluginAdminExports["widgets"] = {
	"shoebox-stats": StatsWidget,
};
