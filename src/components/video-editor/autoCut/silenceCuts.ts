import type { SilenceCut, SourceRange, TranscriptWord } from "./types";

export interface SilenceCutOptions {
	/** Only pauses at least this long are shortened. */
	minGapMs: number;
	/** Silence left on each side of a cut so speech doesn't feel clipped. */
	keepMs: number;
	/** Source ranges to search (the clips in scope). */
	ranges: SourceRange[];
	/**
	 * Acoustic silence (ffmpeg silencedetect). When given, only audio that is
	 * actually silent is cut — a gap that holds an untranscribed "um" or a
	 * mumbled word keeps that sound. Without it, word gaps are used.
	 */
	acousticSilences?: SourceRange[] | null;
	/** How far a word's timing may bleed into real silence before it blocks a cut. */
	wordToleranceMs?: number;
}

export function detectSilenceCuts(
	words: TranscriptWord[],
	options: SilenceCutOptions,
): SilenceCut[] {
	const cuts: SilenceCut[] = [];
	const tolerance = options.wordToleranceMs ?? 120;
	const sortedWords = [...words].sort((left, right) => left.startMs - right.startMs);

	for (const range of mergeRanges(options.ranges)) {
		const candidates = options.acousticSilences
			? subtractRanges(
					intersectRanges(mergeRanges(options.acousticSilences), [range]),
					sortedWords.map((word) => {
						// Never shrink a short word away entirely — it must still block.
						const shrink = Math.min(tolerance, (word.endMs - word.startMs) / 3);
						return { startMs: word.startMs + shrink, endMs: word.endMs - shrink };
					}),
				)
			: wordGaps(sortedWords, range);

		for (const gap of candidates) {
			if (gap.endMs - gap.startMs < options.minGapMs) {
				continue;
			}
			// Dead air at the very start/end of a clip is removed entirely; a pause
			// between words keeps a little breathing room on both sides.
			const atStart = gap.startMs <= range.startMs;
			const atEnd = gap.endMs >= range.endMs;
			const startMs = atStart ? range.startMs : gap.startMs + options.keepMs;
			const endMs = atEnd ? range.endMs : gap.endMs - options.keepMs;
			if (endMs - startMs < 1) {
				continue;
			}
			cuts.push({
				id: `silence-${Math.round(startMs)}-${Math.round(endMs)}`,
				startMs: Math.round(startMs),
				endMs: Math.round(endMs),
			});
		}
	}

	return cuts;
}

function wordGaps(words: TranscriptWord[], range: SourceRange): SourceRange[] {
	const inside = words.filter((word) => word.endMs > range.startMs && word.startMs < range.endMs);
	if (inside.length === 0) {
		return [{ ...range }];
	}
	const gaps: SourceRange[] = [];
	let cursor = range.startMs;
	for (const word of inside) {
		if (word.startMs > cursor) {
			gaps.push({ startMs: cursor, endMs: word.startMs });
		}
		cursor = Math.max(cursor, word.endMs);
	}
	if (cursor < range.endMs) {
		gaps.push({ startMs: cursor, endMs: range.endMs });
	}
	return gaps;
}

/** Sort and merge overlapping or touching ranges; drops empty ones. */
export function mergeRanges(ranges: SourceRange[]): SourceRange[] {
	const sorted = ranges
		.filter((range) => range.endMs > range.startMs)
		.map((range) => ({ startMs: range.startMs, endMs: range.endMs }))
		.sort((left, right) => left.startMs - right.startMs);
	const merged: SourceRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.startMs <= last.endMs) {
			last.endMs = Math.max(last.endMs, range.endMs);
		} else {
			merged.push(range);
		}
	}
	return merged;
}

export function intersectRanges(left: SourceRange[], right: SourceRange[]): SourceRange[] {
	const result: SourceRange[] = [];
	for (const a of left) {
		for (const b of right) {
			const startMs = Math.max(a.startMs, b.startMs);
			const endMs = Math.min(a.endMs, b.endMs);
			if (endMs > startMs) {
				result.push({ startMs, endMs });
			}
		}
	}
	return mergeRanges(result);
}

export function subtractRanges(from: SourceRange[], remove: SourceRange[]): SourceRange[] {
	const removals = mergeRanges(remove);
	const result: SourceRange[] = [];
	for (const range of mergeRanges(from)) {
		let cursor = range.startMs;
		for (const removal of removals) {
			if (removal.endMs <= cursor || removal.startMs >= range.endMs) {
				continue;
			}
			if (removal.startMs > cursor) {
				result.push({ startMs: cursor, endMs: removal.startMs });
			}
			cursor = Math.max(cursor, removal.endMs);
		}
		if (cursor < range.endMs) {
			result.push({ startMs: cursor, endMs: range.endMs });
		}
	}
	return result;
}
