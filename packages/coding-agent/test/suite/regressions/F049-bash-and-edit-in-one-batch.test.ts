import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// F049: one assistant message held `sed -i` on a file and an edit of the same file. They ran in parallel,
// so one tool's write replaced the other's and the file lost content.
describe("a batch with bash and a file-writing tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs in the model's order, so both changes reach the file", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const file = join(harness.tempDir, "file.txt");
		writeFileSync(file, "alpha\nomega\n");

		// The bash call rewrites the whole file after a pause: run in parallel, it overwrites the finished edit.
		const command = "sleep 0.3; printf 'ALPHA\\nomega\\n' > file.txt";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command }),
					fauxToolCall("edit", { path: "file.txt", edits: [{ oldText: "omega", newText: "OMEGA" }] }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		expect(readFileSync(file, "utf-8")).toBe("ALPHA\nOMEGA\n");
	});
});
