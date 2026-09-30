import { type ClipRegion, getClipSourceEndMs, getClipSourceStartMs } from "../types";
import { mergeRanges, subtractRanges } from "./silenceCuts";
import type { RetakeDecision, RetakeGroup, SourceRange, TranscriptWord, Utterance } from "./types";

/** Pieces shorter than this after cutting are dropped rather than kept as slivers. */
const MIN_CLIP_PIECE_MS = 40;

/** Source range of each clip currently on the timeline. */
export function getClipSourceRanges(clips: ClipRegion[]): SourceRange[] {
	return clips.map((clip) => ({
		startMs: getClipSourceStartMs(clip),
		endMs: getClipSourceEndMs(clip),
	}));
}

/**
 * Source range removing words `first..last` (inclusive) together with the
 * pauses around them, leaving up to `keepMs` of silence next to the words
 * that stay so the join doesn't clip them.
 */
export function wordRunRemovalRange(
	words: TranscriptWord[],
	first: number,
	last: number,
	keepMs: number,
): SourceRange {
	const before = words[first - 1];
	const after = words[last + 1];
	const startMs = before
		? Math.max(
				before.endMs + Math.min(keepMs, (words[first].startMs - before.endMs) / 2),
				before.endMs,
			)
		: words[first].startMs;
	const endMs = after
		? Math.min(
				after.startMs - Math.min(keepMs, (after.startMs - words[last].endMs) / 2),
				after.startMs,
			)
		: words[last].endMs;
	return {
		startMs: Math.round(Math.min(startMs, words[first].startMs)),
		endMs: Math.round(Math.max(endMs, words[last].endMs)),
	};
}

/** How far a cut edge may move to land inside real silence. */
const SILENCE_SNAP_WINDOW_MS = 500;

/**
 * Move a cut's edges into the nearest acoustic silence, leaving up to `keepMs`
 * of it next to the speech that stays. Transcriber word times drift by a few
 * hundred ms; the audio doesn't, so this keeps cuts from clipping syllables.
 */
export function snapRangeToSilence(
	range: SourceRange,
	silences: SourceRange[],
	keepMs: number,
): SourceRange {
	const nearest = (edge: number) => {
		let best: SourceRange | null = null;
		let bestDistance = SILENCE_SNAP_WINDOW_MS;
		for (const silence of silences) {
			const distance =
				edge < silence.startMs
					? silence.startMs - edge
					: edge > silence.endMs
						? edge - silence.endMs
						: 0;
			if (distance <= bestDistance) {
				best = silence;
				bestDistance = distance;
			}
		}
		return best;
	};

	const before = nearest(range.startMs);
	const after = nearest(range.endMs);
	const startMs = before
		? before.startMs + Math.min(keepMs, (before.endMs - before.startMs) / 2)
		: range.startMs;
	const endMs = after
		? after.endMs - Math.min(keepMs, (after.endMs - after.startMs) / 2)
		: range.endMs;
	return endMs > startMs ? { startMs: Math.round(startMs), endMs: Math.round(endMs) } : range;
}

/** Source ranges to remove so that only the chosen take of a group remains. */
export function retakeRemovalRanges(
	group: RetakeGroup,
	decision: RetakeDecision | undefined,
	utterances: Utterance[],
	words: TranscriptWord[],
	keepMs: number,
	acousticSilences?: SourceRange[] | null,
): SourceRange[] {
	if (decision === undefined || decision === "all" || !group.takes[decision]) {
		return [];
	}

	const byId = new Map(utterances.map((utterance) => [utterance.id, utterance]));
	const keptIds = new Set(group.takes[decision].utteranceIds);
	const removedWords = new Set<number>();
	const groupUtteranceIds = [
		...group.takes.flatMap((take) => take.utteranceIds),
		...group.junkUtteranceIds,
	];
	for (const id of groupUtteranceIds) {
		const utterance = byId.get(id);
		if (!utterance || keptIds.has(id)) {
			continue;
		}
		for (let index = utterance.firstWord; index <= utterance.lastWord; index += 1) {
			removedWords.add(index);
		}
	}

	const sorted = [...removedWords].sort((left, right) => left - right);
	const ranges: SourceRange[] = [];
	let runStart = sorted[0];
	for (let index = 0; index < sorted.length; index += 1) {
		const current = sorted[index];
		const next = sorted[index + 1];
		if (next !== current + 1) {
			ranges.push(wordRunRemovalRange(words, runStart, current, keepMs));
			runStart = next;
		}
	}
	return mergeRanges(
		acousticSilences?.length
			? ranges.map((range) => snapRangeToSilence(range, acousticSilences, keepMs))
			: ranges,
	);
}

/**
 * Remove source ranges from the clips. Each clip keeps its speed; the pieces
 * that survive become separate clips so export and playback skip the removed
 * audio/video. The first piece keeps the original clip id.
 */
export function removeSourceRangesFromClips(
	clips: ClipRegion[],
	ranges: SourceRange[],
	createClipId: () => string,
): ClipRegion[] {
	const removals = mergeRanges(ranges);
	if (removals.length === 0) {
		return clips;
	}

	let changed = false;
	const next = clips.flatMap((clip) => {
		const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
		const source = { startMs: getClipSourceStartMs(clip), endMs: getClipSourceEndMs(clip) };
		const pieces = subtractRanges([source], removals).filter(
			(piece) => piece.endMs - piece.startMs >= MIN_CLIP_PIECE_MS,
		);
		if (
			pieces.length === 1 &&
			pieces[0].startMs === source.startMs &&
			pieces[0].endMs === source.endMs
		) {
			return [clip];
		}
		changed = true;
		return pieces.map((piece, index) => {
			// Each surviving piece stays where its content sat on the timeline;
			// ripple (if on) closes the gaps afterwards.
			const timelineStartMs = clip.startMs + (piece.startMs - source.startMs) / speed;
			return {
				...clip,
				id: index === 0 ? clip.id : createClipId(),
				startMs: Math.round(timelineStartMs),
				endMs: Math.round(timelineStartMs + (piece.endMs - piece.startMs) / speed),
				sourceStartMs: Math.round(piece.startMs),
			};
		});
	});
	return changed ? next : clips;
}

export function totalRangeMs(ranges: SourceRange[]): number {
	return mergeRanges(ranges).reduce((total, range) => total + (range.endMs - range.startMs), 0);
}
