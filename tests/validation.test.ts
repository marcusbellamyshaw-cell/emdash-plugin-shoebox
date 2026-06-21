import { describe, expect, it } from "vitest";
import {
	ALLOWED_VIDEO_TYPES,
	isAllowedVideoType,
	withinSizeCap,
	sniffVideoMagic,
} from "../src/video/validation.js";

describe("video validation", () => {
	it("allows mp4/mov/webm only", () => {
		expect(ALLOWED_VIDEO_TYPES).toContain("video/mp4");
		expect(isAllowedVideoType("video/mp4")).toBe(true);
		expect(isAllowedVideoType("video/quicktime")).toBe(true);
		expect(isAllowedVideoType("video/webm")).toBe(true);
		expect(isAllowedVideoType("video/avi")).toBe(false);
		expect(isAllowedVideoType("image/jpeg")).toBe(false);
		expect(isAllowedVideoType("VIDEO/MP4")).toBe(true);
	});

	it("enforces a size cap", () => {
		expect(withinSizeCap(100, 1000)).toBe(true);
		expect(withinSizeCap(1000, 1000)).toBe(true);
		expect(withinSizeCap(1001, 1000)).toBe(false);
		expect(withinSizeCap(0, 1000)).toBe(false);
	});

	it("sniffs mp4/mov ftyp boxes", () => {
		const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
		expect(sniffVideoMagic(mp4)).toBe(true);
	});

	it("sniffs webm/matroska EBML header", () => {
		const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
		expect(sniffVideoMagic(webm)).toBe(true);
	});

	it("rejects non-video heads", () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
		expect(sniffVideoMagic(jpeg)).toBe(false);
		expect(sniffVideoMagic(new Uint8Array([0, 1, 2]))).toBe(false);
	});
});
