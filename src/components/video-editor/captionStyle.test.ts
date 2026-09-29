import { describe, expect, it } from "vitest";
import {
	getCaptionCanvasFont,
	getCaptionWordAppearance,
	getContrastingTextColor,
} from "./captionStyle";
import { DEFAULT_AUTO_CAPTION_SETTINGS } from "./types";

const base = {
	...DEFAULT_AUTO_CAPTION_SETTINGS,
	textColor: "#FFFFFF",
	highlightColor: "#FACC15",
};

describe("getCaptionWordAppearance", () => {
	it("renders every word uniformly when highlighting is off", () => {
		for (const state of ["spoken", "active", "upcoming"] as const) {
			expect(
				getCaptionWordAppearance({ ...base, highlightMode: "off" }, true, state),
			).toEqual({
				color: "#FFFFFF",
				boxColor: null,
			});
		}
	});

	it("colours only the active word in color mode", () => {
		const settings = { ...base, highlightMode: "color" as const };
		expect(getCaptionWordAppearance(settings, true, "active")).toEqual({
			color: "#FACC15",
			boxColor: null,
		});
		expect(getCaptionWordAppearance(settings, true, "spoken").color).toBe("#FFFFFF");
		expect(getCaptionWordAppearance(settings, true, "upcoming").color).toBe("#FFFFFF");
	});

	it("puts a pill behind the active word with contrasting text in box mode", () => {
		const settings = { ...base, highlightMode: "box" as const };
		expect(getCaptionWordAppearance(settings, true, "active")).toEqual({
			color: "#000000",
			boxColor: "#FACC15",
		});
		expect(
			getCaptionWordAppearance({ ...settings, highlightColor: "#1D4ED8" }, true, "active"),
		).toEqual({ color: "#FFFFFF", boxColor: "#1D4ED8" });
		expect(getCaptionWordAppearance(settings, true, "upcoming").boxColor).toBeNull();
	});

	it("does not highlight estimated word timings", () => {
		expect(
			getCaptionWordAppearance({ ...base, highlightMode: "box" }, false, "active"),
		).toEqual({ color: "#FFFFFF", boxColor: null });
	});

	it("treats settings saved before highlighting existed as off", () => {
		const legacy = { textColor: "#FFFFFF", highlightColor: "#FACC15" } as Parameters<
			typeof getCaptionWordAppearance
		>[0];
		expect(getCaptionWordAppearance(legacy, true, "active").boxColor).toBeNull();
	});
});

describe("getContrastingTextColor", () => {
	it.each([
		["#FFFFFF", "#000000"],
		["#FACC15", "#000000"],
		["#fff", "#000000"],
		["#000000", "#FFFFFF"],
		["#2563EB", "#FFFFFF"],
		["not-a-colour", "#FFFFFF"],
	])("%s -> %s", (background, expected) => {
		expect(getContrastingTextColor(background)).toBe(expected);
	});
});

describe("getCaptionCanvasFont", () => {
	it("combines weight, size and family", () => {
		expect(getCaptionCanvasFont({ fontFamily: "Inter", fontWeight: 700 }, 24)).toBe(
			"700 24px Inter",
		);
	});

	it("falls back to the default family and regular weight", () => {
		const font = getCaptionCanvasFont(
			{ fontFamily: "", fontWeight: undefined as unknown as 400 },
			24,
		);
		expect(font.startsWith("400 24px ")).toBe(true);
		expect(font).toContain("SF Pro Text");
	});
});
