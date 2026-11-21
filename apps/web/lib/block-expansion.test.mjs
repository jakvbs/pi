import assert from "node:assert/strict";
import test from "node:test";

import {
  clearBlockExpansions,
  getBlockExpansion,
  setBlockExpansion,
} from "./block-expansion.ts";

test("remembers a block's toggle across remounts by its key, open or closed", () => {
  clearBlockExpansions();
  assert.equal(getBlockExpansion("call_1"), undefined);

  setBlockExpansion("call_1", true);
  assert.equal(getBlockExpansion("call_1"), true);
  assert.equal(getBlockExpansion("call_2"), undefined);

  // A collapse is a choice too: it must outlast a policy that expands the block's type.
  setBlockExpansion("call_1", false);
  assert.equal(getBlockExpansion("call_1"), false);
});

test("ignores blocks without a key", () => {
  clearBlockExpansions();
  setBlockExpansion(undefined, true);
  setBlockExpansion("", true);
  assert.equal(getBlockExpansion(undefined), undefined);
  assert.equal(getBlockExpansion(""), undefined);
});
