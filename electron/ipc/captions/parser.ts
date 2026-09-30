import type {
	CaptionCuePayload,
	CaptionWordPayload,
	WhisperJsonSegment,
	WhisperJsonToken,
} from "../types";

const WHISPER_SPECIAL_TOKEN = /^(\[_[A-Z0-9_]+\]|<\|[^|]*\|>)$/;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function buildCaptionTextFromWords(words: CaptionWordPayload[]): string {
	return words
		.map((word, index) => `${index > 0 && word.leadingSpace ? " " : ""}${word.text}`)
		.join("")
		.trim();
}

/**
 * DTW token times land slightly after the word is heard (measured +180–380ms
 * against acoustic onsets), so words start this much earlier.
 */
export const DTW_ONSET_LEAD_MS = 150;

export function parseWhisperJsonWords(tokens: unknown): CaptionWordPayload[] {
	if (!Array.isArray(tokens)) {
		return [];
	}

	const words: CaptionWordPayload[] = [];
	// Per word: DTW time of its first token (ms, or null) and its token duration.
	const dtwStarts: Array<number | null> = [];
	const tokenDurations: number[] = [];
	let nextLeadingSpace = false;

	for (const token of tokens) {
		if (!token || typeof token !== "object") {
			continue;
		}

		const tokenData = token as WhisperJsonToken;
		const tokenText = typeof tokenData.text === "string" ? tokenData.text : "";
		// Control tokens like [_BEG_] / [_TT_150] carry no speech.
		if (!tokenText || WHISPER_SPECIAL_TOKEN.test(tokenText.trim())) {
			continue;
		}

		const tokenStartMs = isFiniteNumber(tokenData.offsets?.from)
			? Math.round(tokenData.offsets.from)
			: null;
		// Whisper often reports zero-length tokens; give them 1ms rather than
		// discarding the timings of the whole segment.
		const tokenEndMs =
			isFiniteNumber(tokenData.offsets?.to) && tokenStartMs != null
				? Math.max(tokenStartMs + 1, Math.round(tokenData.offsets.to))
				: null;
		const dtwMs =
			isFiniteNumber(tokenData.t_dtw) && tokenData.t_dtw >= 0
				? Math.round(tokenData.t_dtw * 10)
				: null;
		const parts = tokenText.match(/\s+|[^\s]+/g) ?? [];

		for (const part of parts) {
			if (/^\s+$/.test(part)) {
				nextLeadingSpace = words.length > 0;
				continue;
			}

			if (tokenStartMs == null || tokenEndMs == null) {
				return [];
			}

			const previousWord = words.length > 0 ? words[words.length - 1] : null;
			if (!previousWord || nextLeadingSpace) {
				words.push({
					text: part,
					startMs: tokenStartMs,
					endMs: tokenEndMs,
					...(words.length > 0 && nextLeadingSpace ? { leadingSpace: true } : {}),
				});
				dtwStarts.push(dtwMs);
				tokenDurations.push(tokenEndMs - tokenStartMs);
			} else {
				previousWord.text += part;
				previousWord.endMs = Math.max(previousWord.endMs, tokenEndMs);
				tokenDurations[tokenDurations.length - 1] += tokenEndMs - tokenStartMs;
			}

			nextLeadingSpace = false;
		}
	}

	const kept = words
		.map((word, index) => ({ word, dtw: dtwStarts[index], duration: tokenDurations[index] }))
		.filter((entry) => entry.word.text.trim().length > 0);

	// Token offsets can be off by over a second at segment starts; DTW times are
	// consistently close, so use them when every word has one.
	if (kept.length > 0 && kept.every((entry) => entry.dtw != null)) {
		const starts: number[] = [];
		for (const entry of kept) {
			const previous = starts[starts.length - 1];
			starts.push(
				Math.max(
					previous == null ? 0 : previous + 1,
					(entry.dtw as number) - DTW_ONSET_LEAD_MS,
				),
			);
		}
		kept.forEach((entry, index) => {
			const next = starts[index + 1];
			const spoken = Math.max(80, entry.duration);
			entry.word.startMs = starts[index];
			entry.word.endMs =
				next == null ? starts[index] + spoken : Math.min(next, starts[index] + spoken);
		});
	}

	return kept.map((entry) => entry.word);
}

