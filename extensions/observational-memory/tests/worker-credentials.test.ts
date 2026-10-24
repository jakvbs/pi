import { expect, it } from "vitest";

import { extensionSources } from "./fixtures/source-files.ts";

// Credentials read ahead of a request go stale (rotation, OAuth refresh) and bypass the auth and
// routing Pi applies per request. Workers send through ModelRegistry.streamSimple instead.
const READS_CREDENTIALS = /\bgetApiKey(?:AndHeaders)?\s*\(/;
const STREAMS_AROUND_PI = /import\s*\{[^}]*\b(?:stream|streamSimple|complete|completeSimple)\b[^}]*\}\s*from\s*"@earendil-works\/pi-ai(?:\/compat)?"/;

it("leaves request authentication and provider dispatch to Pi", () => {
	const offenders = extensionSources()
		.filter(({ text }) => READS_CREDENTIALS.test(text) || STREAMS_AROUND_PI.test(text))
		.map(({ path }) => path);

	expect(offenders, "send worker requests through runWorkerConversation (src/agents/worker-stream.ts)").toEqual([]);
});
