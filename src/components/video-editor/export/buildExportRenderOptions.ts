import type { ExportProgress } from "@/lib/exporter";
import { toFileUrl } from "../projectPersistence";
import type { useAppearanceState } from "../state/useAppearanceState";
import type { useTimelineState } from "../state/useTimelineState";
import {
	type CursorTelemetryPoint,
	getPlaybackSegments,
	isSourceOrderMonotonic,
	mapTimelineRegionsToSource,
	type SpeedRegion,
	type ZoomRegion,
} from "../types";

type AppearanceState = ReturnType<typeof useAppearanceState>;
type TimelineState = ReturnType<typeof useTimelineState>;

type BuildExportRenderOptionsInput = {
	appearance: AppearanceState;
	timeline: TimelineState;
	effectiveSpeedRegions: SpeedRegion[];
	effectiveZoomRegions: ZoomRegion[];
	effectiveCursorTelemetry: CursorTelemetryPoint[];
	effectiveShowCursor: boolean;
	previewWidth: number;
	previewHeight: number;
	shadowIntensity: number;
	onProgress: (progress: ExportProgress) => void;
};

/**
 * Source ranges in timeline order, but only when clips are reordered. In-order
 * edits keep using the trims so their exports are unchanged.
 */
export function getReorderedSourceOrder(clips: TimelineState["clipRegions"]) {
	const segments = getPlaybackSegments(clips);
	return isSourceOrderMonotonic(segments)
		? undefined
		: segments.map((segment) => ({
				startMs: segment.sourceStartMs,
				endMs: segment.sourceEndMs,
			}));
}

/**
 * Audio regions (music, voiceover) for the exporters, which place them on the
 * source clock. In source order, mapping each edge timeline→source puts them
 * at the right output time (identically for projects whose clips never
 * moved). Reordered clips instead hand the audio renderer the clip order and
 * keep the regions in timeline time.
 */
export function buildExportAudioTimeline(
	clips: TimelineState["clipRegions"],
	audioRegions: TimelineState["audioRegions"],
) {
	const segments = getPlaybackSegments(clips);
	if (segments.length === 0) {
		return { audioRegions };
	}
	if (isSourceOrderMonotonic(segments)) {
		return { audioRegions: mapTimelineRegionsToSource(audioRegions, clips) };
	}
	return {
		audioRegions,
		audioTimelineOrder: {
			sourceOrder: segments.map((segment) => ({
				startMs: segment.sourceStartMs,
				endMs: segment.sourceEndMs,
			})),
			timelineSegments: segments.map((segment) => ({
				timelineStartMs: segment.timelineStartMs,
				timelineEndMs: segment.timelineEndMs,
				sourceStartMs: segment.sourceStartMs,
			})),
		},
	};
}

export function buildExportRenderOptions({
	appearance,
	timeline,
	effectiveSpeedRegions,
	effectiveZoomRegions,
	effectiveCursorTelemetry,
	effectiveShowCursor,
	previewWidth,
	previewHeight,
	shadowIntensity,
	onProgress,
}: BuildExportRenderOptionsInput) {
	return {
		wallpaper: appearance.wallpaper,
		trimRegions: timeline.trimRegions,
		sourceOrder: getReorderedSourceOrder(timeline.clipRegions),
		speedRegions: effectiveSpeedRegions,
		showShadow: shadowIntensity > 0,
		shadowIntensity,
		backgroundBlur: appearance.backgroundBlur,
		zoomMotionBlur: appearance.zoomMotionBlur,
		zoomMotionBlurTuning: appearance.zoomMotionBlurTuning,
		zoomTemporalMotionBlur: appearance.zoomTemporalMotionBlur,
		zoomMotionBlurSampleCount: appearance.zoomMotionBlurSampleCount,
		zoomMotionBlurShutterFraction: appearance.zoomMotionBlurShutterFraction,
		connectZooms: appearance.connectZooms,
		zoomInDurationMs: appearance.zoomInDurationMs,
		zoomInOverlapMs: appearance.zoomInOverlapMs,
		zoomOutDurationMs: appearance.zoomOutDurationMs,
		connectedZoomGapMs: appearance.connectedZoomGapMs,
		connectedZoomDurationMs: appearance.connectedZoomDurationMs,
		zoomInEasing: appearance.zoomInEasing,
		zoomOutEasing: appearance.zoomOutEasing,
		connectedZoomEasing: appearance.connectedZoomEasing,
		borderRadius: appearance.borderRadius,
		padding: appearance.padding,
		cropRegion: appearance.cropRegion,
		webcam: appearance.webcam,
		webcamUrl:
			appearance.resolvedWebcamVideoUrl ??
			(appearance.webcam.sourcePath ? toFileUrl(appearance.webcam.sourcePath) : null),
		// Renderers run on the source clock; annotations are placed in timeline time.
		annotationRegions: mapTimelineRegionsToSource(
			timeline.annotationRegions,
			timeline.clipRegions,
		),
		autoCaptions: timeline.autoCaptions,
		autoCaptionSettings: timeline.autoCaptionSettings,
		zoomRegions: effectiveZoomRegions,
		cursorTelemetry: effectiveCursorTelemetry,
		showCursor: effectiveShowCursor,
		cursorStyle: appearance.cursorStyle,
		cursorSize: appearance.cursorSize,
		cursorSmoothing: appearance.cursorSmoothing,
		cursorSpringStiffnessMultiplier: appearance.cursorSpringStiffnessMultiplier,
		cursorSpringDampingMultiplier: appearance.cursorSpringDampingMultiplier,
		cursorSpringMassMultiplier: appearance.cursorSpringMassMultiplier,
		cameraSpringStiffnessMultiplier: appearance.cameraSpringStiffnessMultiplier,
		cameraSpringDampingMultiplier: appearance.cameraSpringDampingMultiplier,
		cameraSpringMassMultiplier: appearance.cameraSpringMassMultiplier,
		zoomSmoothness: appearance.zoomSmoothness,
		zoomClassicMode: appearance.zoomClassicMode,
		cursorMotionBlur: appearance.cursorMotionBlur,
		cursorClickEffect: appearance.cursorClickEffect,
		cursorClickEffectColor: appearance.cursorClickEffectColor,
		cursorClickEffectScale: appearance.cursorClickEffectScale,
		cursorClickEffectOpacity: appearance.cursorClickEffectOpacity,
		cursorClickEffectDurationMs: appearance.cursorClickEffectDurationMs,
		cursorClickBounce: appearance.cursorClickBounce,
		cursorClickBounceDuration: appearance.cursorClickBounceDuration,
		cursorSway: appearance.cursorSway,
		previewWidth,
		previewHeight,
		onProgress,
	};
}