export function parseWhisperJsonCues(content: string): CaptionCuePayload[] {
	try {
		const parsed = JSON.parse(content) as {
			transcription?: unknown;
		};

		if (!Array.isArray(parsed.transcription)) {
			return [];
		}

		return parsed.transcription
			.map((segment, index) => {
				if (!segment || typeof segment !== "object") {
					return null;
				}

				const segmentData = segment as WhisperJsonSegment;
				const startMs = isFiniteNumber(segmentData.offsets?.from)
					? Math.round(segmentData.offsets.from)
					: null;
				const endMs = isFiniteNumber(segmentData.offsets?.to)
					? Math.round(segmentData.offsets.to)
					: null;
				const segmentText =
					typeof segmentData.text === "string" ? segmentData.text.trim() : "";

				if (startMs == null || endMs == null || endMs <= startMs) {
					return null;
				}

				const words = parseWhisperJsonWords(segmentData.tokens);
				const text = words.length > 0 ? buildCaptionTextFromWords(words) : segmentText;

				if (!text) {
					return null;
				}

				return {
					id: `caption-${index + 1}`,
					// Word times are more accurate than segment offsets when present.
					startMs: words.length > 0 ? words[0].startMs : startMs,
					endMs: words.length > 0 ? words[words.length - 1].endMs : endMs,
					text,
					...(words.length > 0 ? { words } : {}),
				};
			})
			.filter((cue): cue is CaptionCuePayload => cue != null);
	} catch (error) {
		console.warn("[auto-captions] Failed to parse Whisper JSON output:", error);
		return [];
	}
}

export function parseSrtTimestamp(value: string): number | null {
	const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
	if (!match) {
		return null;
	}

	const [, hours, minutes, seconds, milliseconds] = match;
	return (
		Number(hours) * 60 * 60 * 1000 +
		Number(minutes) * 60 * 1000 +
		Number(seconds) * 1000 +
		Number(milliseconds)
	);
}

export function parseSrtCues(content: string): CaptionCuePayload[] {
	return content
		.split(/\r?\n\r?\n/)
		.map((block, index) => {
			const lines = block.split(/\r?\n/).map((line) => line.trim());
			const timingLine = lines.find((line) => line.includes("-->"));
			if (!timingLine) {
				return null;
			}

			const [rawStart, rawEnd] = timingLine.split("-->").map((part) => part.trim());
			const startMs = parseSrtTimestamp(rawStart);
			const endMs = parseSrtTimestamp(rawEnd);
			if (startMs == null || endMs == null || endMs <= startMs) {
				return null;
			}

			const text = lines
				.slice(lines.indexOf(timingLine) + 1)
				.filter((line) => line.length > 0)
				.join("\n")
				.trim();

			if (!text) {
				return null;
			}

			return {
				id: `caption-${index + 1}`,
				startMs,
				endMs,
				text,
			};
		})
		.filter((cue): cue is CaptionCuePayload => cue != null);
}

export function shouldRetryWhisperWithoutJson(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /unknown argument|output-json-full|output-json|ojf|\boj\b/i.test(message);
}

export function shouldRetryWhisperWithoutDtw(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /unknown argument|dtw|-nfa|flash/i.test(message);
}

/**
 * whisper.cpp's DTW alignment-head preset for a model file, e.g.
 * `ggml-small.bin` → `small`, `ggml-large-v3-turbo-q5_0.bin` → `large.v3.turbo`.
 * Unknown (custom/fine-tuned) models get none; DTW needs the right heads.
 */
export function getWhisperDtwPreset(modelPath: string): string | null {
	const name = modelPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	const match =
		/^ggml-(tiny|base|small|medium|large-v1|large-v2|large-v3|large-v3-turbo)(\.en)?(?:-q\d_\d|-q\d_k)?\.bin$/.exec(
			name,
		);
	if (!match) {
		return null;
	}
	const [, size, english] = match;
	if (english && size.startsWith("large")) {
		return null;
	}
	return `${size.replace(/-/g, ".")}${english ?? ""}`;
}
