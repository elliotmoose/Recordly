import os from "node:os";

/**
 * Half the logical cores (≈ physical cores), 1–8. ggml's worker threads spin
 * while waiting, so using every core while the editor is also rendering makes
 * transcription collapse: on 4 cores with 2 busy, 4 threads took 209s where
 * 2 threads took 49s.
 */
export function getWhisperThreadCount(logicalCores = os.availableParallelism()) {
	return Math.max(1, Math.min(8, Math.floor(logicalCores / 2)));
}
