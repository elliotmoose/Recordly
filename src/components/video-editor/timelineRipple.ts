import { type ClipRegion, getClipSourceStartMs, sortClipRegions } from "./types";

/**
 * Close every gap: clips keep their order and durations and are laid end to
 * end from 0. Returns the input array when it is already packed.
 */
export function packClips(clips: ClipRegion[]): ClipRegion[] {
	const sorted = sortClipRegions(clips);
	let cursor = 0;
	let changed = sorted.some((clip, index) => clip !== clips[index]);
	const packed = sorted.map((clip) => {
		const durationMs = Math.max(0, clip.endMs - clip.startMs);
		const next =
			clip.startMs === cursor
				? clip
				: {
						...clip,
						startMs: cursor,
						endMs: cursor + durationMs,
						sourceStartMs: getClipSourceStartMs(clip),
					};
		if (next !== clip) {
			changed = true;
		}
		cursor += durationMs;
		return next;
	});
	return changed ? packed : clips;
}

/**
 * Move a clip. With ripple on, the clip is re-inserted where it was dropped
 * (by its centre relative to the other clips' centres) and the sequence is
 * re-packed, so the clips it passes shift to make room. With ripple off it
 * just goes where it was dropped; the caller rejects overlaps.
 */
export function moveClip(
	clips: ClipRegion[],
	clipId: string,
	dropStartMs: number,
	ripple: boolean,
): ClipRegion[] {
	const moving = clips.find((clip) => clip.id === clipId);
	if (!moving) {
		return clips;
	}
	const durationMs = moving.endMs - moving.startMs;
	const moved: ClipRegion = {
		...moving,
		startMs: Math.round(dropStartMs),
		endMs: Math.round(dropStartMs + durationMs),
		sourceStartMs: getClipSourceStartMs(moving),
	};
	if (!ripple) {
		return clips.map((clip) => (clip.id === clipId ? moved : clip));
	}

	const others = sortClipRegions(clips.filter((clip) => clip.id !== clipId));
	// The leading edge decides: dragging right, the clip passes a neighbour once
	// its right edge crosses the neighbour's midpoint; dragging left, its left edge.
	const probeMs = dropStartMs > moving.startMs ? dropStartMs + durationMs : dropStartMs;
	let insertAt = others.findIndex((clip) => probeMs < (clip.startMs + clip.endMs) / 2);
	if (insertAt < 0) {
		insertAt = others.length;
	}
	const ordered = [...others.slice(0, insertAt), moved, ...others.slice(insertAt)];
	// Assign order-preserving positions, then pack from 0.
	let cursor = 0;
	return ordered.map((clip) => {
		const clipDurationMs = clip.endMs - clip.startMs;
		const placed =
			clip.startMs === cursor && clip !== moved
				? clip
				: {
						...clip,
						startMs: cursor,
						endMs: cursor + clipDurationMs,
						sourceStartMs: getClipSourceStartMs(clip),
					};
		cursor += clipDurationMs;
		return placed;
	});
}

/**
 * Keep timeline-time regions (zooms, annotations, audio) attached to the clip
 * they sit on when clips move. A region is anchored to the clip containing
 * its start (or, in a gap, the last clip before it) and shifts by that clip's
 * offset; its length is unchanged. Regions before every clip stay put.
 */
export function remapTimelineRegions<T extends { startMs: number; endMs: number }>(
	regions: T[],
	before: ClipRegion[],
	after: ClipRegion[],
): T[] {
	if (before === after || regions.length === 0) {
		return regions;
	}
	const afterById = new Map(after.map((clip) => [clip.id, clip]));
	const sortedBefore = sortClipRegions(before);

	let changed = false;
	const next = regions.map((region) => {
		const anchor =
			sortedBefore.find(
				(clip) => region.startMs >= clip.startMs && region.startMs < clip.endMs,
			) ?? [...sortedBefore].reverse().find((clip) => clip.endMs <= region.startMs);
		const moved = anchor ? afterById.get(anchor.id) : undefined;
		if (!anchor || !moved) {
			return region;
		}
		const deltaMs = moved.startMs - anchor.startMs;
		if (deltaMs === 0) {
			return region;
		}
		changed = true;
		return { ...region, startMs: region.startMs + deltaMs, endMs: region.endMs + deltaMs };
	});
	return changed ? next : regions;
}
