import { describe, expect, it } from "vitest";
import { moveClip, packClips, remapTimelineRegions, trimClipEdges } from "./timelineRipple";
import {
	type ClipRegion,
	clipsToTrims,
	getClipSourceStartMs,
	getPlaybackSegments,
	isSourceOrderMonotonic,
	mapSourceTimeToTimelineTime,
	mapTimelineRegionsToSource,
	mapTimelineTimeToSourceTime,
} from "./types";

const clip = (id: string, startMs: number, endMs: number, sourceStartMs?: number): ClipRegion => ({
	id,
	startMs,
	endMs,
	speed: 1,
	...(sourceStartMs === undefined ? {} : { sourceStartMs }),
});

const layout = (clips: ClipRegion[]) =>
	clips.map((c) => `${c.id}:${c.startMs}-${c.endMs}@${getClipSourceStartMs(c)}`);

describe("packClips", () => {
	it("closes gaps without changing what each clip shows", () => {
		const packed = packClips([
			clip("a", 0, 1000),
			clip("b", 3000, 5000),
			clip("c", 6000, 6500),
		]);
		expect(layout(packed)).toEqual(["a:0-1000@0", "b:1000-3000@3000", "c:3000-3500@6000"]);
	});

	it("returns the same array when already packed", () => {
		const clips = [clip("a", 0, 1000), clip("b", 1000, 2000)];
		expect(packClips(clips)).toBe(clips);
	});
});

describe("moveClip", () => {
	const clips = [clip("a", 0, 1000), clip("b", 1000, 3000), clip("c", 3000, 4000)];

	it("reorders with ripple: dropping c at the start shifts a and b along", () => {
		expect(layout(moveClip(clips, "c", 100, true))).toEqual([
			"c:0-1000@3000",
			"a:1000-2000@0",
			"b:2000-4000@1000",
		]);
	});

	it("moves a clip to the end", () => {
		expect(layout(moveClip(clips, "a", 3500, true))).toEqual([
			"b:0-2000@1000",
			"c:2000-3000@3000",
			"a:3000-4000@0",
		]);
	});

	it("places freely without ripple, keeping the content", () => {
		expect(layout(moveClip(clips, "c", 6000, false))).toEqual([
			"a:0-1000@0",
			"b:1000-3000@1000",
			"c:6000-7000@3000",
		]);
	});
});

describe("remapTimelineRegions", () => {
	it("moves regions with the clip they sit on", () => {
		const before = [clip("a", 0, 1000), clip("b", 1000, 3000)];
		const after = moveClip(before, "b", 0, true);
		const zooms = [
			{ id: "z1", startMs: 200, endMs: 600 },
			{ id: "z2", startMs: 1500, endMs: 2500 },
		];
		expect(remapTimelineRegions(zooms, before, after)).toEqual([
			{ id: "z1", startMs: 2200, endMs: 2600 },
			{ id: "z2", startMs: 500, endMs: 1500 },
		]);
	});

	it("returns the input when nothing moved", () => {
		const clips = [clip("a", 0, 1000)];
		const zooms = [{ startMs: 0, endMs: 10 }];
		expect(remapTimelineRegions(zooms, clips, clips)).toBe(zooms);
	});
});

