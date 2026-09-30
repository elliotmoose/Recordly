import { describe, expect, it } from "vitest";
import { getWhisperDtwPreset, parseWhisperJsonCues, parseWhisperJsonWords } from "./parser";

const token = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });

describe("parseWhisperJsonWords", () => {
	it("keeps word timings when whisper emits control and zero-length tokens", () => {
		// Shape taken from real whisper-cli -ojf output.
		const words = parseWhisperJsonWords([
			token("[_BEG_]", 0, 0),
			token(" Hi", 0, 210),
			token(",", 210, 420),
			token(" welcome", 1150, 1150),
			token(" to", 1270, 1360),
			token("[_TT_150]", 3000, 3000),
		]);
		expect(words).toEqual([
			{ text: "Hi,", startMs: 0, endMs: 420 },
			{ text: "welcome", startMs: 1150, endMs: 1151, leadingSpace: true },
			{ text: "to", startMs: 1270, endMs: 1360, leadingSpace: true },
		]);
	});

	it("still gives up on a segment whose tokens have no offsets", () => {
		expect(parseWhisperJsonWords([{ text: " Hi" }])).toEqual([]);
	});
});

describe("parseWhisperJsonCues", () => {
	it("returns word-timed cues", () => {
		const cues = parseWhisperJsonCues(
			JSON.stringify({
				transcription: [
					{
						offsets: { from: 0, to: 1500 },
						text: " Hi, welcome.",
						tokens: [
							token("[_BEG_]", 0, 0),
							token(" Hi", 0, 210),
							token(",", 210, 420),
							token(" welcome", 1150, 1150),
							token(".", 1150, 1400),
						],
					},
				],
			}),
		);
		expect(cues).toHaveLength(1);
		expect(cues[0].text).toBe("Hi, welcome.");
		expect(cues[0].words?.map((word) => word.text)).toEqual(["Hi,", "welcome."]);
	});
});

describe("DTW word timings", () => {
	const dtwToken = (text: string, from: number, to: number, dtw: number) => ({
		text,
		offsets: { from, to },
		t_dtw: dtw,
	});

	it("prefers DTW times, shifted earlier, and keeps real pauses as gaps", () => {
		const words = parseWhisperJsonWords([
			dtwToken("[_BEG_]", 0, 0, -1),
			dtwToken(" Hi", 0, 210, 146),
			dtwToken(",", 210, 420, 174),
			dtwToken(" welcome", 1150, 1150, 206),
			dtwToken(" back", 1270, 1500, 400),
		]);
		expect(words.map((word) => [word.text, word.startMs, word.endMs])).toEqual([
			["Hi,", 1310, 1730],
			["welcome", 1910, 1990],
			// A long jump in DTW time is a pause: "welcome" ends before "back" starts.
			["back", 3850, 4080],
		]);
	});

	it("falls back to offsets when any word lacks a DTW time", () => {
		const words = parseWhisperJsonWords([
			dtwToken(" Hi", 0, 210, 146),
			dtwToken(" there", 300, 500, -1),
		]);
		expect(words.map((word) => word.startMs)).toEqual([0, 300]);
	});

	it("uses word times for cue bounds", () => {
		const [cue] = parseWhisperJsonCues(
			JSON.stringify({
				transcription: [
					{
						offsets: { from: 0, to: 5000 },
						text: " Hi back",
						tokens: [dtwToken(" Hi", 0, 210, 146), dtwToken(" back", 300, 500, 400)],
					},
				],
			}),
		);
		expect([cue.startMs, cue.endMs]).toEqual([1310, 4050]);
	});
});

describe("getWhisperDtwPreset", () => {
	it.each([
		["/models/ggml-small.bin", "small"],
		["C:\\models\\ggml-base.en.bin", "base.en"],
		["ggml-large-v3-turbo-q5_0.bin", "large.v3.turbo"],
		["ggml-medium.en-q8_0.bin", "medium.en"],
		["my-finetune.bin", null],
		["ggml-small-custom.bin", null],
	])("%s -> %s", (path, expected) => {
		expect(getWhisperDtwPreset(path)).toBe(expected);
	});
});
