import type React from "react";
import { enablePitchPreservingPlayback } from "@/lib/mediaTiming";
import type { PlaybackSegment, SpeedRegion } from "../types";
import { resolvePlaybackStep } from "./playbackSegments";

/** How close to a clip's end (ms of source) the exact boundary check is armed. */
const BOUNDARY_CHECK_WINDOW_MS = 1000;
/** A presented time this close to a jump's target means the jump landed. */
const JUMP_ARRIVAL_TOLERANCE_MS = 500;

interface PresentedFrameMetadata {
	mediaTime?: number;
}

type PresentedFrameVideoElement = HTMLVideoElement & {
	requestVideoFrameCallback?: (
		callback: (now: DOMHighResTimeStamp, metadata: PresentedFrameMetadata) => void,
	) => number;
	cancelVideoFrameCallback?: (handle: number) => void;
};

interface VideoEventHandlersParams {
	video: HTMLVideoElement;
	isSeekingRef: React.MutableRefObject<boolean>;
	shouldSnapPausedFrameRef?: React.MutableRefObject<boolean>;
	isPlayingRef: React.MutableRefObject<boolean>;
	allowPlaybackRef: React.MutableRefObject<boolean>;
	currentTimeRef: React.MutableRefObject<number>;
	timeUpdateAnimationRef: React.MutableRefObject<number | null>;
	onPlayStateChange: (playing: boolean) => void;
	onTimeUpdate: (time: number) => void;
	/** Clips in timeline order; playback follows them. */
	playbackSegmentsRef: React.MutableRefObject<PlaybackSegment[]>;
	speedRegionsRef: React.MutableRefObject<SpeedRegion[]>;
}

/**
 * Bind media events to the preview's presented-frame clock, playing the clips
 * in timeline order (skipping removed footage) and honoring speed regions.
 */
