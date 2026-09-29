import { net, safeStorage } from "electron";
import { readAppSetting, writeAppSetting } from "../../appSettingsStore";

const SETTINGS_KEY = "autoCutLlm";
const REQUEST_TIMEOUT_MS = 90_000;

interface StoredLlmSettings {
	baseUrl: string;
	model: string;
	/** Encrypted with safeStorage when available, else base64 ("plain"). */
	apiKey: string | null;
	apiKeyEncoding: "safeStorage" | "plain" | null;
}

export interface LlmSettingsView {
	baseUrl: string;
	model: string;
	hasApiKey: boolean;
	/** False when the OS keychain isn't available and the key is only obfuscated. */
	keyEncrypted: boolean;
}

export interface LlmSettingsUpdate {
	baseUrl: string;
	model: string;
	/** undefined keeps the stored key, null or "" clears it. */
	apiKey?: string | null;
}

export interface LlmCompletionRequest {
	system: string;
	user: string;
	/** Ask for a JSON object response when the provider supports it. */
	json?: boolean;
	maxTokens?: number;
}

export interface LlmCompletionResult {
	text: string;
	model: string;
	usage: { promptTokens: number; completionTokens: number } | null;
	elapsedMs: number;
}

function readStoredSettings(): StoredLlmSettings {
	const raw = readAppSetting(SETTINGS_KEY);
	const value = raw && typeof raw === "object" ? (raw as Partial<StoredLlmSettings>) : {};
	return {
		baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
		model: typeof value.model === "string" ? value.model : "",
		apiKey: typeof value.apiKey === "string" && value.apiKey ? value.apiKey : null,
		apiKeyEncoding:
			value.apiKeyEncoding === "safeStorage" || value.apiKeyEncoding === "plain"
				? value.apiKeyEncoding
				: null,
	};
}

function decodeApiKey(settings: StoredLlmSettings): string | null {
	if (!settings.apiKey) {
		return null;
	}
	try {
		const bytes = Buffer.from(settings.apiKey, "base64");
		return settings.apiKeyEncoding === "safeStorage"
			? safeStorage.decryptString(bytes)
			: bytes.toString("utf-8");
	} catch {
		return null;
	}
}

export function getLlmSettings(): LlmSettingsView {
	const settings = readStoredSettings();
	return {
		baseUrl: settings.baseUrl,
		model: settings.model,
		hasApiKey: Boolean(settings.apiKey),
		keyEncrypted: settings.apiKeyEncoding === "safeStorage",
	};
}

export function setLlmSettings(update: LlmSettingsUpdate): LlmSettingsView {
	const current = readStoredSettings();
	const next: StoredLlmSettings = {
		...current,
		baseUrl: update.baseUrl.trim(),
		model: update.model.trim(),
	};

	if (update.apiKey !== undefined) {
		const key = update.apiKey?.trim() ?? "";
		if (!key) {
			next.apiKey = null;
			next.apiKeyEncoding = null;
		} else if (safeStorage.isEncryptionAvailable()) {
			next.apiKey = safeStorage.encryptString(key).toString("base64");
			next.apiKeyEncoding = "safeStorage";
		} else {
			next.apiKey = Buffer.from(key, "utf-8").toString("base64");
			next.apiKeyEncoding = "plain";
		}
	}

	writeAppSetting(SETTINGS_KEY, next);
	return getLlmSettings();
}

/** `https://api.example.com/v1` → `https://api.example.com/v1/chat/completions`. */
export function getChatCompletionsUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

/** One OpenAI-compatible chat completion using the stored settings. */
export async function runLlmCompletion(
	request: LlmCompletionRequest,
): Promise<LlmCompletionResult> {
	const settings = readStoredSettings();
	if (!settings.baseUrl || !settings.model) {
		throw new Error("Set an API endpoint and model in AI assist settings first.");
	}

	const apiKey = decodeApiKey(settings);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const startedAt = Date.now();

	const send = async (json: boolean) =>
		net.fetch(getChatCompletionsUrl(settings.baseUrl), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: settings.model,
				temperature: 0,
				max_tokens: request.maxTokens ?? 4000,
				messages: [
					{ role: "system", content: request.system },
					{ role: "user", content: request.user },
				],
				...(json ? { response_format: { type: "json_object" } } : {}),
			}),
			signal: controller.signal,
		});

	try {
		let response = await send(Boolean(request.json));
		// Some OpenAI-compatible servers reject response_format; retry without it.
		if (request.json && response.status === 400) {
			response = await send(false);
		}
		const bodyText = await response.text();
		if (!response.ok) {
			throw new Error(
				`The AI provider returned ${response.status}: ${bodyText.slice(0, 300)}`,
			);
		}

		const body = JSON.parse(bodyText) as {
			model?: string;
			choices?: Array<{ message?: { content?: string } }>;
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		const text = body.choices?.[0]?.message?.content;
		if (typeof text !== "string") {
			throw new Error("The AI provider returned no message content.");
		}

		return {
			text,
			model: body.model ?? settings.model,
			usage: body.usage
				? {
						promptTokens: body.usage.prompt_tokens ?? 0,
						completionTokens: body.usage.completion_tokens ?? 0,
					}
				: null,
			elapsedMs: Date.now() - startedAt,
		};
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error("The AI provider did not respond in time.");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}
