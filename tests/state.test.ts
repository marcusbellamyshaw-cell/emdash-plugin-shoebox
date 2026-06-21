import { describe, expect, it } from "vitest";
import { canTransition, assertTransition } from "../src/video/state.js";

describe("video state machine", () => {
	it("allows the happy path", () => {
		expect(canTransition("staged", "pending_upload")).toBe(true);
		expect(canTransition("pending_upload", "uploading")).toBe(true);
		expect(canTransition("uploading", "uploaded")).toBe(true);
	});

	it("allows failure and retry", () => {
		expect(canTransition("uploading", "failed")).toBe(true);
		expect(canTransition("pending_upload", "failed")).toBe(true);
		expect(canTransition("failed", "pending_upload")).toBe(true);
	});

	it("forbids skipping and illegal moves", () => {
		expect(canTransition("staged", "uploading")).toBe(false);
		expect(canTransition("staged", "uploaded")).toBe(false);
		expect(canTransition("uploaded", "uploading")).toBe(false);
		expect(canTransition("uploaded", "pending_upload")).toBe(false);
	});

	it("assertTransition throws on illegal moves", () => {
		expect(() => assertTransition("staged", "uploaded")).toThrow(/illegal/i);
		expect(() => assertTransition("staged", "pending_upload")).not.toThrow();
	});
});
