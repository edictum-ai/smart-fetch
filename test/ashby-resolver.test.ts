import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAshbyJid } from "../src/infrastructure/ashby/embed-resolver.ts";

test("extractAshbyJid reads the ashby_jid param", () => {
  assert.equal(
    extractAshbyJid("https://e2b.dev/careers?ashby_jid=ab44a84f-4467-438a-a26c-2420237c54e2"),
    "ab44a84f-4467-438a-a26c-2420237c54e2",
  );
});

test("extractAshbyJid returns null when the param is absent", () => {
  assert.equal(extractAshbyJid("https://e2b.dev/careers"), null);
  assert.equal(extractAshbyJid("not-a-url"), null);
});
