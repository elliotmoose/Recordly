/** A transcribed word in source-video time. */
export interface TranscriptWord {
	text: string;
	startMs: number;
	endMs: number;
}

export interface SourceRange {
	startMs: number;
	endMs: number;
}

/** A stretch of dead air proposed for removal. */
export interface SilenceCut extends SourceRange {
	id: string;
}

/** A run of words between pauses / sentence ends — the unit retakes are compared in. */
export interface Utterance extends SourceRange {
	id: number;
	/** Inclusive word indices into the transcript. */
	firstWord: number;
	lastWord: number;
	text: string;
	/** Normalised comparison tokens (lower-case, no punctuation, no fillers). */
	tokens: string[];
	/** "sorry, let me redo that" and similar — always removed inside a retake group. */
	isCue: boolean;
}

/** One attempt at a line: one or more consecutive utterances. */
export interface RetakeTake extends SourceRange {
	utteranceIds: number[];
	text: string;
}

export interface RetakeGroup extends SourceRange {
	id: string;
	takes: RetakeTake[];
	/** Utterances inside the group that belong to no take (cue phrases, fillers). */
	junkUtteranceIds: number[];
	source: "heuristic" | "llm";
	/** Short human-readable reason shown in the review panel. */
	reason: string;
}

/** Index of the take to keep, or "all" when the user says it isn't a retake. */
export type RetakeDecision = number | "all";
