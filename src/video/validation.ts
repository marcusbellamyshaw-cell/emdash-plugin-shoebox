export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

export function isAllowedVideoType(contentType: string): boolean {
	return (ALLOWED_VIDEO_TYPES as readonly string[]).includes(contentType.toLowerCase());
}

/** True when 0 < sizeBytes <= capBytes. */
export function withinSizeCap(sizeBytes: number, capBytes: number): boolean {
	return sizeBytes > 0 && sizeBytes <= capBytes;
}

/**
 * Heuristic magic-byte check on the first bytes of a file:
 * - mp4/mov: ASCII "ftyp" at offset 4
 * - webm/mkv: EBML header 0x1A45DFA3 at offset 0
 */
export function sniffVideoMagic(head: Uint8Array): boolean {
	if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
		return true; // "ftyp"
	}
	if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
		return true; // EBML
	}
	return false;
}
