import * as React from "react";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import type { SubmissionRecord } from "../types.js";

const API = "/_emdash/api/plugins/ebt-shoebox";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SubmissionListItem extends SubmissionRecord {
	id: string;
}

interface SubmissionDetail extends SubmissionListItem {
	collected: Record<string, unknown>;
}

interface ListResponse {
	items: SubmissionListItem[];
	cursor?: string;
	hasMore: boolean;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function Queue() {
	const [items, setItems] = React.useState<SubmissionListItem[]>([]);
	const [statusFilter, setStatusFilter] = React.useState<"pending" | "approved" | "rejected" | "all">("pending");
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [selected, setSelected] = React.useState<SubmissionDetail | null>(null);
	const [detailLoading, setDetailLoading] = React.useState(false);
	const [actionLoading, setActionLoading] = React.useState(false);
	const [rejectReason, setRejectReason] = React.useState("");
	const [confirmReject, setConfirmReject] = React.useState(false);
	const [toast, setToast] = React.useState<{ type: "success" | "error"; message: string } | null>(null);

	const showToast = React.useCallback((type: "success" | "error", message: string) => {
		setToast({ type, message });
		setTimeout(() => setToast(null), 4000);
	}, []);

	const reqIdRef = React.useRef(0);
	const loadList = React.useCallback(async () => {
		const reqId = ++reqIdRef.current;
		setLoading(true);
		setError(null);
		try {
			const res = await apiFetch(
				`${API}/submissions/list?status=${statusFilter}`,
			);
			const data = await parseApiResponse<ListResponse>(res, "Failed to load submissions");
			// Ignore a stale response if a newer filter request was started while
			// this one was in flight (rapid tab switches would otherwise clobber
			// the newer results with older ones).
			if (reqId !== reqIdRef.current) return;
			setItems(data.items);
		} catch (err) {
			if (reqId !== reqIdRef.current) return;
			setError(err instanceof Error ? err.message : "Failed to load submissions");
		} finally {
			if (reqId === reqIdRef.current) setLoading(false);
		}
	}, [statusFilter]);

	React.useEffect(() => {
		void loadList();
	}, [loadList]);

	const openDetail = async (id: string) => {
		setDetailLoading(true);
		try {
			const res = await apiFetch(`${API}/submissions/get?id=${id}`);
			const data = await parseApiResponse<SubmissionDetail>(res, "Failed to load detail");
			setSelected(data);
			setRejectReason("");
			setConfirmReject(false);
		} catch (err) {
			showToast("error", err instanceof Error ? err.message : "Failed to load detail");
		} finally {
			setDetailLoading(false);
		}
	};

	const handleApprove = async () => {
		if (!selected) return;
		setActionLoading(true);
		try {
			const res = await apiFetch(`${API}/submissions/approve`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: selected.id }),
			});
			await parseApiResponse(res, "Failed to approve");
			showToast("success", "Approved! Open it in EmDash and click Publish whenever you're ready — that's when the confirmation email goes out.");
			setSelected(null);
			void loadList();
		} catch (err) {
			showToast("error", err instanceof Error ? err.message : "Approval failed");
		} finally {
			setActionLoading(false);
		}
	};

	const handleReject = async () => {
		if (!selected) return;
		if (!confirmReject) {
			setConfirmReject(true);
			return;
		}
		setActionLoading(true);
		try {
			const res = await apiFetch(`${API}/submissions/reject`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: selected.id, reason: rejectReason }),
			});
			await parseApiResponse(res, "Failed to reject");
			showToast("success", "Submission rejected.");
			setSelected(null);
			setConfirmReject(false);
			void loadList();
		} catch (err) {
			showToast("error", err instanceof Error ? err.message : "Rejection failed");
		} finally {
			setActionLoading(false);
		}
	};

	return (
		<div className="sbs-queue-root" style={{ display: "flex", gap: 24, minHeight: 500, position: "relative" }}>
			<style>{`
				@media (max-width: 640px) {
					.sbs-queue-root { flex-direction: column !important; gap: 16px !important; }
					.sbs-queue-list { width: 100% !important; }
					.sbs-queue-list--hidden { display: none !important; }
					.sbs-queue-detail { min-width: 0 !important; }
					.sbs-detail-header { flex-direction: column !important; align-items: flex-start !important; gap: 12px !important; }
					.sbs-detail-actions { width: 100% !important; }
					.sbs-detail-actions button { flex: 1 !important; }
					.sbs-meta-grid { grid-template-columns: 1fr !important; }
					.sbs-photo-grid img { width: 100px !important; height: 75px !important; }
				}
			`}</style>
			{/* Toast */}
			{toast && (
				<div
					style={{
						position: "fixed",
						top: 16,
						right: 16,
						zIndex: 9999,
						padding: "12px 16px",
						borderRadius: 8,
						background: toast.type === "success" ? "#f0fdf4" : "#fef2f2",
						border: `1px solid ${toast.type === "success" ? "#bbf7d0" : "#fecaca"}`,
						color: toast.type === "success" ? "#166534" : "#991b1b",
						fontSize: 14,
						boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
					}}
				>
					{toast.message}
				</div>
			)}

			{/* Left: submission list */}
			<div className={`sbs-queue-list${selected ? " sbs-queue-list--hidden" : ""}`} style={{ width: 340, flexShrink: 0 }}>
				{/* Filter tabs */}
				<div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
					{(["pending", "approved", "rejected", "all"] as const).map((s) => (
						<button
							key={s}
							type="button"
							onClick={() => setStatusFilter(s)}
							style={{
								padding: "4px 12px",
								borderRadius: 6,
								border: "1px solid",
								borderColor: statusFilter === s ? "var(--kumo-brand, #f59e0b)" : "var(--kumo-border, #e5e7eb)",
								background: statusFilter === s ? "var(--kumo-brand, #f59e0b)" : "transparent",
								color: statusFilter === s ? "#fff" : "var(--kumo-foreground, #111827)",
								cursor: "pointer",
								fontSize: 13,
								textTransform: "capitalize",
							}}
						>
							{s}
						</button>
					))}
				</div>

				{loading ? (
					<div style={{ color: "var(--kumo-subtle, #6b7280)", padding: "24px 0", textAlign: "center" }}>
						Loading…
					</div>
				) : error ? (
					<div style={{ color: "var(--kumo-danger, #dc2626)", padding: "24px 0" }}>{error}</div>
				) : items.length === 0 ? (
					<div style={{ color: "var(--kumo-subtle, #6b7280)", padding: "24px 0", textAlign: "center" }}>
						No {statusFilter !== "all" ? statusFilter : ""} submissions.
					</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
						{items.map((item) => (
							<button
								key={item.id}
								type="button"
								onClick={() => void openDetail(item.id)}
								style={{
									display: "block",
									width: "100%",
									textAlign: "left",
									padding: "12px 14px",
									border: "1px solid",
									borderColor: selected?.id === item.id
										? "var(--kumo-brand, #f59e0b)"
										: "var(--kumo-border, #e5e7eb)",
									borderRadius: 8,
									background: selected?.id === item.id
										? "var(--kumo-brand-subtle, #fffbeb)"
										: "var(--kumo-surface, #fff)",
									cursor: "pointer",
								}}
							>
								<div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{item.title}</div>
								<div style={{ fontSize: 12, color: "var(--kumo-subtle, #6b7280)" }}>
									{item.location} · {item.photoCount} photo{item.photoCount !== 1 ? "s" : ""}
									{" · "}
									<StatusBadge status={item.status} />
								</div>
								<div style={{ fontSize: 11, color: "var(--kumo-subtle, #6b7280)", marginTop: 4 }}>
									{new Date(item.createdAt).toLocaleDateString()}
								</div>
							</button>
						))}
					</div>
				)}
			</div>

			{/* Right: detail panel */}
			<div className="sbs-queue-detail" style={{ flex: 1, minWidth: 0 }}>
				{detailLoading ? (
					<div style={{ color: "var(--kumo-subtle, #6b7280)", padding: "24px 0" }}>Loading…</div>
				) : selected ? (
					<SubmissionDetailPanel
						submission={selected}
						onApprove={handleApprove}
						onReject={handleReject}
						onBack={() => { setSelected(null); setConfirmReject(false); }}
						actionLoading={actionLoading}
						rejectReason={rejectReason}
						onRejectReasonChange={setRejectReason}
						confirmReject={confirmReject}
					/>
				) : (
					<div style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						height: "100%",
						color: "var(--kumo-subtle, #6b7280)",
						fontSize: 14,
					}}>
						Select a submission to review
					</div>
				)}
			</div>
		</div>
	);
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function SubmissionDetailPanel({
	submission,
	onApprove,
	onReject,
	onBack,
	actionLoading,
	rejectReason,
	onRejectReasonChange,
	confirmReject,
}: {
	submission: SubmissionDetail;
	onApprove: () => void;
	onReject: () => void;
	onBack: () => void;
	actionLoading: boolean;
	rejectReason: string;
	onRejectReasonChange: (v: string) => void;
	confirmReject: boolean;
}) {
	const photos = (
		submission.photos?.length
			? submission.photos
			: (submission.collected.photos as Array<{ url: string; altTextFinal?: string; filename?: string }> | undefined) ?? []
	);
	const emdashId = submission.emdashContentId;

	return (
		<div>
			<button
				type="button"
				onClick={onBack}
				style={{
					fontSize: 13,
					color: "var(--kumo-subtle, #6b7280)",
					background: "none",
					border: "none",
					cursor: "pointer",
					marginBottom: 16,
					padding: 0,
				}}
			>
				← Back to list
			</button>

			<div className="sbs-detail-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
				<div>
					<h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{submission.title}</h2>
					<div style={{ fontSize: 13, color: "var(--kumo-subtle, #6b7280)", marginTop: 4 }}>
						Submitted {new Date(submission.createdAt).toLocaleString()}
						{" · "}<StatusBadge status={submission.status} />
					</div>
					{emdashId && (
						<div style={{ marginTop: 6, display: "flex", gap: 12 }}>
							<a
								href={`/_emdash/admin/content/community_submissions/${emdashId}`}
								target="_blank"
								rel="noopener noreferrer"
								style={{ fontSize: 12, color: "var(--kumo-brand, #f59e0b)", textDecoration: "none", fontWeight: 600 }}
							>
								Edit in EmDash ↗
							</a>
							{submission.status === "approved" && (
								<a
									href={`/from-the-shoebox/${emdashId}`}
									target="_blank"
									rel="noopener noreferrer"
									style={{ fontSize: 12, color: "var(--kumo-subtle, #6b7280)", textDecoration: "none" }}
								>
									View Post ↗
								</a>
							)}
						</div>
					)}
				</div>
				{submission.status === "pending" && (
					<div className="sbs-detail-actions" style={{ display: "flex", gap: 8, flexShrink: 0 }}>
						<button
							type="button"
							onClick={onApprove}
							disabled={actionLoading}
							style={{
								padding: "8px 18px",
								background: "#16a34a",
								color: "#fff",
								border: "none",
								borderRadius: 6,
								cursor: actionLoading ? "not-allowed" : "pointer",
								fontWeight: 600,
								fontSize: 14,
								opacity: actionLoading ? 0.7 : 1,
							}}
						>
							{actionLoading ? "…" : "Approve"}
						</button>
						<button
							type="button"
							onClick={onReject}
							disabled={actionLoading}
							style={{
								padding: "8px 18px",
								background: confirmReject ? "#dc2626" : "transparent",
								color: confirmReject ? "#fff" : "#dc2626",
								border: "1px solid #dc2626",
								borderRadius: 6,
								cursor: actionLoading ? "not-allowed" : "pointer",
								fontWeight: 600,
								fontSize: 14,
								opacity: actionLoading ? 0.7 : 1,
							}}
						>
							{confirmReject ? "Confirm Reject" : "Reject"}
						</button>
					</div>
				)}
			</div>

			{/* Reject reason field */}
			{confirmReject && (
				<div style={{ marginBottom: 16, padding: 12, background: "#fef2f2", borderRadius: 8, border: "1px solid #fecaca" }}>
					<label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6, color: "#991b1b" }}>
						Rejection reason (optional — adds context for the team, not sent to submitter)
					</label>
					<textarea
						value={rejectReason}
						onChange={(e) => onRejectReasonChange(e.target.value)}
						rows={3}
						style={{
							width: "100%",
							padding: "8px 10px",
							border: "1px solid #fecaca",
							borderRadius: 6,
							fontSize: 13,
							resize: "vertical",
							boxSizing: "border-box",
						}}
						placeholder="e.g. Duplicate submission, unclear provenance, outside Texas…"
					/>
				</div>
			)}

			{/* Meta grid */}
			<div className="sbs-meta-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
				<MetaField label="Submitter" value={submission.submitterName} />
				<MetaField label="Email" value={submission.submitterEmail ?? ""} />
				<MetaField label="Location" value={submission.location} />
				<MetaField label="Photos" value={`${submission.photoCount}`} />
			</div>

			{/* Photos */}
			{photos.length > 0 && (
				<Section title="Photos">
					<div className="sbs-photo-grid" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
						{photos.map((photo, i) => (
							<div key={i} style={{ width: 120 }}>
								<img
									src={photo.url}
									alt={photo.altTextFinal ?? ""}
									style={{
										width: 120,
										height: 90,
										objectFit: "cover",
										borderRadius: 6,
										border: "1px solid var(--kumo-border, #e5e7eb)",
									}}
								/>
								{photo.altTextFinal && (
									<p style={{ fontSize: 11, color: "var(--kumo-subtle, #6b7280)", margin: "4px 0 0" }}>
										{photo.altTextFinal}
									</p>
								)}
							</div>
						))}
					</div>
				</Section>
			)}

			{/* Story */}
			<Section title="Story">
				<p style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", margin: 0 }}>
					{(submission as unknown as { collected?: { story?: string } }).collected?.story ??
						"(No story text)"}
				</p>
			</Section>

			{/* Taxonomy tags */}
			{submission.taxonomyTags && typeof submission.taxonomyTags === "object" && (
				<Section title="Taxonomy Tags">
					<TaxonomyDisplay tags={submission.taxonomyTags as unknown as Record<string, unknown>} />
				</Section>
			)}
		</div>
	);
}

