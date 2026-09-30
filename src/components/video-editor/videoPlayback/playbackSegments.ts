import { isSourceOrderMonotonic, type PlaybackSegment } from "../types";

/** How close to a segment's end counts as "reached it" (about one frame). */
export const SEGMENT_END_TOLERANCE_MS = 20;

export type PlaybackStep =
	| { action: "stay"; index: number }
	| { action: "jump"; index: number; toSourceMs: number }
	| { action: "end" }
	| { action: "free" };

/**
 * Decide what the preview should do at a source time while playing through
 * the clips in timeline order.
 *
 * - Inside a clip: stay (and remember which clip that is).
 * - Just ran off the end of the current clip: jump to the next clip's start,
 *   which may be anywhere in the source when clips are reordered.
 * - On removed footage otherwise (e.g. at the very start): go to the next clip.
 *   In source order that's the next clip ahead in the source, as before; when
 *   reordered it's the clip after the last one played.
 */
export function resolvePlaybackStep(
	segments: PlaybackSegment[],
	sourceTimeMs: number,
	lastIndex: number,
): PlaybackStep {
	if (segments.length === 0) {
		return { action: "free" };
	}

	const containing = segments.findIndex(
		(segment) =>
			sourceTimeMs >= segment.sourceStartMs &&
			sourceTimeMs < segment.sourceEndMs - SEGMENT_END_TOLERANCE_MS,
	);
	if (containing >= 0) {
		return { action: "stay", index: containing };
	}

	const current = segments[lastIndex];
	const jumpTo = (index: number): PlaybackStep => {
		const next = segments[index];
		if (!next) {
			return { action: "end" };
		}
		// The next clip continues exactly where this one ends (a plain split):
		// keep playing instead of seeking, which would hitch.
		if (current && Math.abs(next.sourceStartMs - current.sourceEndMs) <= 1) {
			return { action: "stay", index };
		}
		return { action: "jump", index, toSourceMs: next.sourceStartMs };
	};

	if (
		current &&
		sourceTimeMs >= current.sourceEndMs - SEGMENT_END_TOLERANCE_MS &&
		sourceTimeMs < current.sourceEndMs + 1000
	) {
		return jumpTo(lastIndex + 1);
	}

	if (isSourceOrderMonotonic(segments)) {
		const next = segments.findIndex((segment) => segment.sourceStartMs >= sourceTimeMs);
		return next >= 0 ? jumpTo(next) : { action: "end" };
	}

	return jumpTo(lastIndex + 1);
}
