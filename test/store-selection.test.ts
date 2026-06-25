import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseStoreBackend, createHostedStore } from "../src/infrastructure/store-selection.ts";

test("chooseStoreBackend selects sqlite unless TIDB_HOST is set", () => {
  assert.equal(chooseStoreBackend(""), "sqlite");
  assert.equal(chooseStoreBackend("   "), "sqlite");
  assert.equal(chooseStoreBackend("gateway01.tidb.cloud"), "tidb");
});

test("createHostedStore defaults to a working SQLite store and creates the parent dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "captatum-store-sel-"));
  // Parent dir ("nested") does not exist yet — the factory must create it.
  const path = join(dir, "nested", "captatum.sqlite");
  const { store, backend } = await createHostedStore({
    tidb: { host: "", port: 4000, database: "x", user: "x", password: "x", sslCa: "" },
    sqlitePath: path,
  });

  assert.equal(backend, "sqlite");
  // Round-trip an auth code to prove the store is live on the default backend.
  await store.saveAuthCode({
    codeHash: "a".repeat(64),
    clientId: "ctc_x",
    subject: "subj",
    redirectUri: "https://app.example/cb",
    resource: "https://api.example",
    scopes: ["fetch:read"],
    codeChallenge: "c".repeat(64),
    codeChallengeMethod: "S256",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const record = await store.consumeAuthCode("a".repeat(64), "2026-01-01T00:00:00.000Z");
  assert.ok(record, "auth code consumed");
  assert.equal(record?.clientId, "ctc_x");
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("createHostedStore rejects the TiDB backend without TIDB_SSL_CA (SQLSTORE-1)", async () => {
  await assert.rejects(
    createHostedStore({
      tidb: { host: "db.example", port: 4000, database: "x", user: "x", password: "x", sslCa: "" },
      sqlitePath: "./data/should-not-be-used.sqlite",
    }),
    /TIDB_SSL_CA/,
  );
});
