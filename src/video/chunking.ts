/**
 * R2 multipart part size for browser → R2 video uploads (6 MiB).
 *
 * Parts are sent as base64 inside a JSON body through the plugin route
 * (`ctx.input`) — a plugin route cannot read a raw binary request body because
 * Emdash consumes the body to build `ctx.input`. Base64 inflates payloads by
 * 4/3, and the plugin-route body limit is ~12 MB, so the raw part must stay
 * small: 6 MiB → ~8.4 MB JSON body. It must also stay at/above R2's 5 MiB
 * multipart minimum (every part except the last). 6 MiB satisfies both.
 */
export const R2_PART_SIZE = 6 * 1024 * 1024;

/** YouTube resumable PUT chunk size (8 MB = 32 × 256 KB). Must stay a 256 KB multiple. */
export const YT_CHUNK_SIZE = 8 * 1024 * 1024;

const YT_ALIGN = 256 * 1024;

/** Number of R2 parts needed for a file of `totalBytes`, rounded up. */
export function partCount(totalBytes: number): number {
	return Math.ceil(totalBytes / R2_PART_SIZE);
}

/** Byte range for a 1-based R2 part. `end` is exclusive. */
export function partRange(
	partNumber: number,
	totalBytes: number,
): { start: number; end: number; length: number } {
	const start = (partNumber - 1) * R2_PART_SIZE;
	const end = Math.min(start + R2_PART_SIZE, totalBytes);
	return { start, end, length: end - start };
}

/**
 * Next resumable chunk to push to YouTube given how many bytes are already sent.
 * `end` is INCLUSIVE (YouTube Content-Range style). Non-final chunks are exactly
 * YT_CHUNK_SIZE (a 256 KB multiple); the final chunk carries the remainder.
 */
export function nextYoutubeChunk(
	bytesSent: number,
	totalBytes: number,
): { start: number; end: number; length: number; isFinal: boolean } {
	const remaining = totalBytes - bytesSent;
	if (remaining <= YT_CHUNK_SIZE) {
		return { start: bytesSent, end: totalBytes - 1, length: remaining, isFinal: true };
	}
	// Defensive: keep non-final chunks 256 KB-aligned even if YT_CHUNK_SIZE changes.
	const length = YT_CHUNK_SIZE - (YT_CHUNK_SIZE % YT_ALIGN);
	return { start: bytesSent, end: bytesSent + length - 1, length, isFinal: false };
}

/** "bytes start-end/total" with an inclusive `end`. */
export function contentRangeHeader(start: number, end: number, total: number): string {
	return `bytes ${start}-${end}/${total}`;
}
