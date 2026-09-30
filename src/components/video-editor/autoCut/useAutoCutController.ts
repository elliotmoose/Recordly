import {
	type MutableRefObject,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { toast } from "sonner";
import type { useTimelineState } from "../state/useTimelineState";
import type { VideoPlaybackRef } from "../VideoPlayback";
import {
	getClipSourceRanges,
	removeSourceRangesFromClips,
	retakeRemovalRanges,
	totalRangeMs,
} from "./applyCuts";
import {
	buildRetakeUserPrompt,
	chunkUtterances,
	dedupeRetakeGroups,
	parseRetakeResponse,
	RETAKE_SYSTEM_PROMPT,
} from "./llmRetakes";
import { packClips, remapTimelineRegions } from "../timelineRipple";
import { detectRetakeGroups } from "./retakeDetection";
import { detectSilenceCuts, intersectRanges } from "./silenceCuts";
import { segmentUtterances, transcriptWordsFromCaptions } from "./transcript";
import type { RetakeDecision, RetakeGroup, SourceRange } from "./types";

type Translator = (
	key: string,
	fallback?: string,
	vars?: Record<string, string | number>,
) => string;

export type AutoCutScope = "all" | "selected";

export interface SilenceSettings {
	minGapMs: number;
	keepMs: number;
}

export const DEFAULT_SILENCE_SETTINGS: SilenceSettings = { minGapMs: 700, keepMs: 150 };

type AcousticState =
	| { status: "idle" | "running" }
	| { status: "ready"; sourcePath: string; intervals: SourceRange[] }
	| { status: "error"; sourcePath: string; error: string };

type RetakeState =
	| { status: "idle" }
	| { status: "running"; progress: string }
	| {
			status: "done";
			groups: RetakeGroup[];
			aiUsed: boolean;
			aiError: string | null;
			tokens: number | null;
	  };

interface UseAutoCutControllerParams {
	t: Translator;
	timeline: ReturnType<typeof useTimelineState>;
	sourcePath: string | null;
	currentTime: number;
	videoPlaybackRef: RefObject<VideoPlaybackRef>;
	startPlayback: () => void;
	nextClipIdRef: MutableRefObject<number>;
}

export function useAutoCutController({
	t,
	timeline,
	sourcePath,
	currentTime,
	videoPlaybackRef,
	startPlayback,
	nextClipIdRef,
}: UseAutoCutControllerParams) {
	const { autoCaptions, clipRegions, setClipRegions, selectedClipId } = timeline;
	const [scope, setScope] = useState<AutoCutScope>("all");
	const [silenceSettings, setSilenceSettings] = useState(DEFAULT_SILENCE_SETTINGS);
	const [includeSilence, setIncludeSilence] = useState(true);
	const [acoustic, setAcoustic] = useState<AcousticState>({ status: "idle" });
	const [retakes, setRetakes] = useState<RetakeState>({ status: "idle" });
	const [decisions, setDecisions] = useState<Record<string, RetakeDecision>>({});
	const [useAi, setUseAi] = useState(true);
	const [llmSettings, setLlmSettings] = useState<AutoCutLlmSettings | null>(null);
	const [previewRange, setPreviewRange] = useState<(SourceRange & { key: string }) | null>(null);

	const words = useMemo(() => transcriptWordsFromCaptions(autoCaptions), [autoCaptions]);
	const utterances = useMemo(() => segmentUtterances(words), [words]);
	const hasTranscript = words.length > 0;

	const scopeRanges = useMemo(() => {
		const clips =
			scope === "selected" && selectedClipId
				? clipRegions.filter((clip) => clip.id === selectedClipId)
				: clipRegions;
		return getClipSourceRanges(clips);
	}, [clipRegions, scope, selectedClipId]);

	useEffect(() => {
		void window.electronAPI
			?.autoCutGetLlmSettings?.()
			.then(setLlmSettings)
			.catch(() => undefined);
	}, []);

	const aiConfigured = Boolean(llmSettings?.baseUrl && llmSettings.model);

	const acousticIntervals =
		acoustic.status === "ready" && acoustic.sourcePath === sourcePath
			? acoustic.intervals
			: null;

	const silenceCuts = useMemo(
		() =>
			hasTranscript
				? detectSilenceCuts(words, {
						...silenceSettings,
						ranges: scopeRanges,
						acousticSilences: acousticIntervals,
					})
				: [],
		[acousticIntervals, hasTranscript, scopeRanges, silenceSettings, words],
	);

	const analyzeAudio = useCallback(async () => {
		if (!sourcePath || !window.electronAPI?.autoCutDetectSilence) {
			return;
		}
		setAcoustic({ status: "running" });
		const result = await window.electronAPI.autoCutDetectSilence(sourcePath);
		setAcoustic(
			result.success
				? { status: "ready", sourcePath, intervals: result.intervals }
				: { status: "error", sourcePath, error: result.error },
		);
	}, [sourcePath]);

	// Refine silence cuts with real audio levels as soon as there's a transcript.
	useEffect(() => {
		if (hasTranscript && sourcePath && acoustic.status === "idle") {
			void analyzeAudio();
		}
	}, [acoustic.status, analyzeAudio, hasTranscript, sourcePath]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset the analysis whenever the source recording changes.
	useEffect(() => {
		setAcoustic({ status: "idle" });
		setRetakes({ status: "idle" });
		setDecisions({});
	}, [sourcePath]);

	const detectRetakes = useCallback(async () => {
		const inScope = utterances.filter((utterance) =>
			scopeRanges.some(
				(range) => utterance.startMs >= range.startMs && utterance.endMs <= range.endMs,
			),
		);
		const heuristicGroups = detectRetakeGroups(inScope, { ranges: scopeRanges });
		setDecisions({});

		if (!useAi || !aiConfigured || !window.electronAPI?.autoCutLlmComplete) {
			setRetakes({
				status: "done",
				groups: heuristicGroups,
				aiUsed: false,
				aiError: null,
				tokens: null,
			});
			return;
		}

		const chunks = chunkUtterances(inScope);
		const aiGroups: RetakeGroup[] = [];
		let tokens = 0;
		try {
			for (let index = 0; index < chunks.length; index += 1) {
				setRetakes({
					status: "running",
					progress: t(
						"settings.autoCut.aiProgress",
						"Asking AI assist ({{current}}/{{total}})",
						{
							current: index + 1,
							total: chunks.length,
						},
					),
				});
				const result = await window.electronAPI.autoCutLlmComplete({
					system: RETAKE_SYSTEM_PROMPT,
					user: buildRetakeUserPrompt(chunks[index], heuristicGroups),
					json: true,
				});
				if (!result.success) {
					throw new Error(result.error);
				}
				tokens += (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0);
				aiGroups.push(...parseRetakeResponse(result.text, chunks[index]));
			}
			setRetakes({
				status: "done",
				groups: dedupeRetakeGroups(aiGroups),
				aiUsed: true,
				aiError: null,
				tokens,
			});
		} catch (error) {
			setRetakes({
				status: "done",
				groups: heuristicGroups,
				aiUsed: false,
				aiError: error instanceof Error ? error.message : String(error),
				tokens: null,
			});
		}
	}, [aiConfigured, scopeRanges, t, useAi, utterances]);

	const retakeGroups = retakes.status === "done" ? retakes.groups : [];

	const removalRanges = useMemo(() => {
		const ranges: SourceRange[] = includeSilence ? [...silenceCuts] : [];
		for (const group of retakeGroups) {
			ranges.push(
				...retakeRemovalRanges(
					group,
					decisions[group.id],
					utterances,
					words,
					silenceSettings.keepMs,
					acousticIntervals,
				),
			);
		}
		return intersectRanges(ranges, getClipSourceRanges(clipRegions));
	}, [
		clipRegions,
		decisions,
		includeSilence,
		retakeGroups,
		silenceCuts,
		silenceSettings.keepMs,
		utterances,
		words,
		acousticIntervals,
	]);

	const savedMs = useMemo(() => totalRangeMs(removalRanges), [removalRanges]);
	const silenceSavedMs = useMemo(
		() => totalRangeMs(intersectRanges(silenceCuts, getClipSourceRanges(clipRegions))),
		[clipRegions, silenceCuts],
	);
	const unresolvedCount = retakeGroups.filter(
		(group) => decisions[group.id] === undefined,
	).length;

	const setDecision = useCallback((groupId: string, decision: RetakeDecision) => {
		setDecisions((current) => ({ ...current, [groupId]: decision }));
	}, []);

	const apply = useCallback(() => {
		if (removalRanges.length === 0) {
			return;
		}
		// Pieces stay where their content sat; with ripple the gaps then close and
		// zooms, annotations and audio move with the piece they sit on.
		const pieces = removeSourceRangesFromClips(
			clipRegions,
			removalRanges,
			() => `clip-${nextClipIdRef.current++}`,
		);
		const next = timeline.rippleEditing ? packClips(pieces) : pieces;
		setClipRegions(next);
		if (next !== pieces) {
			timeline.setZoomRegions((current) => remapTimelineRegions(current, pieces, next));
			timeline.setAnnotationRegions((current) => remapTimelineRegions(current, pieces, next));
			timeline.setAudioRegions((current) => remapTimelineRegions(current, pieces, next));
		}
		const appliedGroupIds = new Set(
			retakeGroups
				.filter((group) => decisions[group.id] !== undefined)
				.map((group) => group.id),
		);
		setRetakes((current) => {
			if (current.status !== "done") {
				return current;
			}
			const remaining = current.groups.filter((group) => !appliedGroupIds.has(group.id));
			// Once every group is handled, go back to the initial "Find retakes" state
			// rather than claiming none were found.
			return remaining.length > 0 || current.groups.length === 0
				? { ...current, groups: remaining }
				: { status: "idle" };
		});
		toast.success(
			t("settings.autoCut.applied", "Removed {{seconds}}s. Undo restores it.", {
				seconds: (savedMs / 1000).toFixed(1),
			}),
		);
	}, [
		decisions,
		nextClipIdRef,
		removalRanges,
		retakeGroups,
		savedMs,
		setClipRegions,
		t,
		clipRegions,
		timeline.rippleEditing,
		timeline.setAnnotationRegions,
		timeline.setAudioRegions,
		timeline.setZoomRegions,
	]);

	const previewTake = useCallback(
		(key: string, range: SourceRange) => {
			const video = videoPlaybackRef.current?.video;
			if (!video) {
				return;
			}
			setPreviewRange({ key, ...range });
			video.currentTime = range.startMs / 1000;
			startPlayback();
		},
		[startPlayback, videoPlaybackRef],
	);

	// Stop a take preview at the end of the take.
	useEffect(() => {
		if (previewRange && currentTime * 1000 >= previewRange.endMs) {
			videoPlaybackRef.current?.pause();
			setPreviewRange(null);
		}
	}, [currentTime, previewRange, videoPlaybackRef]);

	const saveLlmSettings = useCallback(
		async (update: {
			baseUrl: string;
			model: string;
			reasoningEffort?: string;
			apiKey?: string | null;
		}) => {
			if (!window.electronAPI?.autoCutSetLlmSettings) {
				return;
			}
			setLlmSettings(await window.electronAPI.autoCutSetLlmSettings(update));
		},
		[],
	);

	const testLlm = useCallback(async () => {
		const result = await window.electronAPI?.autoCutLlmComplete?.({
			system: 'Reply with JSON: {"ok": true}',
			user: "ping",
			json: true,
			maxTokens: 20,
		});
		if (result?.success) {
			toast.success(
				t("settings.autoCut.aiTestOk", "Connected to {{model}} ({{ms}} ms)", {
					model: result.model,
					ms: result.elapsedMs,
				}),
			);
		} else {
			toast.error(result?.error ?? t("settings.autoCut.aiTestFailed", "Connection failed"));
		}
	}, [t]);

	return {
		hasTranscript,
		scope,
		setScope,
		hasSelectedClip: Boolean(selectedClipId),
		silenceSettings,
		setSilenceSettings,
		includeSilence,
		setIncludeSilence,
		silenceCuts,
		silenceSavedMs,
		acoustic,
		analyzeAudio,
		retakes,
		retakeGroups,
		detectRetakes,
		decisions,
		setDecision,
		unresolvedCount,
		removalRanges,
		savedMs,
		apply,
		previewTake,
		previewKey: previewRange?.key ?? null,
		useAi,
		setUseAi,
		aiConfigured,
		llmSettings,
		saveLlmSettings,
		testLlm,
	};
}

export type AutoCutController = ReturnType<typeof useAutoCutController>;
