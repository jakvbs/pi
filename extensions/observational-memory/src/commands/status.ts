import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { memoryStatus, renderMemoryStatus } from "../memory-status.ts";
import type { Runtime } from "../runtime.ts";

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			ctx.ui.notify(renderMemoryStatus(memoryStatus(runtime, ctx)), "info");
		},
	});
}
