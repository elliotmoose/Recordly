import {
	buildActiveCaptionLayout,
	type CaptionLineLayout,
} from "@/components/video-editor/captionLayout";
import {
	CAPTION_LINE_HEIGHT,
	getCaptionCanvasFont,
	getCaptionHighlightBoxMetrics,
	getCaptionPadding,
	getCaptionScaledFontSize,
	getCaptionScaledRadius,
	getCaptionTextMaxWidth,
	getCaptionWordAppearance,
} from "@/components/video-editor/captionStyle";
import type { AutoCaptionSettings, CaptionCue } from "@/components/video-editor/types";
import { drawSquircleOnCanvas } from "@/lib/geometry/squircle";

/**
 * Wait (bounded) for the caption font to be available, so an export started
 * right after picking a web font doesn't rasterize with the fallback face.
 */
export async function ensureCaptionFontLoaded(
	settings: AutoCaptionSettings | null | undefined,
	timeoutMs = 3000,
) {
	if (!settings?.enabled || typeof document === "undefined" || !document.fonts?.load) {
		return;
	}

	try {
		await Promise.race([
			document.fonts.load(getCaptionCanvasFont(settings, 32)),
			new Promise((resolve) => setTimeout(resolve, timeoutMs)),
		]);
	} catch {
		// An unknown family just falls back like the preview does.
	}
}

/** Draw the active caption using the same typography and timing as preview. */
export function renderCaptions(
	ctx: CanvasRenderingContext2D,
	cues: CaptionCue[],
	settings: AutoCaptionSettings,
	width: number,
	height: number,
	timeMs: number,
) {
	if (!settings.enabled || cues.length === 0) {
		return;
	}

	ctx.save();

	const fontSize = getCaptionScaledFontSize(settings.fontSize, width, settings.maxWidth);
	ctx.font = getCaptionCanvasFont(settings, fontSize);
	const padding = getCaptionPadding(fontSize);

	const activeCaptionLayout = buildActiveCaptionLayout({
		cues,
		timeMs,
		settings,
		maxWidthPx: getCaptionTextMaxWidth(width, settings.maxWidth, fontSize),
		measureText: (text) => ctx.measureText(text).width,
	});
	if (!activeCaptionLayout) {
		ctx.restore();
		return;
	}

	const lineHeight = fontSize * CAPTION_LINE_HEIGHT;
	const paddingX = padding.x;
	const paddingY = padding.y;
	const textBlockHeight = activeCaptionLayout.visibleLines.length * lineHeight;
	const boxHeight = textBlockHeight + paddingY * 2;
	const centerX = width / 2;
	const centerY = height - (height * settings.bottomOffset) / 100 - boxHeight / 2;
	const maxMeasuredWidth = activeCaptionLayout.visibleLines.reduce(
		(largest, line) => Math.max(largest, line.width),
		0,
	);
	const boxWidth = Math.min(
		width * (settings.maxWidth / 100) + paddingX * 2,
		maxMeasuredWidth + paddingX * 2,
	);

	ctx.translate(centerX, centerY + activeCaptionLayout.translateY);
	ctx.scale(activeCaptionLayout.scale, activeCaptionLayout.scale);
	ctx.globalAlpha = activeCaptionLayout.opacity;

	ctx.fillStyle = `rgba(0, 0, 0, ${settings.backgroundOpacity})`;
	drawSquircleOnCanvas(ctx, {
		x: -boxWidth / 2,
		y: -boxHeight / 2,
		width: boxWidth,
		height: boxHeight,
		radius: getCaptionScaledRadius(settings.boxRadius, fontSize),
	});
	ctx.fill();

	activeCaptionLayout.visibleLines.forEach((line, lineIndex) => {
		drawCaptionLine(ctx, {
			line,
			startX: -line.width / 2,
			centerY: -boxHeight / 2 + paddingY + lineHeight * lineIndex + lineHeight / 2,
			fontSize,
			settings,
			hasWordTimings: activeCaptionLayout.hasWordTimings,
		});
	});

	ctx.restore();
}

/**
 * Draw one laid-out caption line with per-word highlighting. Pills are drawn in
 * a first pass so a padded pill never paints over the neighbouring word's text.
 * Uses the context's current font and globalAlpha.
 */
export function drawCaptionLine(
	ctx: CanvasRenderingContext2D,
	options: {
		line: CaptionLineLayout;
		startX: number;
		centerY: number;
		fontSize: number;
		settings: AutoCaptionSettings;
		hasWordTimings: boolean;
	},
) {
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";

	let cursorX = options.startX;
	const segments = options.line.words.map((word) => {
		const segmentText = `${word.leadingSpace ? " " : ""}${word.text}`;
		const segmentWidth = ctx.measureText(segmentText).width;
		const wordWidth = ctx.measureText(word.text).width;
		const segment = {
			segmentText,
			x: cursorX,
			wordX: cursorX + segmentWidth - wordWidth,
			wordWidth,
			appearance: getCaptionWordAppearance(
				options.settings,
				options.hasWordTimings,
				word.state,
			),
		};
		cursorX += segmentWidth;
		return segment;
	});

	const box = getCaptionHighlightBoxMetrics(options.fontSize);
	for (const segment of segments) {
		if (!segment.appearance.boxColor) {
			continue;
		}
		ctx.fillStyle = segment.appearance.boxColor;
		ctx.beginPath();
		ctx.roundRect(
			segment.wordX - box.padX,
			options.centerY - box.height / 2,
			segment.wordWidth + box.padX * 2,
			box.height,
			box.radius,
		);
		ctx.fill();
	}

	for (const segment of segments) {
		ctx.fillStyle = segment.appearance.color;
		ctx.fillText(segment.segmentText, segment.x, options.centerY);
	}
}
