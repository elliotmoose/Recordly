import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

const { parseFfmpegDurationMs } = await import("./silence");

describe("parseFfmpegDurationMs", () => {
	it("reads the input duration banner", () => {
		expect(
			parseFfmpegDurationMs(
				"Input #0, wav, from 'a.wav':\n  Duration: 00:01:02.50, bitrate: 256 kb/s",
			),
		).toBe(62_500);
		expect(parseFfmpegDurationMs("  Duration: 01:00:00.04, start: 0")).toBe(3_600_040);
	});

	it("returns null without a banner", () => {
		expect(parseFfmpegDurationMs("no duration here")).toBeNull();
	});
});
