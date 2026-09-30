import { CaretDown, CaretRight, Play, Scissors, Sparkle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SliderControl } from "../SliderControl";
import { DEFAULT_SILENCE_SETTINGS, type AutoCutController } from "./useAutoCutController";

type Translator = (
	key: string,
	fallback?: string,
	vars?: Record<string, string | number>,
) => string;

interface AutoCutPanelProps {
	t: Translator;
	controller: AutoCutController;
	onOpenCaptions: () => void;
}

// DeepSeek V4.1 Flash at low effort matched Pro and high effort on our retake
// benchmark (8/8) at a fraction of the latency.
const AI_PRESETS = [
	{
		label: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		model: "deepseek-flash",
		reasoningEffort: "low",
	},
	{
		label: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		model: "",
		reasoningEffort: "",
	},
	{
		label: "Ollama",
		baseUrl: "http://localhost:11434/v1",
		model: "llama3.1",
		reasoningEffort: "",
	},
];

const rowClass =
	"flex items-center justify-between gap-3 rounded-lg bg-foreground/[0.03] px-2.5 py-2";

function formatSeconds(ms: number) {
	return `${(ms / 1000).toFixed(1)}s`;
}

export function AutoCutPanel({ t, controller, onOpenCaptions }: AutoCutPanelProps) {
	const tt = (key: string, fallback: string, vars?: Record<string, string | number>) =>
		t(`settings.autoCut.${key}`, fallback, vars);
	const [aiSettingsOpen, setAiSettingsOpen] = useState(false);

	return (
		<div className="flex h-full w-[332px] min-w-[280px] max-w-[332px] flex-[2] flex-col overflow-hidden rounded-2xl bg-editor-panel shadow-xl">
			<div
				className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
				style={{ scrollbarGutter: "stable" }}
			>
				<div className="flex items-center gap-2">
					<Scissors className="h-4 w-4 text-[#2563EB]" weight="fill" />
					<span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						{tt("title", "Auto-cut")}
					</span>
				</div>

				{!controller.hasTranscript ? (
					<div className="flex flex-col gap-3 rounded-lg bg-foreground/[0.03] p-3 text-xs text-muted-foreground">
						<p>
							{tt(
								"needsTranscript",
								"Auto-cut works from the transcript. Generate captions for this recording first.",
							)}
						</p>
						<Button size="sm" onClick={onOpenCaptions}>
							{tt("openCaptions", "Open Captions")}
						</Button>
					</div>
				) : (
					<>
						<ScopeToggle t={tt} controller={controller} />
						<DeadAirSection t={tt} controller={controller} />
						<RetakeSection
							t={tt}
							controller={controller}
							aiSettingsOpen={aiSettingsOpen}
							setAiSettingsOpen={setAiSettingsOpen}
						/>
					</>
				)}
			</div>

			{controller.hasTranscript ? (
				<div className="flex flex-col gap-1.5 border-t border-foreground/10 p-3">
					{controller.unresolvedCount > 0 ? (
						<div className="text-[10px] text-muted-foreground">
							{tt(
								"unresolved",
								"{{count}} retake group(s) still need a choice and won't be cut.",
								{ count: controller.unresolvedCount },
							)}
						</div>
					) : null}
					<Button
						className="w-full bg-[#2563EB] text-white hover:bg-[#1d4ed8]"
						disabled={controller.removalRanges.length === 0}
						onClick={controller.apply}
					>
						{controller.removalRanges.length === 0
							? tt("nothingToCut", "Nothing to cut")
							: tt("apply", "Remove {{seconds}}", {
									seconds: formatSeconds(controller.savedMs),
								})}
					</Button>
				</div>
			) : null}
		</div>
	);
}

type SectionProps = {
	t: (key: string, fallback: string, vars?: Record<string, string | number>) => string;
	controller: AutoCutController;
};

