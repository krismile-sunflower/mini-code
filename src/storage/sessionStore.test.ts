import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./sessionStore.js";

test("SessionStore saves, loads, and lists sessions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-sessions-"));
  try {
    const store = new SessionStore(dir);
    const record = store.createRecord({
      id: "test-session",
      cwd: process.cwd(),
      provider: "openai",
      model: "test-model",
      baseUrl: "http://example.test",
      messages: [{ role: "system", content: "hello" }],
      summary: "summary"
    });
    await store.save(record);
    const loaded = await store.load("test-session");
    assert.equal(loaded?.id, "test-session");
    assert.equal(loaded?.messages[0]?.content, "hello");
    const sessions = await store.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, "test-session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
