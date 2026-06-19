import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBody } from "../src/infrastructure/http/body.ts";

function streamOf(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });
}

test("decodeBody honors a declared non-UTF-8 charset (elmundo iso-8859-15 regression)", async () => {
  // "apagón" with ó encoded as 0xF3 (iso-8859-15), not the UTF-8 C3 B3.
  const text = await decodeBody(streamOf([0x61, 0x70, 0x61, 0x67, 0xf3, 0x6e]), "text/html; charset=iso-8859-15");
  assert.equal(text, "apagón");
});

test("decodeBody defaults to UTF-8 when no charset is declared", async () => {
  const text = await decodeBody(streamOf([0xc3, 0xb3]), "text/html");
  assert.equal(text, "ó");
});

test("decodeBody falls back to UTF-8 on an unsupported charset label", async () => {
  const text = await decodeBody(streamOf([0xc3, 0xb3]), "text/html; charset=not-a-real-encoding");
  assert.equal(text, "ó");
});
