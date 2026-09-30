import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPlaybackSegments, type PlaybackSegment } from "../types";
import { createVideoEventHandlers } from "./videoEventHandlers";

type PresentedFrameCallback = (now: DOMHighResTimeStamp, metadata: { mediaTime?: number }) => void;

type MockVideo = HTMLVideoElement & {
	requestVideoFrameCallback?: (callback: PresentedFrameCallback) => number;
	cancelVideoFrameCallback?: (handle: number) => void;
};

function createMutableRef<T>(value: T) {
	return { current: value };
}

function createMockVideo(overrides: Partial<MockVideo> = {}): MockVideo {
	const video = {
		currentTime: 0.5,
		duration: 10,
		paused: false,
		ended: false,
		playbackRate: 1,
		pause: vi.fn(),
	} as unknown as MockVideo;

	return Object.assign(video, overrides);
}

describe("createVideoEventHandlers", () => {
	let requestAnimationFrameMock: ReturnType<typeof vi.fn>;
	let cancelAnimationFrameMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		requestAnimationFrameMock = vi.fn(() => 11);
		cancelAnimationFrameMock = vi.fn();
		vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
		vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("prefers requestVideoFrameCallback mediaTime when available", () => {
		let presentedFrameCallback: PresentedFrameCallback | null = null;
		const video = createMockVideo({
			requestVideoFrameCallback: vi.fn((callback) => {
				presentedFrameCallback = callback;
				return 7;
			}),
			cancelVideoFrameCallback: vi.fn(),
		});
		const onPlayStateChange = vi.fn();
		const onTimeUpdate = vi.fn();
		const currentTimeRef = createMutableRef(0);
		const timeUpdateAnimationRef = createMutableRef<number | null>(null);

		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef,
			timeUpdateAnimationRef,
			onPlayStateChange,
			onTimeUpdate,
			playbackSegmentsRef: createMutableRef<PlaybackSegment[]>([]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		expect(onPlayStateChange).toHaveBeenCalledWith(true);
		expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
		expect(requestAnimationFrameMock).not.toHaveBeenCalled();

		presentedFrameCallback?.(0, { mediaTime: 1.25 });

		expect(onTimeUpdate).toHaveBeenCalledWith(1.25);
		expect(currentTimeRef.current).toBe(1250);
	});

	it("falls back to requestAnimationFrame when requestVideoFrameCallback is unavailable", () => {
		let animationFrameCallback: FrameRequestCallback | null = null;
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			animationFrameCallback = callback;
			return 19;
		});
		const video = createMockVideo({ currentTime: 0.75 });
		const onTimeUpdate = vi.fn();

		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			playbackSegmentsRef: createMutableRef<PlaybackSegment[]>([]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);

		video.paused = true;
		animationFrameCallback?.(0);

		expect(onTimeUpdate).toHaveBeenCalledWith(0.75);
	});

	it("skips removed footage when playback reaches a cut region", () => {
		let animationFrameCallback: FrameRequestCallback | null = null;
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			animationFrameCallback = callback;
			return 29;
		});
		const video = createMockVideo({ currentTime: 1.25, duration: 10 });
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			// Footage 1-2s is cut: clips cover 0-1s and 2-10s.
			playbackSegmentsRef: createMutableRef(
				getPlaybackSegments([
					{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
					{ id: "b", startMs: 2000, endMs: 10_000, speed: 1 },
				]),
			),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		animationFrameCallback?.(0);

		expect(video.currentTime).toBe(2);
		expect(video.pause).not.toHaveBeenCalled();
		expect(onTimeUpdate).toHaveBeenLastCalledWith(2);
	});

	it("cancels a pending requestVideoFrameCallback on pause and dispose", () => {
		const cancelVideoFrameCallback = vi.fn();
		const video = createMockVideo({
			requestVideoFrameCallback: vi.fn(() => 23),
			cancelVideoFrameCallback,
		});
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate: vi.fn(),
			playbackSegmentsRef: createMutableRef<PlaybackSegment[]>([]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		handlers.handlePause();
		expect(cancelVideoFrameCallback).toHaveBeenCalledWith(23);

		cancelVideoFrameCallback.mockClear();
		handlers.handlePlay();
		handlers.dispose();
		expect(cancelVideoFrameCallback).toHaveBeenCalledWith(23);
	});

	it("skips removed footage after a paused seek", () => {
		const video = createMockVideo({
			currentTime: 1.25,
			paused: true,
		});
		const onTimeUpdate = vi.fn();
		const shouldSnapPausedFrameRef = createMutableRef(false);
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(true),
			shouldSnapPausedFrameRef,
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			// Footage 1-2s is cut: clips cover 0-1s and 2-10s.
			playbackSegmentsRef: createMutableRef(
				getPlaybackSegments([
					{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
					{ id: "b", startMs: 2000, endMs: 10_000, speed: 1 },
				]),
			),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handleSeeking();
		handlers.handleSeeked();

		expect(video.currentTime).toBe(2);
		expect(onTimeUpdate).toHaveBeenLastCalledWith(2);
		expect(shouldSnapPausedFrameRef.current).toBe(true);
	});

	it("jumps back in the source when the next clip on the timeline comes from earlier", () => {
		let animationFrameCallback: FrameRequestCallback | null = null;
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			animationFrameCallback = callback;
			return 31;
		});
		// Timeline: source 6-8s, then source 1-3s. Playback is at the end of the first clip.
		const video = createMockVideo({ currentTime: 7.99, duration: 10 });
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			playbackSegmentsRef: createMutableRef(
				getPlaybackSegments([
					{ id: "b", startMs: 0, endMs: 2000, speed: 1, sourceStartMs: 6000 },
					{ id: "a", startMs: 2000, endMs: 4000, speed: 1, sourceStartMs: 1000 },
				]),
			),
			speedRegionsRef: createMutableRef([]),
		});

		video.currentTime = 7;
		handlers.handlePlay();
		animationFrameCallback?.(0);
		video.currentTime = 7.99;
		animationFrameCallback?.(0);

		expect(video.currentTime).toBe(1);
		expect(onTimeUpdate).toHaveBeenLastCalledWith(1);
	});

	it("jumps at the exact clip boundary even when frame callbacks are sparse", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let animationFrameCallback: FrameRequestCallback | null = null;
			requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
				animationFrameCallback = callback;
				return 41;
			});
			// Timeline: source 6-8s, then source 1-3s. 400ms before the first clip ends.
			const video = createMockVideo({ currentTime: 7.6, duration: 10 });
			const handlers = createVideoEventHandlers({
				video,
				isSeekingRef: createMutableRef(false),
				isPlayingRef: createMutableRef(false),
				allowPlaybackRef: createMutableRef(true),
				currentTimeRef: createMutableRef(0),
				timeUpdateAnimationRef: createMutableRef<number | null>(null),
				onPlayStateChange: vi.fn(),
				onTimeUpdate: vi.fn(),
				playbackSegmentsRef: createMutableRef(
					getPlaybackSegments([
						{ id: "b", startMs: 0, endMs: 2000, speed: 1, sourceStartMs: 6000 },
						{ id: "a", startMs: 2000, endMs: 4000, speed: 1, sourceStartMs: 1000 },
					]),
				),
				speedRegionsRef: createMutableRef([]),
			});

			handlers.handlePlay();
			animationFrameCallback?.(0);
			expect(video.currentTime).toBe(7.6);

			// No further frame callback arrives; the media clock reaches the boundary.
			video.currentTime = 8;
			vi.advanceTimersByTime(400);
			expect(video.currentTime).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("ignores stale frame times from before a jump", () => {
		let animationFrameCallback: FrameRequestCallback | null = null;
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			animationFrameCallback = callback;
			return 43;
		});
		// Timeline: source 6-8s, source 1-3s, source 4-5s.
		const video = createMockVideo({ currentTime: 7.99, duration: 10 });
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate: vi.fn(),
			playbackSegmentsRef: createMutableRef(
				getPlaybackSegments([
					{ id: "b", startMs: 0, endMs: 2000, speed: 1, sourceStartMs: 6000 },
					{ id: "a", startMs: 2000, endMs: 4000, speed: 1, sourceStartMs: 1000 },
					{ id: "c", startMs: 4000, endMs: 5000, speed: 1, sourceStartMs: 4000 },
				]),
			),
			speedRegionsRef: createMutableRef([]),
		});

		video.currentTime = 7;
		handlers.handlePlay();
		animationFrameCallback?.(0);
		video.currentTime = 7.99;
		animationFrameCallback?.(0);
		expect(video.currentTime).toBe(1);

		// A frame callback queued before the seek still reports 7.99s.
		video.currentTime = 7.99;
		animationFrameCallback?.(0);
		expect(video.currentTime).toBe(7.99);

		// The seek lands, but a late callback still reports the old position.
		video.currentTime = 1;
		handlers.handleSeeked();
		video.currentTime = 7.99;
		animationFrameCallback?.(0);
		expect(video.currentTime).toBe(7.99);

		// Frames from the new position arrive: playback carries on in clip "a".
		video.currentTime = 1.02;
		animationFrameCallback?.(0);
		expect(video.currentTime).toBe(1.02);
	});
});
