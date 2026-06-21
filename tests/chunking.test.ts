import { describe, expect, it } from "vitest";
import { R2_PART_SIZE } from "../src/video/chunking.js";

describe("chunking constants", () => {
	it("uses a 64 MB R2 part size", () => {
		expect(R2_PART_SIZE).toBe(64 * 1024 * 1024);
	});
});
