import { ipcMain } from "electron";
import {
	getLlmSettings,
	type LlmCompletionRequest,
	type LlmSettingsUpdate,
	runLlmCompletion,
	setLlmSettings,
} from "../autoCut/llm";
import { detectRecordingSilence } from "../autoCut/silence";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function registerAutoCutHandlers() {
	ipcMain.handle("auto-cut-detect-silence", async (_, videoPath: string) => {
		try {
			return { success: true as const, ...(await detectRecordingSilence(videoPath)) };
		} catch (error) {
			console.error("[auto-cut] Silence detection failed:", error);
			return { success: false as const, error: errorMessage(error) };
		}
	});

	ipcMain.handle("auto-cut-get-llm-settings", () => getLlmSettings());

	ipcMain.handle("auto-cut-set-llm-settings", (_, update: LlmSettingsUpdate) =>
		setLlmSettings(update),
	);

	ipcMain.handle("auto-cut-llm-complete", async (_, request: LlmCompletionRequest) => {
		try {
			return { success: true as const, ...(await runLlmCompletion(request)) };
		} catch (error) {
			console.error("[auto-cut] LLM request failed:", errorMessage(error));
			return { success: false as const, error: errorMessage(error) };
		}
	});
}
