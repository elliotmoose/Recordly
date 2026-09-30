import { describe, expect, it } from "vitest";
import type { AudioRegion, ClipRegion } from "../types";
import { buildExportAudioTimeline, getReorderedSourceOrder } from "./buildExportRenderOptions";

const music: AudioRegion = {
	id: "music",
	startMs: 500,
	endMs: 1500,
	audioPath: "/music.mp3",
	volume: 1,
};

describe("getReorderedSourceOrder", () => {
	it("is undefined for in-order clips so exports keep using trims", () => {
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
			{ id: "b", startMs: 1000, endMs: 2000, speed: 1, sourceStartMs: 3000 },
		];
		expect(getReorderedSourceOrder(clips)).toBeUndefined();
	});

	it("lists source ranges in timeline order when reordered", () => {
		const clips: ClipRegion[] = [
			{ id: "b", startMs: 0, endMs: 1000, speed: 1, sourceStartMs: 3000 },
			{ id: "a", startMs: 1000, endMs: 2000, speed: 1, sourceStartMs: 0 },
		];
		expect(getReorderedSourceOrder(clips)).toEqual([
			{ startMs: 3000, endMs: 4000 },
			{ startMs: 0, endMs: 1000 },
		]);
	});
});

describe("buildExportAudioTimeline", () => {
	it("leaves regions alone when the timeline equals the source", () => {
		const clips: ClipRegion[] = [{ id: "a", startMs: 0, endMs: 5000, speed: 1 }];
		expect(buildExportAudioTimeline(clips, [music])).toEqual({ audioRegions: [music] });
	});

	it("maps regions onto the source after clips were packed (ripple)", () => {
		// Source 2000-7000 now sits at the start of the timeline.
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 5000, speed: 1, sourceStartMs: 2000 },
		];
		expect(buildExportAudioTimeline(clips, [music]).audioRegions[0]).toMatchObject({
			startMs: 2500,
			endMs: 3500,
		});
	});

	it("hands the renderer the clip order when reordered", () => {
		const clips: ClipRegion[] = [
			{ id: "b", startMs: 0, endMs: 1000, speed: 1, sourceStartMs: 3000 },
			{ id: "a", startMs: 1000, endMs: 2000, speed: 1, sourceStartMs: 0 },
		];
		const result = buildExportAudioTimeline(clips, [music]);
		expect(result.audioRegions).toEqual([music]);
		expect(result.audioTimelineOrder?.sourceOrder).toEqual([
			{ startMs: 3000, endMs: 4000 },
			{ startMs: 0, endMs: 1000 },
		]);
	});
});