describe("source mapping with moved clips", () => {
	// Source 3000-4000 plays first, then source 0-1000.
	const reordered = [clip("c", 0, 1000, 3000), clip("a", 1000, 2000, 0)];

	it("maps both directions through each clip", () => {
		expect(mapTimelineTimeToSourceTime(500, reordered)).toBe(3500);
		expect(mapTimelineTimeToSourceTime(1500, reordered)).toBe(500);
		expect(mapSourceTimeToTimelineTime(3500, reordered)).toBe(500);
		expect(mapSourceTimeToTimelineTime(500, reordered)).toBe(1500);
	});

	it("clamps unused source time to the nearest clip boundary", () => {
		// Source 2000 is cut; its nearest boundaries are c's start (3000) and a's end (1000).
		expect(mapSourceTimeToTimelineTime(1900, reordered)).toBe(2000);
	});

	it("lists playback segments in timeline order and detects reordering", () => {
		const segments = getPlaybackSegments(reordered);
		expect(segments.map((s) => [s.clipId, s.sourceStartMs, s.sourceEndMs])).toEqual([
			["c", 3000, 4000],
			["a", 0, 1000],
		]);
		expect(isSourceOrderMonotonic(segments)).toBe(false);
		expect(isSourceOrderMonotonic(getPlaybackSegments([clip("a", 0, 1000)]))).toBe(true);
	});

	it("splits timeline regions that span reordered clips into source pieces", () => {
		const zooms = [{ id: "z", startMs: 800, endMs: 1200 }];
		expect(mapTimelineRegionsToSource(zooms, reordered)).toEqual([
			{ id: "z", startMs: 3800, endMs: 4000 },
			{ id: "z#2", startMs: 0, endMs: 200 },
		]);
	});

	it("derives trims from source coverage", () => {
		expect(clipsToTrims(reordered, 5000).map((t) => [t.startMs, t.endMs])).toEqual([
			[1000, 3000],
			[4000, 5000],
		]);
	});
});

describe("moveClip leading edge", () => {
	const clips = [clip("a", 0, 1000), clip("b", 1000, 3000), clip("c", 3000, 4000)];

	it("keeps order for a small nudge", () => {
		expect(layout(moveClip(clips, "b", 1200, true))).toEqual([
			"a:0-1000@0",
			"b:1000-3000@1000",
			"c:3000-4000@3000",
		]);
	});

	it("swaps once the right edge passes the next clip's midpoint", () => {
		expect(
			layout(moveClip(clips, "b", 1600, true)).map((entry) => entry.split(":")[0]),
		).toEqual(["a", "c", "b"]);
	});
});

describe("trimClipEdges", () => {
	// b shows source 4000-6000; a shows 0-2000; c shows 8000-9000.
	const a = clip("a", 0, 2000, 0);
	const b = clip("b", 2000, 4000, 4000);
	const c = clip("c", 4000, 5000, 8000);

	it("trims the head by moving the source start", () => {
		expect(layout([trimClipEdges(b, { startMs: 2500, endMs: 4000 }, [a, c], 10_000)])).toEqual([
			"b:2500-4000@4500",
		]);
	});

	it("extends into unused footage but stops at footage another clip shows", () => {
		// Extending b's head by 3s would reach source 1000, inside a (0-2000): stop at 2000.
		expect(layout([trimClipEdges(b, { startMs: -1000, endMs: 4000 }, [a, c], 10_000)])).toEqual(
			["b:0-4000@2000"],
		);
		// Extending the tail by 5s stops at c's footage (8000).
		expect(layout([trimClipEdges(b, { startMs: 2000, endMs: 9000 }, [a, c], 10_000)])).toEqual([
			"b:2000-6000@4000",
		]);
	});

	it("stops at the ends of the recording", () => {
		expect(layout([trimClipEdges(c, { startMs: 4000, endMs: 9000 }, [a, b], 10_000)])).toEqual([
			"c:4000-6000@8000",
		]);
	});

	it("keeps a minimum length", () => {
		expect(layout([trimClipEdges(b, { startMs: 3990, endMs: 4000 }, [a, c], 10_000)])).toEqual([
			"b:3900-4000@5900",
		]);
	});

	it("maps edge moves through clip speed", () => {
		const fast: ClipRegion = {
			id: "f",
			startMs: 0,
			endMs: 1000,
			speed: 2,
			sourceStartMs: 1000,
		};
		// Trimming 500ms of timeline off the head removes 1000ms of source at 2x.
		expect(layout([trimClipEdges(fast, { startMs: 500, endMs: 1000 }, [], 10_000)])).toEqual([
			"f:500-1000@2000",
		]);
	});
});
