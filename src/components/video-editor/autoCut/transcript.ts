import type { CaptionCue } from "../types";
import type { TranscriptWord, Utterance } from "./types";

/**
 * Words from caption cues, in source time. Only cues with real per-word timings
 * contribute individual words; a cue without them becomes one "word" spanning the
 * cue, which is still enough to know where speech is.
 */
export function transcriptWordsFromCaptions(cues: CaptionCue[]): TranscriptWord[] {
	const words: TranscriptWord[] = [];
	for (const cue of cues) {
		const cueWords = (cue.words ?? []).filter(
			(word) =>
				word.text.trim().length > 0 &&
				Number.isFinite(word.startMs) &&
				Number.isFinite(word.endMs) &&
				word.endMs > word.startMs,
		);
		if (cueWords.length > 0) {
			for (const word of cueWords) {
				words.push({ text: word.text.trim(), startMs: word.startMs, endMs: word.endMs });
			}
		} else if (cue.text.trim() && cue.endMs > cue.startMs) {
			words.push({ text: cue.text.trim(), startMs: cue.startMs, endMs: cue.endMs });
		}
	}
	return words.sort((left, right) => left.startMs - right.startMs);
}

const FILLER_TOKENS = new Set([
	"um",
	"umm",
	"uh",
	"uhh",
	"uhm",
	"er",
	"erm",
	"ah",
	"eh",
	"hmm",
	"mm",
	"mhm",
]);

/** Lower-case, punctuation-free tokens with filler sounds removed. */
export function normalizeTokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[’']/g, "")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length > 0 && !FILLER_TOKENS.has(token));
}

const CUE_PATTERNS = [
	/\b(let me|lemme|i(?:'|’)?ll|i will|gonna|going to) (re ?do|redo|try|start|say|do) (that|this|it)?\s*(again|over)\b/,
	/\b(let me|lemme) (re ?do|redo|restart|start over|try again|rephrase)\b/,
	/\b(one more time|take two|take 2|from the top|start over|scratch that|try that again|do that again|once more)\b/,
	/^(sorry|oops|whoops|wait|hold on|no no|actually no|ugh|okay again|ok again)\b/,
];

/** Utterances that are the speaker addressing the retake itself. */
export function isRetakeCue(text: string): boolean {
	const normalized = normalizeTokens(text).join(" ");
	if (!normalized) {
		return true;
	}
	return CUE_PATTERNS.some((pattern) => pattern.test(normalized));
}

const SENTENCE_END = /[.?!…]["')\]]*$/;

export interface SegmentUtterancesOptions {
	/** A word gap at least this long ends an utterance. */
	pauseMs?: number;
}

/** Split the word stream at pauses and sentence ends. */
export function segmentUtterances(
	words: TranscriptWord[],
	options: SegmentUtterancesOptions = {},
): Utterance[] {
	const pauseMs = options.pauseMs ?? 450;
	const utterances: Utterance[] = [];
	let first = 0;

	const flush = (last: number) => {
		if (last < first) {
			return;
		}
		const text = words
			.slice(first, last + 1)
			.map((word) => word.text)
			.join(" ");
		utterances.push({
			id: utterances.length,
			startMs: words[first].startMs,
			endMs: words[last].endMs,
			firstWord: first,
			lastWord: last,
			text,
			tokens: normalizeTokens(text),
			isCue: isRetakeCue(text),
		});
		first = last + 1;
	};

	for (let index = 0; index < words.length; index += 1) {
		const next = words[index + 1];
		const endsSentence = SENTENCE_END.test(words[index].text);
		const pauseAfter = next ? next.startMs - words[index].endMs >= pauseMs : true;
		if (!next || endsSentence || pauseAfter) {
			flush(index);
		}
	}

	return utterances;
}