// ─── Helper sub-components ────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
	const colors: Record<string, { bg: string; text: string }> = {
		pending: { bg: "#fef3c7", text: "#92400e" },
		approved: { bg: "#d1fae5", text: "#065f46" },
		rejected: { bg: "#fee2e2", text: "#991b1b" },
	};
	const c = colors[status] ?? { bg: "#f3f4f6", text: "#374151" };
	return (
		<span style={{
			display: "inline-block",
			padding: "1px 8px",
			borderRadius: 12,
			fontSize: 11,
			fontWeight: 600,
			background: c.bg,
			color: c.text,
			textTransform: "capitalize",
		}}>
			{status}
		</span>
	);
}

function MetaField({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div style={{ fontSize: 11, color: "var(--kumo-subtle, #6b7280)", marginBottom: 2 }}>{label}</div>
			<div style={{ fontSize: 14, fontWeight: 500 }}>{value || "—"}</div>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div style={{ marginBottom: 20 }}>
			<h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--kumo-subtle, #6b7280)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
				{title}
			</h3>
			{children}
		</div>
	);
}

function TaxonomyDisplay({ tags }: { tags: Record<string, unknown> }) {
	const groups = [
		{ label: "Categories", key: "categories" },
		{ label: "Tags", key: "tags" },
		{ label: "Regions", key: "regions" },
		{ label: "Eras", key: "eras" },
		{ label: "Counties", key: "counties" },
		{ label: "Content Types", key: "content_types" },
	];

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			{groups.map(({ label, key }) => {
				const values = tags[key];
				if (!Array.isArray(values) || values.length === 0) return null;
				return (
					<div key={key} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
						<span style={{ fontSize: 11, color: "var(--kumo-subtle, #6b7280)", minWidth: 90 }}>{label}</span>
						<div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
							{(values as string[]).map((v) => (
								<span key={v} style={{
									padding: "2px 8px",
									background: "var(--kumo-surface-raised, #f3f4f6)",
									borderRadius: 4,
									fontSize: 12,
								}}>
									{v}
								</span>
							))}
						</div>
					</div>
				);
			})}
		</div>
	);
}
