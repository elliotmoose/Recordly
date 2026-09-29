import { useTimelineContext } from "dnd-timeline";
import { memo } from "react";
import { useProposedCuts } from "../../../autoCut/ProposedCutsContext";

/** Red hatching over the parts of the clip row that auto-cut would remove. */
function ProposedCutOverlayComponent() {
	const cuts = useProposedCuts();
	const { direction, range, valueToPixels } = useTimelineContext();
	const sideProperty = direction === "rtl" ? "right" : "left";

	if (cuts.length === 0) {
		return null;
	}

	return (
		<div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
			{cuts
				.filter((cut) => cut.endMs > range.start && cut.startMs < range.end)
				.map((cut) => (
					<div
						key={`${cut.startMs}-${cut.endMs}`}
						data-testid="proposed-cut"
						className="absolute rounded-sm"
						style={{
							top: "8%",
							bottom: "8%",
							[sideProperty]: `${valueToPixels(cut.startMs - range.start)}px`,
							width: `${Math.max(2, valueToPixels(cut.endMs - cut.startMs))}px`,
							background:
								"repeating-linear-gradient(135deg, rgba(239,68,68,0.55) 0 4px, rgba(239,68,68,0.18) 4px 8px)",
							boxShadow: "inset 0 0 0 1px rgba(239,68,68,0.8)",
						}}
					/>
				))}
		</div>
	);
}

export default memo(ProposedCutOverlayComponent);
