import { configureHttpDispatcher, readHttpIdleTimeoutMs } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { applyCodemodeWorkerDefault } from "@/lib/codemode-workers";

const SDK = "@earendil-works/pi-coding-agent";

export function registerNodeInstrumentation(): void {
  // Before any session can run a codemode script (lib/codemode-workers.ts).
  applyCodemodeWorkerDefault();

  // The pi CLI applies settings' `httpIdleTimeoutMs` to the same undici
  // body/header timeouts, so a Web UI session gets the timeout the user
  // configured. Without it the built-in five minutes aborts a provider stream
  // that stays quiet for longer, which a CLI session tolerates.
  configureHttpDispatcher(readHttpIdleTimeoutMs());

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);

  // Next evaluates a route's code on its first request, so the first
  // /api/sessions used to pay for importing the whole pi SDK, seconds on
  // Windows (#964). Start that import now, unawaited so register() stays fast:
  // the launcher opens the browser only once the first page is served, after
  // it (bin/browser-opener.js), and the routes reuse Node's cached module.
  // A failure is left for the routes' own import to report.
  import("@earendil-works/pi-coding-agent").catch(() => {});
  // Which copy of the SDK Node resolves: the package, or the fork's source under `npm run dev:fork`.
  logSdkEntry().catch(() => {});
}

// Turbopack rewrites `import.meta.resolve` in bundled code, so ask Node from an
// unbundled module. A data: URL resolves a bare specifier only through a
// resolve hook such as the fork's source resolver.
async function logSdkEntry(): Promise<void> {
  const probe = `data:text/javascript,export default import.meta.resolve(${JSON.stringify(SDK)})`;
  try {
    const resolved = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ probe) as { default: string };
    console.log(`[pi-web] pi-coding-agent: ${resolved.default}`);
  } catch {
    const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
    console.log(`[pi-web] pi-coding-agent: ${getPackageDir()} (no resolve hook)`);
  }
}
