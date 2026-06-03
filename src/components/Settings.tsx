import * as React from "react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";

const API = "/_emdash/api/plugins/ebt-shoebox";

interface SettingsValues {
	enabled: boolean;
	brevoApiKey: string;
	newsletterEnabled: boolean;
	maxFileSize: number;
	maxPhotos: number;
	maxSubmissionsPerIp: number;
	maxStoryWords: number;
}

const DEFAULTS: SettingsValues = {
	enabled: true,
	brevoApiKey: "",
	newsletterEnabled: true,
	maxFileSize: 10,
	maxPhotos: 5,
	maxSubmissionsPerIp: 3,
	maxStoryWords: 2000,
};

export function Settings() {
	const [values, setValues] = React.useState<SettingsValues>(DEFAULTS);
	const [loading, setLoading] = React.useState(true);
	const [saving, setSaving] = React.useState(false);
	const [status, setStatus] = React.useState<{ type: "success" | "error"; message: string } | null>(null);

	React.useEffect(() => {
		(async () => {
			try {
				const res = await apiFetch(`${API}/settings/get`);
				const data = await parseApiResponse<SettingsValues>(res, "Failed to load settings");
				setValues(data);
			} catch (err) {
				setStatus({ type: "error", message: err instanceof Error ? err.message : "Failed to load settings" });
			} finally {
				setLoading(false);
			}
		})();
	}, []);

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setStatus(null);
		try {
			const res = await apiFetch(`${API}/settings/update`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(values),
			});
			await parseApiResponse(res, "Failed to save settings");
			setStatus({ type: "success", message: "Settings saved." });
		} catch (err) {
			setStatus({ type: "error", message: err instanceof Error ? err.message : "Save failed" });
		} finally {
			setSaving(false);
		}
	};

	const set = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) =>
		setValues((v) => ({ ...v, [key]: value }));

	if (loading) return <div style={{ padding: 32, color: "var(--kumo-subtle, #6b7280)" }}>Loading…</div>;

	return (
		<form onSubmit={(e) => void handleSave(e)} style={{ maxWidth: 640 }}>
			{status && (
				<div style={{
					marginBottom: 20,
					padding: "10px 14px",
					borderRadius: 8,
					background: status.type === "success" ? "#f0fdf4" : "#fef2f2",
					border: `1px solid ${status.type === "success" ? "#bbf7d0" : "#fecaca"}`,
					color: status.type === "success" ? "#166534" : "#991b1b",
					fontSize: 14,
				}}>
					{status.message}
				</div>
			)}

			<Section title="General">
				<Toggle label="Plugin enabled" checked={values.enabled} onChange={(v) => set("enabled", v)} />
			</Section>

			<Section title="Newsletter (Brevo)">
				<Toggle label="Enable newsletter opt-in prompt" checked={values.newsletterEnabled} onChange={(v) => set("newsletterEnabled", v)} />
				<Field label="Brevo API Key" value={values.brevoApiKey} onChange={(v) => set("brevoApiKey", v)} secret
					hint="Brevo dashboard → Settings → API Keys" />
			</Section>

			<Section title="Limits">
				<NumberField label="Max file size (MB)" value={values.maxFileSize} onChange={(v) => set("maxFileSize", v)} min={1} max={50} />
				<NumberField label="Max photos per submission" value={values.maxPhotos} onChange={(v) => set("maxPhotos", v)} min={1} max={10} />
				<NumberField label="Max submissions per IP per 24h" value={values.maxSubmissionsPerIp} onChange={(v) => set("maxSubmissionsPerIp", v)} min={1} max={20} />
				<NumberField label="Max story word count" value={values.maxStoryWords} onChange={(v) => set("maxStoryWords", v)} min={500} max={5000} />
			</Section>

			<div style={{ paddingTop: 8 }}>
				<button
					type="submit"
					disabled={saving}
					style={{
						padding: "9px 22px",
						background: "var(--kumo-brand, #f59e0b)",
						color: "#fff",
						border: "none",
						borderRadius: 7,
						fontWeight: 600,
						fontSize: 14,
						cursor: saving ? "not-allowed" : "pointer",
						opacity: saving ? 0.7 : 1,
					}}
				>
					{saving ? "Saving…" : "Save Settings"}
				</button>
			</div>
		</form>
	);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const helpStyle: React.CSSProperties = {
	fontSize: 13,
	color: "var(--kumo-subtle, #6b7280)",
	marginBottom: 12,
	marginTop: 0,
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div style={{ marginBottom: 32 }}>
			<h3 style={{ fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--kumo-subtle, #6b7280)", marginBottom: 14 }}>
				{title}
			</h3>
			<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
				{children}
			</div>
		</div>
	);
}

function Field({ label, value, onChange, secret, hint, multiline }: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	secret?: boolean;
	hint?: string;
	multiline?: boolean;
}) {
	const inputStyle: React.CSSProperties = {
		width: "100%",
		padding: "7px 10px",
		border: "1px solid var(--kumo-border, #e5e7eb)",
		borderRadius: 6,
		fontSize: 13,
		background: "var(--kumo-surface, #fff)",
		color: "var(--kumo-foreground, #111827)",
		boxSizing: "border-box",
		fontFamily: secret ? "monospace" : "inherit",
	};
	return (
		<div>
			<label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{label}</label>
			{multiline ? (
				<textarea
					value={value}
					onChange={(e) => onChange(e.target.value)}
					rows={4}
					style={{ ...inputStyle, resize: "vertical" }}
				/>
			) : (
				<input
					type={secret ? "password" : "text"}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					autoComplete="off"
					style={inputStyle}
				/>
			)}
			{hint && <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--kumo-subtle, #6b7280)" }}>{hint}</p>}
		</div>
	);
}

function NumberField({ label, value, onChange, min, max }: {
	label: string;
	value: number;
	onChange: (v: number) => void;
	min: number;
	max: number;
}) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
			<label style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{label}</label>
			<input
				type="number"
				value={value}
				min={min}
				max={max}
				onChange={(e) => onChange(Number(e.target.value))}
				style={{
					width: 80,
					padding: "6px 8px",
					border: "1px solid var(--kumo-border, #e5e7eb)",
					borderRadius: 6,
					fontSize: 13,
					textAlign: "right",
				}}
			/>
		</div>
	);
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
	return (
		<label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				style={{ width: 16, height: 16, accentColor: "var(--kumo-brand, #f59e0b)", cursor: "pointer" }}
			/>
			{label}
		</label>
	);
}
