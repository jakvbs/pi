import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLocalePlugin,
  getSupportedLocales,
} = await jiti.import("./registry.ts");

test("returns only registered locales", () => {
  assert.deepEqual(getSupportedLocales(), ["en"]);
  assert.equal(getLocalePlugin("en").id, "en");
  assert.equal(getLocalePlugin("zh-CN"), undefined);
  assert.equal(getLocalePlugin("missing"), undefined);
});
