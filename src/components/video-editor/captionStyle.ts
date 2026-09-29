import type { CaptionWordState } from "./captionLayout";
import {
	type AutoCaptionSettings,
	DEFAULT_AUTO_CAPTION_SETTINGS,
	getDefaultCaptionFontFamily,
} from "./types";

export const CAPTION_FONT_WEIGHT = 400;
export const CAPTION_LINE_HEIGHT = 1.32;

const DEFAULT_CAPTION_REFERENCE_WIDTH = 1920 * (DEFAULT_AUTO_CAPTION_SETTINGS.maxWidth / 100);

export function getCaptionTargetWidth(containerWidth: number, maxWidthPercent: number) {
	return Math.max(1, containerWidth * (maxWidthPercent / 100));
}

export function getCaptionScaledFontSize(
	fontSize: number,
	containerWidth: number,
	maxWidthPercent: number,
) {
	return Math.max(
		14,
		fontSize *
			(getCaptionTargetWidth(containerWidth, maxWidthPercent) /
				DEFAULT_CAPTION_REFERENCE_WIDTH),
	);
}

export function getCaptionPadding(fontSize: number) {
	return {
		x: fontSize * 1.1,
		y: fontSize * 0.78,
	};
}

export function getCaptionScaledRadius(radius: number, fontSize: number) {
	const baseline = Math.max(1, DEFAULT_AUTO_CAPTION_SETTINGS.fontSize);
	return Math.max(0, radius * (fontSize / baseline));
}

export function getCaptionTextMaxWidth(
	containerWidth: number,
	maxWidthPercent: number,
	fontSize: number,
) {
	const padding = getCaptionPadding(fontSize);
	return Math.max(
		fontSize * 4,
		getCaptionTargetWidth(containerWidth, maxWidthPercent) - padding.x * 2,
	);
}

/** CSS/canvas font shorthand for caption text at a given pixel size. */
export function getCaptionCanvasFont(
	settings: Pick<AutoCaptionSettings, "fontFamily" | "fontWeight">,
	fontSize: number,
) {
	return `${getCaptionFontWeight(settings)} ${fontSize}px ${settings.fontFamily || getDefaultCaptionFontFamily()}`;
}

export function getCaptionFontWeight(settings: Pick<AutoCaptionSettings, "fontWeight">) {
	return settings.fontWeight ?? CAPTION_FONT_WEIGHT;
}

export interface CaptionWordAppearance {
	color: string;
	/** Fill colour of the pill drawn behind the word, or null for no pill. */
	boxColor: string | null;
}

/**
 * Resolve how one caption word is drawn. Highlighting only applies when the
 * visible words carry real transcriber timings — estimated (evenly spread)
 * timings would highlight the wrong word, so those captions stay uniform.
 */
export function getCaptionWordAppearance(
	settings: Pick<AutoCaptionSettings, "textColor" | "highlightMode" | "highlightColor">,
	hasWordTimings: boolean,
	state: CaptionWordState,
): CaptionWordAppearance {
	const mode = settings.highlightMode ?? "off";
	if (mode === "off" || !hasWordTimings || state !== "active") {
		return { color: settings.textColor, boxColor: null };
	}

	if (mode === "color") {
		return { color: settings.highlightColor, boxColor: null };
	}

	return {
		color: getContrastingTextColor(settings.highlightColor),
		boxColor: settings.highlightColor,
	};
}

/** Geometry of the highlight pill, relative to the word's text box. */
export function getCaptionHighlightBoxMetrics(fontSize: number) {
	return {
		padX: fontSize * 0.09,
		height: fontSize * 1.16,
		radius: fontSize * 0.22,
	};
}

/** Black or white, whichever reads better on top of `background`. */
export function getContrastingTextColor(background: string) {
	const hex = background.trim().replace(/^#/, "");
	const full =
		hex.length === 3
			? hex
					.split("")
					.map((char) => char + char)
					.join("")
			: hex;
	if (!/^[0-9a-f]{6}$/i.test(full)) {
		return "#FFFFFF";
	}

	const channel = (offset: number) => {
		const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
	// Crossover where contrast against black equals contrast against white.
	return luminance > 0.179 ? "#000000" : "#FFFFFF";
}
