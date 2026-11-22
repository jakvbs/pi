import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { detectInstallChange, findNodePackageDir } from "../src/config.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("findNodePackageDir", () => {
	test("skips binary metadata copied into dist", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-package-dir-"));
		const distDir = join(tempDir, "dist");
		const bundleDir = join(distDir, "bundle");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), "{}");
		writeFileSync(join(distDir, "package.json"), "{}");

		expect(findNodePackageDir(bundleDir)).toBe(tempDir);
	});
});

describe("detectInstallChange", () => {
	// Regression test for #10439: a deleted pnpm install must not fall back to a package.json further up.
	test("reports a removed install instead of reading a package.json further up", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-install-change-"));
		const installDir = join(tempDir, "global", "hash");
		mkdirSync(installDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ version: "0.0.1" }));
		rmSync(installDir, { recursive: true, force: true });
		expect(detectInstallChange(join(installDir, "package.json"))).toEqual({ kind: "removed" });
	});
});
