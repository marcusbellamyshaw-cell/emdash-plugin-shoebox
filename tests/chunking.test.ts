import { describe, expect, it } from "vitest";
import {
	R2_PART_SIZE,
	YT_CHUNK_SIZE,
	partCount,
	partRange,
	nextYoutubeChunk,
	contentRangeHeader,
} from "../src/video/chunking.js";

describe("R2 part math", () => {
	it("uses a 6 MiB R2 part size (fits base64 in the plugin-route body limit, ≥ R2's 5 MiB minimum)", () => {
		expect(R2_PART_SIZE).toBe(6 * 1024 * 1024);
		// base64 of one raw part must stay under the ~12 MB plugin-route body cap.
		expect(Math.ceil(R2_PART_SIZE / 3) * 4).toBeLessThan(12 * 1024 * 1024);
		// and at/above R2's 5 MiB multipart minimum for non-final parts.
		expect(R2_PART_SIZE).toBeGreaterThanOrEqual(5 * 1024 * 1024);
	});

	it("counts parts, rounding up", () => {
		expect(partCount(0)).toBe(0);
		expect(partCount(1)).toBe(1);
		expect(partCount(R2_PART_SIZE)).toBe(1);
		expect(partCount(R2_PART_SIZE + 1)).toBe(2);
		expect(partCount(R2_PART_SIZE * 3)).toBe(3);
	});

	it("computes a part range (1-based, end exclusive)", () => {
		expect(partRange(1, R2_PART_SIZE * 3)).toEqual({ start: 0, end: R2_PART_SIZE, length: R2_PART_SIZE });
		const total = R2_PART_SIZE + 10;
		expect(partRange(2, total)).toEqual({ start: R2_PART_SIZE, end: total, length: 10 });
	});
});

describe("YouTube resumable chunk math", () => {
	it("uses an 8 MB chunk that is a multiple of 256 KB", () => {
		expect(YT_CHUNK_SIZE).toBe(8 * 1024 * 1024);
		expect(YT_CHUNK_SIZE % (256 * 1024)).toBe(0);
	});

	it("returns a full aligned chunk when more than a chunk remains", () => {
		const total = YT_CHUNK_SIZE * 3 + 123;
		const c = nextYoutubeChunk(0, total);
		expect(c).toEqual({ start: 0, end: YT_CHUNK_SIZE - 1, length: YT_CHUNK_SIZE, isFinal: false });
	});

	it("returns the final (possibly unaligned) chunk at the tail", () => {
		const total = YT_CHUNK_SIZE + 100;
		const c = nextYoutubeChunk(YT_CHUNK_SIZE, total);
		expect(c).toEqual({ start: YT_CHUNK_SIZE, end: total - 1, length: 100, isFinal: true });
	});

	it("treats an exactly-aligned last chunk as final", () => {
		const total = YT_CHUNK_SIZE;
		const c = nextYoutubeChunk(0, total);
		expect(c.isFinal).toBe(true);
		expect(c.length).toBe(YT_CHUNK_SIZE);
	});

	it("formats Content-Range with an inclusive end", () => {
		expect(contentRangeHeader(0, 8388607, 16777216)).toBe("bytes 0-8388607/16777216");
	});
});
