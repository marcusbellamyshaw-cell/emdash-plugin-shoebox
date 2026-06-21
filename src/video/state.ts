export type VideoState =
	| "staged"
	| "pending_upload"
	| "uploading"
	| "uploaded"
	| "failed";

const TRANSITIONS: Record<VideoState, VideoState[]> = {
	staged: ["pending_upload"],
	pending_upload: ["uploading", "failed"],
	uploading: ["uploaded", "failed", "pending_upload"],
	uploaded: [],
	failed: ["pending_upload"],
};

/** failed → pending_upload is permitted so the cron can retry transient errors. */
export const RETRYABLE_FROM_FAILED = true;

export function canTransition(from: VideoState, to: VideoState): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: VideoState, to: VideoState): void {
	if (!canTransition(from, to)) {
		throw new Error(`illegal video state transition: ${from} → ${to}`);
	}
}
