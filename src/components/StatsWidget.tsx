import * as React from "react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";

const API = "/_emdash/api/plugins/ebt-shoebox";

interface Stats {
	opened: number;
	completed: number;
	pending: number;
}

export function StatsWidget() {
	const [stats, setStats] = React.useState<Stats | null>(null);
	const [error, setError] = React.useState<string | null>(null);

	React.useEffect(() => {
		apiFetch(`${API}/analytics/stats`)
			.then((res) => parseApiResponse<Stats>(res, "Failed to load stats"))
			.then(setStats)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load"));
	}, []);

	if (error) {
		return (
			<div style={{ color: "var(--kumo-danger, #dc2626)", fontSize: 14, padding: "8px 0" }}>
				{error}
			</div>
		);
	}

	if (!stats) {
		return (
			<div style={{ color: "var(--kumo-subtle, #6b7280)", fontSize: 14, padding: "8px 0" }}>
				Loading…
			</div>
		);
	}

	const conversionRate = stats.opened > 0
		? Math.round((stats.completed / stats.opened) * 100)
		: 0;

	return (
		<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
			<Stat label="Pending Review" value={stats.pending} highlight />
			<Stat label="Submitted" value={stats.completed} />
			<Stat label="Widget Opens" value={stats.opened} />
			<div style={{ gridColumn: "1 / -1" }}>
				<div style={{ fontSize: 12, color: "var(--kumo-subtle, #6b7280)", marginBottom: 4 }}>
					Submission Rate
				</div>
				<div style={{ height: 6, background: "var(--kumo-muted, #e5e7eb)", borderRadius: 3, overflow: "hidden" }}>
					<div
						style={{
							height: "100%",
							width: `${conversionRate}%`,
							background: "var(--kumo-brand, #f59e0b)",
							borderRadius: 3,
							transition: "width 0.5s ease",
						}}
					/>
				</div>
				<div style={{ fontSize: 12, color: "var(--kumo-subtle, #6b7280)", marginTop: 4 }}>
					{conversionRate}% of widget opens become submissions
				</div>
			</div>
		</div>
	);
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
	return (
		<div>
			<div
				style={{
					fontSize: 28,
					fontWeight: 700,
					color: highlight ? "var(--kumo-brand, #f59e0b)" : "var(--kumo-foreground, #111827)",
					lineHeight: 1,
				}}
			>
				{value.toLocaleString()}
			</div>
			<div style={{ fontSize: 12, color: "var(--kumo-subtle, #6b7280)", marginTop: 4 }}>
				{label}
			</div>
		</div>
	);
}