function ScopeToggle({ t, controller }: SectionProps) {
	const options = [
		{ value: "all" as const, label: t("scopeAll", "Whole timeline"), disabled: false },
		{
			value: "selected" as const,
			label: t("scopeSelected", "Selected clip"),
			disabled: !controller.hasSelectedClip,
		},
	];
	return (
		<div className="grid grid-cols-2 gap-1 rounded-lg bg-foreground/[0.04] p-1">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					disabled={option.disabled}
					onClick={() => controller.setScope(option.value)}
					className={cn(
						"rounded-md px-2 py-1.5 text-xs transition",
						controller.scope === option.value
							? "bg-editor-panel text-foreground shadow-sm"
							: "text-muted-foreground hover:text-foreground",
						option.disabled && "cursor-not-allowed opacity-40",
					)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

function DeadAirSection({ t, controller }: SectionProps) {
	const { acoustic } = controller;
	const acousticLabel =
		acoustic.status === "running"
			? t("audioAnalyzing", "Checking audio levels…")
			: acoustic.status === "ready"
				? t("audioReady", "Using audio levels, so untranscribed sounds are kept.")
				: acoustic.status === "error"
					? t("audioFailed", "Audio levels unavailable; using word timings only.")
					: null;

	return (
		<section className="flex flex-col gap-1.5">
			<div className={rowClass}>
				<div className="flex flex-col">
					<span className="text-sm font-medium text-foreground">
						{t("deadAir", "Dead air")}
					</span>
					<span className="text-[10px] text-muted-foreground">
						{t("deadAirSummary", "{{count}} pauses · {{seconds}}", {
							count: controller.silenceCuts.length,
							seconds: formatSeconds(controller.silenceSavedMs),
						})}
					</span>
				</div>
				<Switch
					checked={controller.includeSilence}
					onCheckedChange={controller.setIncludeSilence}
					aria-label={t("deadAir", "Dead air")}
					className="scale-75 data-[state=checked]:bg-[#2563EB]"
				/>
			</div>
			<SliderControl
				label={t("minPause", "Shorten pauses over")}
				value={controller.silenceSettings.minGapMs}
				defaultValue={DEFAULT_SILENCE_SETTINGS.minGapMs}
				min={300}
				max={3000}
				step={50}
				onChange={(minGapMs) =>
					controller.setSilenceSettings((current) => ({ ...current, minGapMs }))
				}
				formatValue={(value) => `${(value / 1000).toFixed(2)}s`}
				parseInput={(text) => Number.parseFloat(text.replace(/s$/, "")) * 1000}
			/>
			<SliderControl
				label={t("keepPadding", "Keep around speech")}
				value={controller.silenceSettings.keepMs}
				defaultValue={DEFAULT_SILENCE_SETTINGS.keepMs}
				min={0}
				max={500}
				step={10}
				onChange={(keepMs) =>
					controller.setSilenceSettings((current) => ({ ...current, keepMs }))
				}
				formatValue={(value) => `${Math.round(value)}ms`}
				parseInput={(text) => Number.parseFloat(text.replace(/ms$/, ""))}
			/>
			{acousticLabel ? (
				<div className="px-1 text-[10px] text-muted-foreground">{acousticLabel}</div>
			) : null}
		</section>
	);
}

function RetakeSection({
	t,
	controller,
	aiSettingsOpen,
	setAiSettingsOpen,
}: SectionProps & { aiSettingsOpen: boolean; setAiSettingsOpen: (open: boolean) => void }) {
	const { retakes } = controller;
	const running = retakes.status === "running";

	return (
		<section className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between px-1">
				<span className="text-sm font-medium text-foreground">
					{t("retakes", "Retakes")}
				</span>
			</div>
			<div className={rowClass}>
				<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
					<Sparkle className="h-3.5 w-3.5" />
					{controller.aiConfigured
						? t("useAi", "Use AI assist")
						: t("aiNotConfigured", "AI assist not set up")}
				</div>
				<Switch
					checked={controller.useAi && controller.aiConfigured}
					disabled={!controller.aiConfigured}
					onCheckedChange={controller.setUseAi}
					aria-label={t("useAi", "Use AI assist")}
					className="scale-75 data-[state=checked]:bg-[#2563EB]"
				/>
			</div>
			<button
				type="button"
				className="flex items-center gap-1 px-1 text-[10px] text-muted-foreground hover:text-foreground"
				onClick={() => setAiSettingsOpen(!aiSettingsOpen)}
			>
				{aiSettingsOpen ? (
					<CaretDown className="h-3 w-3" />
				) : (
					<CaretRight className="h-3 w-3" />
				)}
				{t("aiSettings", "AI assist settings")}
			</button>
			{aiSettingsOpen ? <AiSettings t={t} controller={controller} /> : null}

			<Button
				variant="outline"
				className="w-full"
				disabled={running}
				onClick={() => void controller.detectRetakes()}
			>
				{running
					? retakes.progress
					: retakes.status === "done"
						? t("findAgain", "Find retakes again")
						: t("find", "Find retakes")}
			</Button>

			{retakes.status === "done" ? (
				<div className="px-1 text-[10px] text-muted-foreground">
					{retakes.groups.length === 0
						? t("noneFound", "No retakes found.")
						: t("found", "{{count}} retake group(s). Pick the take to keep.", {
								count: retakes.groups.length,
							})}
					{retakes.aiUsed && retakes.tokens
						? ` ${t("aiTokens", "AI assist used {{tokens}} tokens.", { tokens: retakes.tokens })}`
						: ""}
					{retakes.aiError ? (
						<div className="mt-1 text-amber-500">
							{t(
								"aiFailed",
								"AI assist failed, showing text-match results: {{error}}",
								{
									error: retakes.aiError,
								},
							)}
						</div>
					) : null}
				</div>
			) : null}

			{controller.retakeGroups.map((group) => {
				const decision = controller.decisions[group.id];
				return (
					<div
						key={group.id}
						className="flex flex-col gap-1 rounded-lg border border-foreground/10 bg-foreground/[0.02] p-2"
					>
						<div className="text-[10px] text-muted-foreground">{group.reason}</div>
						{group.takes.map((take, takeIndex) => {
							const key = `${group.id}:${takeIndex}`;
							const selected = decision === takeIndex;
							return (
								<div
									key={key}
									className={cn(
										"flex items-start gap-2 rounded-md p-1.5",
										selected ? "bg-[#2563EB]/10" : "hover:bg-foreground/[0.04]",
									)}
								>
									<button
										type="button"
										title={t("playTake", "Play take")}
										onClick={() => controller.previewTake(key, take)}
										className={cn(
											"mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground",
											controller.previewKey === key &&
												"bg-[#2563EB] text-white",
										)}
									>
										<Play className="h-2.5 w-2.5" weight="fill" />
									</button>
									<div className="min-w-0 flex-1">
										<div className="line-clamp-2 text-xs text-foreground">
											{take.text}
										</div>
										<div className="text-[10px] text-muted-foreground">
											{t("takeLabel", "Take {{index}} · {{seconds}}", {
												index: takeIndex + 1,
												seconds: formatSeconds(take.endMs - take.startMs),
											})}
										</div>
									</div>
									<button
										type="button"
										onClick={() => controller.setDecision(group.id, takeIndex)}
										className={cn(
											"shrink-0 rounded-md px-2 py-1 text-[10px] font-medium",
											selected
												? "bg-[#2563EB] text-white"
												: "bg-foreground/10 text-foreground hover:bg-foreground/15",
										)}
									>
										{selected ? t("kept", "Keeping") : t("keep", "Keep")}
									</button>
								</div>
							);
						})}
						<button
							type="button"
							onClick={() => controller.setDecision(group.id, "all")}
							className={cn(
								"self-end rounded-md px-2 py-1 text-[10px]",
								decision === "all"
									? "bg-foreground/15 text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{t("notRetake", "Not a retake, keep all")}
						</button>
					</div>
				);
			})}
		</section>
	);
}

function AiSettings({ t, controller }: SectionProps) {
	const [baseUrl, setBaseUrl] = useState("");
	const [model, setModel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const settings = controller.llmSettings;

	const [reasoningEffort, setReasoningEffort] = useState("");

	useEffect(() => {
		setBaseUrl(settings?.baseUrl ?? "");
		setModel(settings?.model ?? "");
		setReasoningEffort(settings?.reasoningEffort ?? "");
	}, [settings?.baseUrl, settings?.model, settings?.reasoningEffort]);

	const inputClass =
		"h-8 w-full rounded-md border border-foreground/10 bg-foreground/5 px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-[#2563EB]";

	return (
		<div className="flex flex-col gap-1.5 rounded-lg bg-foreground/[0.03] p-2.5">
			<p className="text-[10px] text-muted-foreground">
				{t(
					"aiExplainer",
					"Any OpenAI-compatible endpoint. Only the transcript text is sent, never audio or video.",
				)}
			</p>
			<div className="flex flex-wrap gap-1">
				{AI_PRESETS.map((preset) => (
					<button
						key={preset.label}
						type="button"
						onClick={() => {
							setBaseUrl(preset.baseUrl);
							if (preset.model) setModel(preset.model);
							setReasoningEffort(preset.reasoningEffort);
						}}
						className="rounded-md bg-foreground/10 px-2 py-0.5 text-[10px] text-foreground hover:bg-foreground/15"
					>
						{preset.label}
					</button>
				))}
			</div>
			<input
				className={inputClass}
				value={baseUrl}
				onChange={(event) => setBaseUrl(event.target.value)}
				placeholder="https://api.deepseek.com/v1"
				aria-label={t("aiEndpoint", "Endpoint URL")}
			/>
			<input
				className={inputClass}
				value={model}
				onChange={(event) => setModel(event.target.value)}
				placeholder={t("aiModel", "Model name")}
				aria-label={t("aiModel", "Model name")}
			/>
			<input
				className={inputClass}
				value={reasoningEffort}
				onChange={(event) => setReasoningEffort(event.target.value)}
				placeholder={t("aiEffort", "Reasoning effort (optional, e.g. low)")}
				aria-label={t("aiEffort", "Reasoning effort (optional, e.g. low)")}
			/>
			<input
				className={inputClass}
				type="password"
				value={apiKey}
				onChange={(event) => setApiKey(event.target.value)}
				placeholder={
					settings?.hasApiKey
						? t("aiKeyStored", "API key saved (leave blank to keep)")
						: t("aiKey", "API key")
				}
				aria-label={t("aiKey", "API key")}
			/>
			{settings?.hasApiKey && !settings.keyEncrypted ? (
				<p className="text-[10px] text-amber-500">
					{t(
						"aiKeyNotEncrypted",
						"No system keychain found, so the key is stored obfuscated rather than encrypted.",
					)}
				</p>
			) : null}
			<div className="flex gap-1.5">
				<Button
					size="sm"
					className="flex-1"
					onClick={() => {
						void controller.saveLlmSettings({
							baseUrl,
							model,
							reasoningEffort,
							...(apiKey ? { apiKey } : {}),
						});
						setApiKey("");
					}}
				>
					{t("aiSave", "Save")}
				</Button>
				<Button
					size="sm"
					variant="outline"
					className="flex-1"
					disabled={!controller.aiConfigured}
					onClick={() => void controller.testLlm()}
				>
					{t("aiTest", "Test")}
				</Button>
				{settings?.hasApiKey ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={() =>
							void controller.saveLlmSettings({
								baseUrl,
								model,
								reasoningEffort,
								apiKey: null,
							})
						}
					>
						{t("aiClearKey", "Clear key")}
					</Button>
				) : null}
			</div>
		</div>
	);
}
