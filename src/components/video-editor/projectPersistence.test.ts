import { afterEach, describe, expect, it, vi } from "vitest";

import {
	getDefaultBorderRadiusPercent,
	legacyBorderRadiusPixelsToPercent,
	normalizeProjectEditor,
	resolveVideoUrl,
} from "./projectPersistence";
import {
	ADVANCED_VERTICAL_PADDING_MAX,
	type AutoCaptionSettings,
	DEFAULT_AUTO_CAPTION_SETTINGS,
	getDefaultCaptionFontFamily,
} from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("resolveVideoUrl", () => {
	it("does not send an already renderable URL through the local-path IPC", async () => {
		const getLocalMediaUrl = vi.fn();
		vi.stubGlobal("window", { electronAPI: { getLocalMediaUrl } });

		await expect(resolveVideoUrl("http://127.0.0.1:1234/video?path=test")).resolves.toBe(
			"http://127.0.0.1:1234/video?path=test",
		);
		expect(getLocalMediaUrl).not.toHaveBeenCalled();
	});

	it("normalizes a file URL before requesting a local media URL", async () => {
		const getLocalMediaUrl = vi.fn().mockResolvedValue({
			success: true,
			url: "http://127.0.0.1:1234/video?path=clip",
		});
		vi.stubGlobal("window", { electronAPI: { getLocalMediaUrl } });

		await resolveVideoUrl("file:///Users/demo/My%20Clip.mp4");
		expect(getLocalMediaUrl).toHaveBeenCalledWith("/Users/demo/My Clip.mp4");
	});
});

describe("normalizeProjectEditor", () => {
	it("defaults to 8% on macOS and square corners elsewhere", () => {
		expect(getDefaultBorderRadiusPercent("MacIntel")).toBe(8);
		expect(getDefaultBorderRadiusPercent("Win32")).toBe(0);
		expect(getDefaultBorderRadiusPercent("Linux x86_64")).toBe(0);
	});

	it("clamps radius percentages", () => {
		expect(normalizeProjectEditor({ borderRadius: 75 }).borderRadius).toBe(50);
	});

	it("converts legacy 1080p-relative radius pixels to percentages", () => {
		expect(legacyBorderRadiusPixelsToPercent(54)).toBe(5);
	});

	it("preserves the extended advanced vertical padding range", () => {
		const editor = normalizeProjectEditor({
			padding: {
				top: 240,
				bottom: ADVANCED_VERTICAL_PADDING_MAX,
				left: 22,
				right: 22,
				linked: false,
			},
		});

		expect(editor.padding).toMatchObject({
			top: 240,
			bottom: ADVANCED_VERTICAL_PADDING_MAX,
			left: 22,
			right: 22,
			linked: false,
		});
	});

	it("keeps linked padding clamped to the original range", () => {
		const editor = normalizeProjectEditor({
			padding: {
				top: ADVANCED_VERTICAL_PADDING_MAX,
				bottom: ADVANCED_VERTICAL_PADDING_MAX,
				left: ADVANCED_VERTICAL_PADDING_MAX,
				right: ADVANCED_VERTICAL_PADDING_MAX,
				linked: true,
			},
		});

		expect(editor.padding).toMatchObject({
			top: 100,
			bottom: 100,
			left: 100,
			right: 100,
			linked: true,
		});
	});

	it("migrates legacy webcam radius pixels to percentage roundness", () => {
		const editor = normalizeProjectEditor({
			webcam: {
				cornerRadius: 90,
				width: 40,
				height: 40,
			} as never,
		});

		expect(editor.webcam.roundness).toBeCloseTo(17.36, 1);
		expect(editor.webcam.cornerRadius).toBeUndefined();
	});

	it("uses the legacy webcam size when migrating radius pixels", () => {
		const editor = normalizeProjectEditor({
			webcam: {
				cornerRadius: 90,
				size: 80,
			} as never,
		});

		expect(editor.webcam.width).toBe(80);
		expect(editor.webcam.height).toBe(80);
		expect(editor.webcam.roundness).toBeCloseTo(4.34, 1);
	});
});

describe("normalizeProjectEditor caption typography", () => {
	it("keeps a chosen caption font, weight and highlight", () => {
		const editor = normalizeProjectEditor({
			autoCaptionSettings: {
				...DEFAULT_AUTO_CAPTION_SETTINGS,
				fontFamily: "Georgia, serif",
				fontWeight: 700,
				highlightMode: "box",
				highlightColor: "#22C55E",
			},
		});

		expect(editor.autoCaptionSettings.fontFamily).toBe("Georgia, serif");
		expect(editor.autoCaptionSettings.fontWeight).toBe(700);
		expect(editor.autoCaptionSettings.highlightMode).toBe("box");
		expect(editor.autoCaptionSettings.highlightColor).toBe("#22C55E");
	});

	it("defaults projects saved before these settings existed", () => {
		const editor = normalizeProjectEditor({
			autoCaptionSettings: {
				enabled: true,
				fontWeight: 123,
				highlightMode: "sparkle",
			} as unknown as AutoCaptionSettings,
		});

		expect(editor.autoCaptionSettings.fontFamily).toBe(getDefaultCaptionFontFamily());
		expect(editor.autoCaptionSettings.fontWeight).toBe(400);
		expect(editor.autoCaptionSettings.highlightMode).toBe("off");
		expect(editor.autoCaptionSettings.highlightColor).toBe(
			DEFAULT_AUTO_CAPTION_SETTINGS.highlightColor,
		);
	});
});

describe("normalizeProjectEditor clip source positions", () => {
	it("keeps sourceStartMs on moved clips and omits it on legacy ones", () => {
		const editor = normalizeProjectEditor({
			clipRegions: [
				{ id: "a", startMs: 0, endMs: 1000, speed: 1, sourceStartMs: 3000 },
				{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
			],
		});
		expect(editor.clipRegions[0].sourceStartMs).toBe(3000);
		expect("sourceStartMs" in editor.clipRegions[1]).toBe(false);
	});
});
