import { describe, expect, it } from "vitest";
import {
	buildRetakeUserPrompt,
	chunkUtterances,
	dedupeRetakeGroups,
	parseRetakeResponse,
} from "./llmRetakes";
import { segmentUtterances } from "./transcript";
import type { RetakeGroup, TranscriptWord } from "./types";

function wordsFor(sentences: string[]): TranscriptWord[] {
	const words: TranscriptWord[] = [];
	let cursor = 0;
	for (const sentence of sentences) {
		for (const text of sentence.split(" ")) {
			words.push({ text, startMs: cursor, endMs: cursor + 300 });
			cursor += 360;
		}
		cursor += 1000;
	}
	return words;
}

const utterances = segmentUtterances(
	wordsFor([
		"Welcome back.",
		"Now we open the",
		"sorry.",
		"Okay now open the settings panel.",
		"Pick a font.",
	]),
);

describe("parseRetakeResponse", () => {
	it("builds groups from a valid reply, including fenced JSON", () => {
		const reply =
			'```json\n{"groups":[{"takes":[[1],[3]],"junk":[2],"reason":"Restarted the sentence"}]}\n```';
		const [group] = parseRetakeResponse(reply, utterances);
		expect(group.source).toBe("llm");
		expect(group.takes.map((take) => take.text)).toEqual([
			"Now we open the",
			"Okay now open the settings panel.",
		]);
		expect(group.junkUtteranceIds).toEqual([2]);
		expect(group.reason).toBe("Restarted the sentence");
		expect(group.startMs).toBe(utterances[1].startMs);
		expect(group.endMs).toBe(utterances[3].endMs);
	});

	it("accepts string ids and prose around the JSON", () => {
		const reply = 'Here you go: {"groups":[{"takes":[["1"],["3"]]}]} hope that helps';
		expect(parseRetakeResponse(reply, utterances)).toHaveLength(1);
	});

	it.each([
		['{"groups":[{"takes":[[1]]}]}', "a single take"],
		['{"groups":[{"takes":[[3],[1]]}]}', "out-of-order takes"],
		['{"groups":[{"takes":[[1],[99]]}]}', "unknown ids"],
		['{"groups":[{"takes":[[1,3],[4]]}]}', "non-consecutive take"],
		['{"groups":[{"takes":[[1,2],[2,3]]}]}', "overlapping takes"],
		['{"groups":"nope"}', "a malformed groups field"],
	])("drops %s (%s)", (reply) => {
		expect(parseRetakeResponse(reply, utterances)).toEqual([]);
	});

	it("drops junk ids outside the group or inside a take", () => {
		const reply = '{"groups":[{"takes":[[1],[3]],"junk":[0,2,3,4]}]}';
		expect(parseRetakeResponse(reply, utterances)[0].junkUtteranceIds).toEqual([2]);
	});

	it("throws on a reply with no JSON at all", () => {
		expect(() => parseRetakeResponse("I could not find any.", utterances)).toThrow();
	});
});

describe("prompt building", () => {
	it("lists utterances with ids and times and includes in-chunk hints", () => {
		const hint = {
			takes: [{ utteranceIds: [1] }, { utteranceIds: [3] }],
		} as unknown as RetakeGroup;
		const prompt = buildRetakeUserPrompt(utterances, [hint]);
		expect(prompt).toContain("- takes [1] [3]");
		expect(prompt).toContain("3 | ");
		expect(prompt).toContain("Okay now open the settings panel.");
	});

	it("chunks long transcripts with overlap", () => {
		const many = Array.from({ length: 350 }, (_, id) => ({ ...utterances[0], id }));
		const chunks = chunkUtterances(many, 160, 20);
		expect(chunks.map((chunk) => [chunk[0].id, chunk[chunk.length - 1].id])).toEqual([
			[0, 159],
			[140, 299],
			[280, 349],
		]);
		expect(chunkUtterances([], 160, 20)).toEqual([]);
	});

	it("dedupes overlapping groups from overlapping chunks", () => {
		const a = { id: "a", startMs: 0, endMs: 1000 } as RetakeGroup;
		const b = { id: "b", startMs: 500, endMs: 1500 } as RetakeGroup;
		const c = { id: "c", startMs: 2000, endMs: 2500 } as RetakeGroup;
		expect(dedupeRetakeGroups([c, b, a]).map((group) => group.id)).toEqual(["a", "c"]);
	});
});
