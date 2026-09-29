import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { extractCaptionAudioSource } from "../captions/generate";
import { parseSilenceIntervals } from "../captions/silence";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { normalizeVideoSourcePath } from "../utils";

const execFileAsync = promisify(execFile);

/**
 * Quieter than this counts as silence for auto-cut. Slightly more sensitive than
 * the caption segmenter (-30 dB) so soft trailing syllables aren't cut off.
 */
const AUTO_CUT_NOISE_DB = -35;
/** Report silences down to this length; the renderer applies the user's threshold. */
const AUTO_CUT_MIN_SILENCE_S = 0.25;

/** `Duration: 00:01:02.50` from ffmpeg's input banner, in ms. */
export function parseFfmpegDurationMs(stderr: string): number | null {
	const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
	if (!match) {
		return null;
	}
	const [, hours, minutes, seconds] = match;
	return Math.round(
		(Number(hours) * 3600 + Number(minutes) * 60 + Number.parseFloat(seconds)) * 1000,
	);
}

export interface AutoCutSilenceResult {
	intervals: Array<{ startMs: number; endMs: number }>;
	audioSourceLabel: string;
}

/**
 * Acoustic silence in the recording's audio (the same source captions are made
 * from, so mic-only companion tracks are used when the video has no audio).
 */
export async function detectRecordingSilence(videoPath: string): Promise<AutoCutSilenceResult> {
	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		throw new Error("Missing source video path.");
	}

	const ffmpegPath = getFfmpegBinaryPath();
	const wavPath = path.join(
		app.getPath("temp"),
		`recordly-autocut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
	);

	try {
		const audioSource = await extractCaptionAudioSource({
			videoPath: normalizedVideoPath,
			ffmpegPath,
			wavPath,
		});
		const { stderr } = await execFileAsync(
			ffmpegPath,
			[
				"-hide_banner",
				"-nostats",
				"-i",
				wavPath,
				"-af",
				`silencedetect=noise=${AUTO_CUT_NOISE_DB}dB:d=${AUTO_CUT_MIN_SILENCE_S}`,
				"-f",
				"null",
				"-",
			],
			{ timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
		);

		// JSON can't carry Infinity; a silence running to the end is capped instead.
		const intervals = parseSilenceIntervals(stderr ?? "").map((interval) => ({
			startMs: interval.startMs,
			endMs: Number.isFinite(interval.endMs) ? interval.endMs : Number.MAX_SAFE_INTEGER,
		}));
		// Video that runs past the end of the audio track is silent too.
		const audioDurationMs = parseFfmpegDurationMs(stderr ?? "");
		if (audioDurationMs !== null) {
			intervals.push({ startMs: audioDurationMs, endMs: Number.MAX_SAFE_INTEGER });
		}

		return { intervals, audioSourceLabel: audioSource.label };
	} finally {
		await fs.rm(wavPath, { force: true }).catch(() => undefined);
	}
}