export function createVideoEventHandlers(params: VideoEventHandlersParams) {
	const {
		video,
		isSeekingRef,
		shouldSnapPausedFrameRef,
		isPlayingRef,
		allowPlaybackRef,
		currentTimeRef,
		timeUpdateAnimationRef,
		onPlayStateChange,
		onTimeUpdate,
		playbackSegmentsRef,
		speedRegionsRef,
	} = params;
	const presentedFrameVideo = video as PresentedFrameVideoElement;
	let videoFrameRequestId: number | null = null;
	enablePitchPreservingPlayback(video);

	const emitTime = (timeValue: number) => {
		currentTimeRef.current = timeValue * 1000;
		onTimeUpdate(timeValue);
	};

	// Index of the clip being played, so reaching its end knows what comes next.
	let activeSegmentIndex = -1;
	// Source time (ms) of a jump still in flight. Frame callbacks queued before
	// the seek report the old position; acting on them would jump again.
	let pendingJumpTargetMs: number | null = null;
	// Helper function to find the active speed region at the current time
	const findActiveSpeedRegion = (currentTimeMs: number): SpeedRegion | null => {
		return (
			speedRegionsRef.current.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	};

	/**
	 * Follow the clip playlist at `timeSeconds`. Returns true when playback
	 * moved (jumped to another clip or stopped at the end).
	 */
	const followPlaylist = (timeSeconds: number): boolean => {
		if (pendingJumpTargetMs !== null) {
			const arrived =
				Math.abs(timeSeconds * 1000 - pendingJumpTargetMs) < JUMP_ARRIVAL_TOLERANCE_MS;
			if (!arrived) {
				// Stale: don't act on it or show it.
				return true;
			}
			pendingJumpTargetMs = null;
		}
		const step = resolvePlaybackStep(
			playbackSegmentsRef.current,
			timeSeconds * 1000,
			activeSegmentIndex,
		);
		if (step.action === "free") {
			return false;
		}
		if (step.action === "stay") {
			activeSegmentIndex = step.index;
			scheduleBoundaryCheck(timeSeconds * 1000);
			return false;
		}
		if (step.action === "end") {
			video.pause();
			emitTime(timeSeconds);
			return true;
		}
		activeSegmentIndex = step.index;
		const target = Math.min(step.toSourceMs / 1000, video.duration);
		pendingJumpTargetMs = target * 1000;
		video.currentTime = target;
		emitTime(target);
		if (target >= video.duration) {
			video.pause();
		}
		return true;
	};

	// Frame callbacks can be sparse (a busy machine drops frames), so near the
	// end of a clip that jumps elsewhere, also check at the exact boundary.
	let boundaryTimer: ReturnType<typeof setTimeout> | null = null;
	const clearBoundaryCheck = () => {
		if (boundaryTimer !== null) {
			clearTimeout(boundaryTimer);
			boundaryTimer = null;
		}
	};
	function scheduleBoundaryCheck(timeMs: number) {
		clearBoundaryCheck();
		const segments = playbackSegmentsRef.current;
		const current = segments[activeSegmentIndex];
		if (!current || video.paused || video.ended) {
			return;
		}
		const next = segments[activeSegmentIndex + 1];
		if (next && Math.abs(next.sourceStartMs - current.sourceEndMs) <= 1) {
			return;
		}
		// The media clock runs ahead of the last presented frame on a busy
		// machine; measure from whichever is further along.
		const remainingMs = current.sourceEndMs - Math.max(timeMs, video.currentTime * 1000);
		if (remainingMs > BOUNDARY_CHECK_WINDOW_MS) {
			return;
		}
		const rate = video.playbackRate > 0 ? video.playbackRate : 1;
		boundaryTimer = setTimeout(
			() => {
				boundaryTimer = null;
				if (!video.paused && !video.ended && !isSeekingRef.current) {
					followPlaylist(video.currentTime);
				}
			},
			Math.max(0, remainingMs / rate),
		);
	}

	const cancelScheduledUpdate = () => {
		clearBoundaryCheck();
		if (timeUpdateAnimationRef.current !== null) {
			cancelAnimationFrame(timeUpdateAnimationRef.current);
			timeUpdateAnimationRef.current = null;
		}

		if (
			videoFrameRequestId !== null &&
			typeof presentedFrameVideo.cancelVideoFrameCallback === "function"
		) {
			presentedFrameVideo.cancelVideoFrameCallback(videoFrameRequestId);
			videoFrameRequestId = null;
		}
	};

	const scheduleNextUpdate = () => {
		if (video.paused || video.ended) {
			return;
		}

		// Align editor state with the frame Chromium actually presented instead of
		// polling `currentTime` on a generic animation frame.
		if (typeof presentedFrameVideo.requestVideoFrameCallback === "function") {
			videoFrameRequestId = presentedFrameVideo.requestVideoFrameCallback(
				(_now, metadata) => {
					videoFrameRequestId = null;
					updateTime(metadata);
				},
			);
			return;
		}

		timeUpdateAnimationRef.current = requestAnimationFrame(() => {
			timeUpdateAnimationRef.current = null;
			updateTime();
		});
	};

	function getPresentedTime(metadata?: PresentedFrameMetadata): number {
		const mediaTime = metadata?.mediaTime;
		return Number.isFinite(mediaTime) ? (mediaTime ?? 0) : video.currentTime;
	}

	function updateTime(metadata?: PresentedFrameMetadata) {
		if (!video) return;

		const presentedTime = getPresentedTime(metadata);
		const currentTimeMs = presentedTime * 1000;

		// Past the end of the current clip (or on removed footage): continue with
		// the next clip on the timeline.
		const moved = !video.paused && !video.ended && followPlaylist(presentedTime);
		if (!moved) {
			// Apply playback speed from active speed region
			const activeSpeedRegion = findActiveSpeedRegion(currentTimeMs);
			enablePitchPreservingPlayback(video);
			video.playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;
			emitTime(presentedTime);
		}

		scheduleNextUpdate();
	}

	const handlePlay = () => {
		if (!allowPlaybackRef.current) {
			video.pause();
			return;
		}

		isPlayingRef.current = true;
		onPlayStateChange(true);
		cancelScheduledUpdate();
		scheduleNextUpdate();
	};

	const handlePause = () => {
		isPlayingRef.current = false;
		onPlayStateChange(false);
		cancelScheduledUpdate();
		emitTime(video.currentTime);
	};

	const handleSeeked = () => {
		isSeekingRef.current = false;
		// A seek that landed away from the pending jump is the user scrubbing; one
		// that landed on it stays guarded until a frame from there is presented.
		if (
			pendingJumpTargetMs !== null &&
			Math.abs(video.currentTime * 1000 - pendingJumpTargetMs) >= JUMP_ARRIVAL_TOLERANCE_MS
		) {
			pendingJumpTargetMs = null;
		}

		// Never leave the preview parked on removed footage after a seek.
		if (!followPlaylist(video.currentTime)) {
			emitTime(video.currentTime);
		}
	};

	const handleSeeking = () => {
		isSeekingRef.current = true;
		if (shouldSnapPausedFrameRef) {
			shouldSnapPausedFrameRef.current = true;
		}
		emitTime(video.currentTime);
	};

	return {
		dispose: cancelScheduledUpdate,
		handlePlay,
		handlePause,
		handleSeeked,
		handleSeeking,
	};
}
