import { describe, expect, it } from "vitest";
import type { ClipRegion } from "../types";
import {
	getClipSourceRanges,
	removeSourceRangesFromClips,
	retakeRemovalRanges,
	snapRangeToSilence,
	totalRangeMs,
} from "./applyCuts";
import { detectRetakeGroups, describeRetakeSimilarity } from "./retakeDetection";
import { detectSilenceCuts, mergeRanges, subtractRanges } from "./silenceCuts";
import { isRetakeCue, normalizeTokens, segmentUtterances } from "./transcript";
import type { TranscriptWord } from "./types";

/**
 * Build a word-timed transcript from a script. Strings are spoken phrases
 * (~300ms per word, 60ms between words); numbers are pauses in ms.
 */
function speak(script: Array<string | number>, startMs = 0): TranscriptWord[] {
	const words: TranscriptWord[] = [];
	let cursor = startMs;
	for (const part of script) {
		if (typeof part === "number") {
			cursor += part;
			continue;
		}
		for (const text of part.split(/\s+/).filter(Boolean)) {
			words.push({ text, startMs: cursor, endMs: cursor + 300 });
			cursor += 360;
		}
	}
	return words;
}

const textOf = (words: TranscriptWord[], range: { startMs: number; endMs: number }) =>
	words
		.filter((word) => word.startMs >= range.startMs && word.endMs <= range.endMs)
		.map((word) => word.text)
		.join(" ");

describe("transcript helpers", () => {
	it("normalises tokens and drops fillers", () => {
		expect(normalizeTokens("Um, so THE next—step's uh here.")).toEqual([
			"so",
			"the",
			"next",
			"steps",
			"here",
		]);
	});

	it.each([
		["Sorry, let me redo that.", true],
		["Let me try that again", true],
		["Okay, one more time.", true],
		["Uh, um.", true],
		["So the next step is to open settings.", false],
		["Let me show you the settings panel.", false],
		["No wait.", true],
		["And click next one more time to reach the summary page.", false],
	])("isRetakeCue(%s) = %s", (text, expected) => {
		expect(isRetakeCue(text)).toBe(expected);
	});

	it("splits utterances at pauses and sentence ends", () => {
		const words = speak(["Hello there.", "This is one", 600, "and this is two"]);
		expect(segmentUtterances(words).map((utterance) => utterance.text)).toEqual([
			"Hello there.",
			"This is one",
			"and this is two",
		]);
	});
});

describe("describeRetakeSimilarity", () => {
	const tokens = (text: string) => normalizeTokens(text);

	it("matches restarts that share an opening", () => {
		expect(
			describeRetakeSimilarity(
				tokens("So the next step is to"),
				tokens("So the next step is to open the settings panel"),
			),
		).toMatch(/Both start with/);
	});

	it("matches restarts with a changed first word", () => {
		expect(
			describeRetakeSimilarity(
				tokens("Now we open the settings panel and pick a font"),
				tokens("Okay we open the settings panel and pick a font"),
			),
		).toMatch(/repeat in order/);
	});

	it("does not match different sentences that share common words", () => {
		expect(
			describeRetakeSimilarity(
				tokens("Then we click the export button"),
				tokens("That is the fastest way to do it"),
			),
		).toBeNull();
		expect(describeRetakeSimilarity(tokens("Okay so"), tokens("Okay so"))).toBeNull();
	});
});

describe("detectRetakeGroups", () => {
	it("groups an abandoned attempt, a cue phrase and the retake", () => {
		const words = speak([
			"Welcome to the tutorial.",
			900,
			"So the next step is to",
			700,
			"sorry, let me redo that.",
			1200,
			"So the next step is to open the settings panel.",
			800,
			"Then pick a font.",
		]);
		const utterances = segmentUtterances(words);
		const groups = detectRetakeGroups(utterances);

		expect(groups).toHaveLength(1);
		const [group] = groups;
		expect(group.takes.map((take) => take.text)).toEqual([
			"So the next step is to",
			"So the next step is to open the settings panel.",
		]);
		expect(group.junkUtteranceIds.map((id) => utterances[id].text)).toEqual([
			"sorry, let me redo that.",
		]);
	});

	it("finds three attempts and multi-sentence takes", () => {
		const words = speak([
			"Click export. Choose MP4.",
			1500,
			"Click export. Choose MP4 and",
			1500,
			"Click export. Choose MP4 and save it.",
			1000,
			"Done.",
		]);
		const groups = detectRetakeGroups(segmentUtterances(words));
		expect(groups).toHaveLength(1);
		expect(groups[0].takes.map((take) => take.text)).toEqual([
			"Click export. Choose MP4.",
			"Click export. Choose MP4 and",
			"Click export. Choose MP4 and save it.",
		]);
	});

	it("ignores a deliberate repeat after the speaker moved on", () => {
		const words = speak([
			"Open the settings panel.",
			500,
			"Pick the caption font you like.",
			500,
			"Set the size to forty.",
			500,
			"Now enable the highlight.",
			500,
			"Open the settings panel.",
		]);
		expect(detectRetakeGroups(segmentUtterances(words))).toEqual([]);
	});

	it("respects the source range scope", () => {
		const words = speak(["So the next step is to", 800, "So the next step is to open it."]);
		const utterances = segmentUtterances(words);
		expect(detectRetakeGroups(utterances, { ranges: [{ startMs: 0, endMs: 1000 }] })).toEqual(
			[],
		);
	});
});

