import { createContext, useContext } from "react";
import type { SourceRange } from "./types";

/** Timeline-time ranges auto-cut would remove, shown striped on the clip row. */
export const ProposedCutsContext = createContext<SourceRange[]>([]);

export function useProposedCuts() {
	return useContext(ProposedCutsContext);
}
