import type { RetakeGroup, RetakeTake, SourceRange, Utterance } from "./types";

export interface RetakeDetectionOptions {
	/** A later attempt must start within this long after the earlier one. */
	maxDistanceMs?: number;
	/** How many substantive utterances a single take may span. */
	maxTakeUtterances?: number;
	/** Only utterances inside these source ranges are considered. */
	ranges?: SourceRange[];
}

const MIN_TOKENS = 3;
/** Groups that would have this many takes or more are treated as patterns. */
const MAX_TAKES = 4;

/** Length of the longest common subsequence of two token lists. */
export function lcsLength(left: string[], right: string[]): number {
	const previous = new Array<number>(right.length + 1).fill(0);
	const current = new Array<number>(right.length + 1).fill(0);
	for (let i = 1; i <= left.length; i += 1) {
		for (let j = 1; j <= right.length; j += 1) {
			current[j] =
				left[i - 1] === right[j - 1]
					? previous[j - 1] + 1
					: Math.max(previous[j], current[j - 1]);
		}
		previous.splice(0, previous.length, ...current);
	}
	return previous[right.length];
}

function commonPrefixLength(left: string[], right: string[]) {
	let length = 0;
	while (length < left.length && length < right.length && left[length] === right[length]) {
		length += 1;
	}
	return length;
}

const NUMBER_WORDS = new Set([
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"first",
	"second",
	"third",
	"fourth",
	"fifth",
	"next",
	"last",
]);

function isNumberToken(token: string) {
	return /^\d+$/.test(token) || NUMBER_WORDS.has(token);
}

/**
 * True when the two lines differ in a number ("step 2" vs "step 3"). That is
 * an enumeration the speaker is walking through, not a second attempt.
 */
function differsInNumbers(earlier: string[], later: string[]) {
	const earlierNumbers = earlier.filter(isNumberToken);
	const laterNumbers = later.filter(isNumberToken);
	return (
		earlierNumbers.length > 0 &&
		laterNumbers.length > 0 &&
		earlierNumbers.join(" ") !== laterNumbers.slice(0, earlierNumbers.length).join(" ")
	);
}

/**
 * Why `later` looks like another attempt at `earlier`, or null. Retakes almost
 * always restart the same way, so a shared opening is the strongest signal; a
 * high in-order word overlap catches restarts with a changed first word. When
 * the speaker flagged the retake ("sorry", "no wait"), a looser match counts.
 */
export function describeRetakeSimilarity(
	earlier: string[],
	later: string[],
	options: { afterCue?: boolean } = {},
): string | null {
	const shorter = Math.min(earlier.length, later.length);
	if (shorter < MIN_TOKENS || differsInNumbers(earlier, later)) {
		return null;
	}

	const prefix = commonPrefixLength(earlier, later);
	if (prefix >= 4 || (prefix >= MIN_TOKENS && prefix / shorter >= 0.6)) {
		return `Both start with "${later.slice(0, prefix).join(" ")}"`;
	}

	const lcs = lcsLength(earlier, later);
	const minLongerRatio = options.afterCue ? 0.35 : 0.5;
	if (
		lcs >= 4 &&
		lcs / shorter >= 0.8 &&
		lcs / Math.max(earlier.length, later.length) >= minLongerRatio
	) {
		return `${Math.round((lcs / shorter) * 100)}% of the words repeat in order`;
	}

	return null;
}

/**
 * Group repeated attempts at the same line. Each group lists its takes in
 * order; cue phrases ("sorry, let me redo that") between takes are junk that
 * gets removed whichever take is kept. Which take to keep is left to the user.
 */
export function detectRetakeGroups(
	utterances: Utterance[],
	options: RetakeDetectionOptions = {},
): RetakeGroup[] {
	const maxDistanceMs = options.maxDistanceMs ?? 60_000;
	const maxTakeUtterances = options.maxTakeUtterances ?? 2;
	const inScope = (utterance: Utterance) =>
		!options.ranges ||
		options.ranges.some(
			(range) => utterance.startMs >= range.startMs && utterance.endMs <= range.endMs,
		);
	const units = buildComparisonUnits(utterances.filter(inScope));
	const groups: RetakeGroup[] = [];
	let index = 0;

	while (index < units.length) {
		const group = growGroupFrom(units, index, maxDistanceMs, maxTakeUtterances);
		if (!group) {
			index += 1;
			continue;
		}
		groups.push(group.group);
		index = group.nextIndex;
	}

	return groups;
}

/** One or more consecutive utterances compared as a single line. */
interface ComparisonUnit {
	utteranceIds: number[];
	startMs: number;
	endMs: number;
	text: string;
	tokens: string[];
	isCue: boolean;
}

/** Short sentences closer than this to the next one are compared together with it. */
const SHORT_UTTERANCE_JOIN_MS = 800;

