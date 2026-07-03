export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

export function isAllowedVideoType(contentType: string): boolean {
	return (ALLOWED_VIDEO_TYPES as readonly string[]).includes(contentType.toLowerCase());
}

/** True when 0 < sizeBytes <= capBytes. */
export function withinSizeCap(sizeBytes: number, capBytes: number): boolean {
	return sizeBytes > 0 && sizeBytes <= capBytes;
}

// crewcut: heuristic floor to reject bogus/near-empty files (e.g. a 12-byte fake
// mp4 with just an ftyp header) before multipart begins. Real clips are always
// well above this; raise if legitimate ultra-short clips ever get rejected.
export const MIN_VIDEO_BYTES = 10 * 1024;

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

/**
 * Magic-byte check for the three photo types the form accepts:
 * - JPEG: FF D8 FF
 * - PNG: 89 50 4E 47 0D 0A 1A 0A
 * - WebP: "RIFF"....."WEBP"
 */
export function sniffImageMagic(head: Uint8Array): boolean {
	if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
		return true; // JPEG
	}
	if (
		head.length >= 8 &&
		head[0] === 0x89 &&
		head[1] === 0x50 &&
		head[2] === 0x4e &&
		head[3] === 0x47 &&
		head[4] === 0x0d &&
		head[5] === 0x0a &&
		head[6] === 0x1a &&
		head[7] === 0x0a
	) {
		return true; // PNG
	}
	if (
		head.length >= 12 &&
		head[0] === 0x52 &&
		head[1] === 0x49 &&
		head[2] === 0x46 &&
		head[3] === 0x46 &&
		head[8] === 0x57 &&
		head[9] === 0x45 &&
		head[10] === 0x42 &&
		head[11] === 0x50
	) {
		return true; // RIFF....WEBP
	}
	return false;
}