describe("retakeRemovalRanges", () => {
	const words = speak([
		"Intro line here.",
		900,
		"So the next step is to",
		700,
		"sorry, let me redo that.",
		1200,
		"So the next step is to open the settings panel.",
		800,
		"Outro line here.",
	]);
	const utterances = segmentUtterances(words);
	const [group] = detectRetakeGroups(utterances);

	it("keeps only the chosen take plus surrounding speech", () => {
		const ranges = retakeRemovalRanges(group, 1, utterances, words, 150);
		const kept = subtractRanges([{ startMs: 0, endMs: 100_000 }], ranges);
		expect(kept.map((range) => textOf(words, range)).join(" ")).toBe(
			"Intro line here. So the next step is to open the settings panel. Outro line here.",
		);
	});

	it("can keep the first take instead", () => {
		const ranges = retakeRemovalRanges(group, 0, utterances, words, 150);
		const kept = subtractRanges([{ startMs: 0, endMs: 100_000 }], ranges);
		expect(kept.map((range) => textOf(words, range)).join(" ")).toBe(
			"Intro line here. So the next step is to Outro line here.",
		);
	});

	it("leaves at most keepMs of pause next to kept words", () => {
		const [range] = retakeRemovalRanges(group, 1, utterances, words, 150);
		const introEnd = words[2].endMs;
		const retakeStart = words.find((word, index) => index > 10 && word.text === "So")!.startMs;
		expect(range.startMs).toBe(introEnd + 150);
		expect(range.endMs).toBe(retakeStart - 150);
	});

	it("removes nothing for 'not a retake' or no decision", () => {
		expect(retakeRemovalRanges(group, "all", utterances, words, 150)).toEqual([]);
		expect(retakeRemovalRanges(group, undefined, utterances, words, 150)).toEqual([]);
	});
});

describe("detectSilenceCuts", () => {
	const words = speak([1500, "First sentence here.", 2000, "Second one.", 300, "Third.", 2500]);
	const range = { startMs: 0, endMs: words[words.length - 1].endMs + 2500 };

	it("shortens long word gaps and trims clip edges", () => {
		const cuts = detectSilenceCuts(words, { minGapMs: 700, keepMs: 150, ranges: [range] });
		expect(cuts).toHaveLength(3);
		// Leading dead air goes, but a little lead-in stays before the first word.
		expect(cuts[0]).toMatchObject({ startMs: 0, endMs: words[0].startMs - 150 });
		expect(cuts[1].startMs).toBe(words[2].endMs + 150);
		expect(cuts[1].endMs).toBe(words[3].startMs - 150);
		expect(cuts[2]).toMatchObject({
			startMs: words[words.length - 1].endMs + 150,
			endMs: range.endMs,
		});
	});

	it("only cuts audio that is acoustically silent when silence data is given", () => {
		// An untranscribed "um" sits in the middle of the 2s gap.
		const gapStart = words[2].endMs;
		const gapEnd = words[3].startMs;
		const acoustic = [
			{ startMs: gapStart + 50, endMs: gapStart + 900 },
			{ startMs: gapStart + 1200, endMs: gapEnd - 40 },
		];
		const cuts = detectSilenceCuts(words, {
			minGapMs: 700,
			keepMs: 150,
			ranges: [range],
			acousticSilences: acoustic,
		});
		expect(cuts).toEqual([
			expect.objectContaining({ startMs: gapStart + 200, endMs: gapStart + 750 }),
			expect.objectContaining({ startMs: gapStart + 1350, endMs: gapEnd - 190 }),
		]);
		// The "um" between the two silences survives.
		for (const cut of cuts) {
			expect(cut.endMs <= gapStart + 900 || cut.startMs >= gapStart + 1200).toBe(true);
		}
	});

	it("never cuts into a transcribed word even if silencedetect calls it silent", () => {
		const cuts = detectSilenceCuts(words, {
			minGapMs: 100,
			keepMs: 0,
			ranges: [range],
			acousticSilences: [{ startMs: 0, endMs: range.endMs }],
		});
		for (const cut of cuts) {
			for (const word of words) {
				const shrink = Math.min(120, (word.endMs - word.startMs) / 3);
				expect(
					cut.endMs <= word.startMs + shrink || cut.startMs >= word.endMs - shrink,
				).toBe(true);
			}
		}
	});
});

