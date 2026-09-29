import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: { fetch: vi.fn() }, safeStorage: {} }));
vi.mock("../../appSettingsStore", () => ({ readAppSetting: vi.fn(), writeAppSetting: vi.fn() }));

const { getChatCompletionsUrl } = await import("./llm");

describe("getChatCompletionsUrl", () => {
	it.each([
		["https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"],
		["https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1/chat/completions"],
		[
			"http://localhost:11434/v1/chat/completions",
			"http://localhost:11434/v1/chat/completions",
		],
	])("%s", (input, expected) => {
		expect(getChatCompletionsUrl(input)).toBe(expected);
	});
});
