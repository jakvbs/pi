import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLogCommand } from "./commands/log.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { registerViewCommand } from "./commands/view.ts";
import { registerActivation } from "./hooks/activation.ts";
import { registerCompactionHook } from "./hooks/compaction-hook.ts";
import { registerConsolidationTrigger } from "./hooks/consolidation-trigger.ts";
import { registerMemoryFile } from "./memory-file.ts";
import { Runtime } from "./runtime.ts";
import { registerRecallTool } from "./tools/recall-observation.ts";

export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	// Activation's turn_end handler runs before the consolidation trigger's, so
	// a synchronous catch-up is not blocked by a background run launched on the
	// same turn.
	registerActivation(pi, runtime);
	registerConsolidationTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);
	registerMemoryFile(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	registerLogCommand(pi, runtime);
	registerRecallTool(pi);
}