/**
 * Merge very short utterances ("Click export.") into the utterance that follows
 * closely, so a line made of short sentences can still be matched as a whole.
 */
function buildComparisonUnits(utterances: Utterance[]): ComparisonUnit[] {
	const units: ComparisonUnit[] = [];
	for (const utterance of utterances) {
		const previous = units[units.length - 1];
		if (
			previous &&
			!previous.isCue &&
			!utterance.isCue &&
			previous.tokens.length < MIN_TOKENS &&
			utterance.startMs - previous.endMs < SHORT_UTTERANCE_JOIN_MS
		) {
			previous.utteranceIds.push(utterance.id);
			previous.endMs = utterance.endMs;
			previous.text = `${previous.text} ${utterance.text}`;
			previous.tokens = [...previous.tokens, ...utterance.tokens];
			continue;
		}
		units.push({
			utteranceIds: [utterance.id],
			startMs: utterance.startMs,
			endMs: utterance.endMs,
			text: utterance.text,
			tokens: [...utterance.tokens],
			isCue: utterance.isCue,
		});
	}
	return units;
}

function growGroupFrom(
	units: ComparisonUnit[],
	startIndex: number,
	maxDistanceMs: number,
	maxTakeUtterances: number,
) {
	const first = units[startIndex];
	if (first.isCue || first.tokens.length < MIN_TOKENS) {
		return null;
	}

	const takes: ComparisonUnit[][] = [];
	const junk: ComparisonUnit[] = [];
	const reasons: string[] = [];
	let takeStart = startIndex;

	for (;;) {
		const match = findNextAttempt(units, takeStart, maxDistanceMs, maxTakeUtterances);
		if (!match) {
			break;
		}
		// The current take runs up to the next attempt, minus trailing cue phrases.
		const between = units.slice(takeStart, match.index);
		let takeEnd = between.length;
		while (takeEnd > 1 && between[takeEnd - 1].isCue) {
			takeEnd -= 1;
		}
		takes.push(between.slice(0, takeEnd));
		junk.push(...between.slice(takeEnd));
		reasons.push(match.reason);
		takeStart = match.index;
	}

	// More than a few "attempts" in a row is a pattern the speaker is repeating
	// on purpose (a list, a refrain), not someone redoing a line.
	if (takes.length === 0 || takes.length >= MAX_TAKES) {
		return null;
	}

	// The final attempt spans as many units as the previous take, as long as
	// they line up with it.
	const previousTake = takes[takes.length - 1];
	const lastTake = [units[takeStart]];
	for (let offset = 1; offset < previousTake.length; offset += 1) {
		const candidate = units[takeStart + offset];
		const counterpart = previousTake[offset];
		if (
			!candidate ||
			candidate.isCue ||
			!describeRetakeSimilarity(counterpart.tokens, candidate.tokens)
		) {
			break;
		}
		lastTake.push(candidate);
	}
	takes.push(lastTake);

	const retakeTakes: RetakeTake[] = takes.map((take) => ({
		startMs: take[0].startMs,
		endMs: take[take.length - 1].endMs,
		utteranceIds: take.flatMap((unit) => unit.utteranceIds),
		text: take.map((unit) => unit.text).join(" "),
	}));

	return {
		group: {
			id: `retake-${first.utteranceIds[0]}`,
			startMs: retakeTakes[0].startMs,
			endMs: retakeTakes[retakeTakes.length - 1].endMs,
			takes: retakeTakes,
			junkUtteranceIds: junk.flatMap((unit) => unit.utteranceIds),
			source: "heuristic" as const,
			reason: reasons[0],
		},
		nextIndex: takeStart + lastTake.length,
	};
}

/**
 * The next unit that restarts the take beginning at `takeStart`. Only cue
 * phrases, fillers and up to `maxTakeUtterances - 1` continuation units may
 * sit in between — otherwise the speaker moved on and a later repeat is
 * deliberate, not a retake.
 */
function findNextAttempt(
	units: ComparisonUnit[],
	takeStart: number,
	maxDistanceMs: number,
	maxTakeUtterances: number,
) {
	const anchor = units[takeStart];
	let substantiveSeen = 1;
	let afterCue = false;

	for (let index = takeStart + 1; index < units.length; index += 1) {
		const candidate = units[index];
		if (candidate.startMs - anchor.startMs > maxDistanceMs) {
			return null;
		}
		if (candidate.isCue) {
			afterCue = true;
			continue;
		}
		const reason = describeRetakeSimilarity(anchor.tokens, candidate.tokens, { afterCue });
		if (reason) {
			return { index, reason };
		}
		if (candidate.tokens.length >= MIN_TOKENS) {
			substantiveSeen += 1;
			if (substantiveSeen > maxTakeUtterances) {
				return null;
			}
		}
	}

	return null;
}
