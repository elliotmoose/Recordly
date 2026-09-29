import type { RetakeGroup, RetakeTake, Utterance } from "./types";

export const RETAKE_SYSTEM_PROMPT = `You find retakes in the transcript of a screen-recording voiceover.

A retake is when the speaker says (roughly) the same line again because an earlier attempt was flawed: they stumbled, abandoned it mid-sentence, or said something like "sorry, let me redo that". Paraphrased attempts count. Deliberate repetition does NOT count (listing similar steps, emphasis, or recapping something said much earlier).

Input lines are: id | start seconds | text

Reply with JSON only:
{"groups":[{"takes":[[ids of attempt 1],[ids of attempt 2]],"junk":[ids],"reason":"short explanation"}]}

Rules:
- Every take is a list of consecutive utterance ids, in order. Takes are in chronological order and do not overlap. A group has at least two takes.
- "junk" lists utterances between attempts that belong to no attempt (apologies, "let me redo that", a lone false-start word).
- Attempts may be incomplete; include them anyway.
- Do not choose which take to keep.
- If there are no retakes, reply {"groups":[]}.`;

/** Utterances per LLM request; consecutive chunks overlap so no retake is split. */
export const RETAKE_CHUNK_SIZE = 160;
export const RETAKE_CHUNK_OVERLAP = 20;

export function chunkUtterances(
	utterances: Utterance[],
	size = RETAKE_CHUNK_SIZE,
	overlap = RETAKE_CHUNK_OVERLAP,
): Utterance[][] {
	if (utterances.length <= size) {
		return utterances.length > 0 ? [utterances] : [];
	}
	const chunks: Utterance[][] = [];
	for (let start = 0; start < utterances.length; start += size - overlap) {
		chunks.push(utterances.slice(start, start + size));
		if (start + size >= utterances.length) {
			break;
		}
	}
	return chunks;
}

export function buildRetakeUserPrompt(utterances: Utterance[], hints: RetakeGroup[]): string {
	const lines = utterances.map(
		(utterance) =>
			`${utterance.id} | ${(utterance.startMs / 1000).toFixed(1)} | ${utterance.text.replace(/\s+/g, " ")}`,
	);
	const ids = new Set(utterances.map((utterance) => utterance.id));
	const hintLines = hints
		.filter((group) =>
			group.takes.every((take) => take.utteranceIds.every((id) => ids.has(id))),
		)
		.map(
			(group) =>
				`- takes ${group.takes.map((take) => `[${take.utteranceIds.join(",")}]`).join(" ")}`,
		);

	return [
		hintLines.length > 0
			? `A simple text matcher suggested these groups (they may be wrong or incomplete):\n${hintLines.join("\n")}\n`
			: "",
		"Transcript:",
		...lines,
	]
		.filter(Boolean)
		.join("\n");
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) {
			return JSON.parse(trimmed.slice(start, end + 1));
		}
		throw new Error("The AI response was not JSON.");
	}
}

function toIdList(value: unknown): number[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	const ids = value.map((id) => (typeof id === "string" ? Number(id) : id));
	return ids.every((id) => Number.isInteger(id)) ? (ids as number[]) : null;
}

/**
 * Turn a model reply into validated groups. Anything that doesn't reference
 * real, correctly ordered utterances is dropped rather than trusted.
 */
export function parseRetakeResponse(text: string, utterances: Utterance[]): RetakeGroup[] {
	const parsed = extractJsonObject(text) as { groups?: unknown };
	const rawGroups = Array.isArray(parsed?.groups) ? parsed.groups : [];
	const byId = new Map(utterances.map((utterance) => [utterance.id, utterance]));
	const groups: RetakeGroup[] = [];

	for (const rawGroup of rawGroups) {
		if (!rawGroup || typeof rawGroup !== "object") {
			continue;
		}
		const candidate = rawGroup as { takes?: unknown; junk?: unknown; reason?: unknown };
		const takeLists = Array.isArray(candidate.takes)
			? candidate.takes.map(toIdList).filter((ids): ids is number[] => Boolean(ids?.length))
			: [];
		if (takeLists.length < 2) {
			continue;
		}

		const takes: RetakeTake[] = [];
		let valid = true;
		let previousEnd = -1;
		for (const ids of takeLists) {
			const sorted = [...new Set(ids)].sort((left, right) => left - right);
			const members = sorted.map((id) => byId.get(id));
			const consecutive = sorted.every(
				(id, index) => index === 0 || id === sorted[index - 1] + 1,
			);
			if (members.some((member) => !member) || !consecutive || sorted[0] <= previousEnd) {
				valid = false;
				break;
			}
			previousEnd = sorted[sorted.length - 1];
			const resolved = members as Utterance[];
			takes.push({
				startMs: resolved[0].startMs,
				endMs: resolved[resolved.length - 1].endMs,
				utteranceIds: sorted,
				text: resolved.map((utterance) => utterance.text).join(" "),
			});
		}
		if (!valid) {
			continue;
		}

		const takeIds = new Set(takes.flatMap((take) => take.utteranceIds));
		const firstId = takes[0].utteranceIds[0];
		const lastId = previousEnd;
		const junk = (toIdList(candidate.junk) ?? []).filter(
			(id) => byId.has(id) && !takeIds.has(id) && id > firstId && id < lastId,
		);

		groups.push({
			id: `retake-llm-${firstId}`,
			startMs: takes[0].startMs,
			endMs: takes[takes.length - 1].endMs,
			takes,
			junkUtteranceIds: [...new Set(junk)].sort((left, right) => left - right),
			source: "llm",
			reason:
				typeof candidate.reason === "string" && candidate.reason.trim()
					? candidate.reason.trim().slice(0, 160)
					: "Flagged by AI assist",
		});
	}

	return groups;
}

/** Keep groups in time order, dropping any that overlap an earlier kept group. */
export function dedupeRetakeGroups(groups: RetakeGroup[]): RetakeGroup[] {
	const sorted = [...groups].sort((left, right) => left.startMs - right.startMs);
	const kept: RetakeGroup[] = [];
	for (const group of sorted) {
		const last = kept[kept.length - 1];
		if (last && group.startMs < last.endMs) {
			continue;
		}
		kept.push(group);
	}
	return kept;
}
