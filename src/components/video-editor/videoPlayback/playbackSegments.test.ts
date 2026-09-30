import { describe, expect, it } from "vitest";
import { getPlaybackSegments } from "../types";
import { resolvePlaybackStep } from "./playbackSegments";

const inOrder = getPlaybackSegments([
	{ id: "a", startMs: 1000, endMs: 3000, speed: 1 },
	{ id: "b", startMs: 5000, endMs: 8000, speed: 1 },
]);

// Timeline: source 6000-8000 first, then source 1000-3000.
const reordered = getPlaybackSegments([
	{ id: "b", startMs: 0, endMs: 2000, speed: 1, sourceStartMs: 6000 },
	{ id: "a", startMs: 2000, endMs: 4000, speed: 1, sourceStartMs: 1000 },
]);

describe("resolvePlaybackStep", () => {
	it("plays freely when there are no clips", () => {
		expect(resolvePlaybackStep([], 500, -1)).toEqual({ action: "free" });
	});

	it("stays inside a clip", () => {
		expect(resolvePlaybackStep(inOrder, 2000, -1)).toEqual({ action: "stay", index: 0 });
	});

	it("skips removed footage forward in source order, as before", () => {
		expect(resolvePlaybackStep(inOrder, 0, -1)).toEqual({
			action: "jump",
			index: 0,
			toSourceMs: 1000,
		});
		expect(resolvePlaybackStep(inOrder, 3990, 0)).toEqual({
			action: "jump",
			index: 1,
			toSourceMs: 5000,
		});
		expect(resolvePlaybackStep(inOrder, 7995, 1)).toEqual({ action: "end" });
	});

	it("jumps backwards in the source when the next clip comes from earlier", () => {
		expect(resolvePlaybackStep(reordered, 7990, 0)).toEqual({
			action: "jump",
			index: 1,
			toSourceMs: 1000,
		});
		expect(resolvePlaybackStep(reordered, 2995, 1)).toEqual({ action: "end" });
	});

	it("starts a reordered edit at its first clip from removed footage", () => {
		expect(resolvePlaybackStep(reordered, 0, -1)).toEqual({
			action: "jump",
			index: 0,
			toSourceMs: 6000,
		});
	});
});

describe("resolvePlaybackStep at split points", () => {
	it("keeps playing across a split instead of seeking", () => {
		const split = getPlaybackSegments([
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
		]);
		expect(resolvePlaybackStep(split, 990, 0)).toEqual({ action: "stay", index: 1 });
		expect(resolvePlaybackStep(split, 1005, 1)).toEqual({ action: "stay", index: 1 });
	});
});

describe("resolvePlaybackStep stale reports", () => {
	it("does not skip ahead on a stale time from before a jump", () => {
		const three = getPlaybackSegments([
			{ id: "b", startMs: 0, endMs: 2000, speed: 1, sourceStartMs: 6000 },
			{ id: "a", startMs: 2000, endMs: 4000, speed: 1, sourceStartMs: 1000 },
			{ id: "c", startMs: 4000, endMs: 5000, speed: 1, sourceStartMs: 4000 },
		]);
		// Now in clip "a" (index 1); a late report says 3.5s (after a's end, before c).
		expect(resolvePlaybackStep(three, 3500, 2)).toEqual({ action: "stay", index: 2 });
	});
});