describe("removeSourceRangesFromClips", () => {
	let nextId = 10;
	const createId = () => `clip-${nextId++}`;

	it("splits a clip around removed ranges", () => {
		const clips: ClipRegion[] = [{ id: "clip-1", startMs: 0, endMs: 10_000, speed: 1 }];
		const result = removeSourceRangesFromClips(
			clips,
			[
				{ startMs: 2000, endMs: 3000 },
				{ startMs: 9000, endMs: 12_000 },
			],
			createId,
		);
		expect(result).toEqual([
			{ id: "clip-1", startMs: 0, endMs: 2000, speed: 1, sourceStartMs: 0 },
			{ id: "clip-10", startMs: 3000, endMs: 9000, speed: 1, sourceStartMs: 3000 },
		]);
		expect(getClipSourceRanges(result)).toEqual([
			{ startMs: 0, endMs: 2000 },
			{ startMs: 3000, endMs: 9000 },
		]);
	});

	it("maps source ranges through clip speed", () => {
		// A 2x clip covering source 0-8000 occupies timeline 0-4000.
		const clips: ClipRegion[] = [{ id: "a", startMs: 0, endMs: 4000, speed: 2, muted: true }];
		const result = removeSourceRangesFromClips(
			clips,
			[{ startMs: 4000, endMs: 6000 }],
			createId,
		);
		expect(getClipSourceRanges(result)).toEqual([
			{ startMs: 0, endMs: 4000 },
			{ startMs: 6000, endMs: 8000 },
		]);
		expect(result.every((clip) => clip.speed === 2 && clip.muted)).toBe(true);
	});

	it("returns the same clips when nothing overlaps", () => {
		const clips: ClipRegion[] = [{ id: "a", startMs: 0, endMs: 1000, speed: 1 }];
		expect(removeSourceRangesFromClips(clips, [{ startMs: 2000, endMs: 3000 }], createId)).toBe(
			clips,
		);
	});

	it("drops slivers left between close cuts", () => {
		const clips: ClipRegion[] = [{ id: "a", startMs: 0, endMs: 1000, speed: 1 }];
		const result = removeSourceRangesFromClips(
			clips,
			[
				{ startMs: 100, endMs: 500 },
				{ startMs: 520, endMs: 900 },
			],
			createId,
		);
		expect(getClipSourceRanges(result)).toEqual([
			{ startMs: 0, endMs: 100 },
			{ startMs: 900, endMs: 1000 },
		]);
	});
});

describe("range helpers", () => {
	it("merges and totals ranges", () => {
		const ranges = [
			{ startMs: 500, endMs: 900 },
			{ startMs: 0, endMs: 600 },
			{ startMs: 1000, endMs: 1000 },
		];
		expect(mergeRanges(ranges)).toEqual([{ startMs: 0, endMs: 900 }]);
		expect(totalRangeMs(ranges)).toBe(900);
	});
});

describe("retake false-positive guards", () => {
	it("does not treat a numbered list as retakes", () => {
		const words = speak(
			Array.from({ length: 8 }, (_, index) => [
				`Step ${index + 1}: adjust setting number ${index + 1} in the preview.`,
				700,
			]).flat(),
		);
		expect(detectRetakeGroups(segmentUtterances(words))).toEqual([]);
	});

	it("accepts a looser rewording when the speaker flagged the retake", () => {
		const words = speak([
			"The zoom follows your cursor automatically",
			700,
			"no wait.",
			1200,
			"Auto zoom follows your cursor automatically, so clicks are always in view.",
		]);
		expect(detectRetakeGroups(segmentUtterances(words))).toHaveLength(1);
	});

	it("needs the cue for that looser match", () => {
		const words = speak([
			"The zoom follows your cursor automatically",
			1200,
			"Auto zoom follows your cursor automatically, so clicks are always in view.",
		]);
		expect(detectRetakeGroups(segmentUtterances(words))).toEqual([]);
	});
});

describe("snapRangeToSilence", () => {
	const silences = [
		{ startMs: 1000, endMs: 1800 },
		{ startMs: 5000, endMs: 5400 },
	];

	it("moves drifted edges into the neighbouring silences", () => {
		// Word times say the removed speech runs 1900-5200; the audio says the
		// pauses are 1000-1800 and 5000-5400.
		expect(snapRangeToSilence({ startMs: 1900, endMs: 5200 }, silences, 150)).toEqual({
			startMs: 1150,
			endMs: 5250,
		});
	});

	it("leaves edges with no silence nearby alone", () => {
		expect(snapRangeToSilence({ startMs: 3000, endMs: 3500 }, silences, 150)).toEqual({
			startMs: 3000,
			endMs: 3500,
		});
	});
});

describe("removeSourceRangesFromClips with moved clips", () => {
	it("cuts by source position, not timeline position", () => {
		// A clip showing source 10-20s placed at the start of the timeline.
		const clips: ClipRegion[] = [
			{ id: "a", startMs: 0, endMs: 10_000, speed: 1, sourceStartMs: 10_000 },
		];
		const result = removeSourceRangesFromClips(
			clips,
			[{ startMs: 12_000, endMs: 13_000 }],
			() => "b",
		);
		expect(result).toEqual([
			{ id: "a", startMs: 0, endMs: 2000, speed: 1, sourceStartMs: 10_000 },
			{ id: "b", startMs: 3000, endMs: 10_000, speed: 1, sourceStartMs: 13_000 },
		]);
	});
});
