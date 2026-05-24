import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    loaded!.title = "Readable title";
    loaded!.lastUserMessage = "last request";
    await store.save(loaded!);
    const sessions = await store.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, "test-session");
    assert.equal(sessions[0]?.title, "Readable title");
    assert.equal(sessions[0]?.lastUserMessage, "last request");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore renames and exports sessions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-sessions-"));
  try {
    const store = new SessionStore(dir);
    const record = store.createRecord({
      id: "exportable",
      cwd: process.cwd(),
      provider: "openai",
      model: "test-model",
      baseUrl: "http://example.test",
      messages: [{ role: "system", content: "hello" }]
    });
    await store.save(record);
    const renamed = await store.rename("exportable", "  Better   title  ");
    assert.equal(renamed.title, "Better title");
    const outputPath = await store.export("exportable", path.join(dir, "exports", "session.json"));
    const exported = JSON.parse(await readFile(outputPath, "utf8")) as { id?: string; title?: string };
    assert.equal(exported.id, "exportable");
    assert.equal(exported.title, "Better title");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
