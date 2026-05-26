import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("SessionStore imports exported session JSON", async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-sessions-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-sessions-"));
  try {
    const source = new SessionStore(sourceDir);
    const target = new SessionStore(targetDir);
    const record = source.createRecord({
      id: "portable",
      cwd: process.cwd(),
      provider: "openai",
      model: "test-model",
      baseUrl: "http://example.test",
      messages: [{ role: "user", content: "bring this with me" }],
      summary: "portable summary"
    });
    record.updatedAt = "2026-01-01T00:00:00.000Z";
    await source.save(record);
    const outputPath = await source.export("portable", path.join(sourceDir, "exports", "portable.json"));

    const imported = await target.import(outputPath);

    assert.equal(imported.id, "portable");
    assert.equal(imported.messages[0]?.content, "bring this with me");
    assert.equal(imported.summary, "portable summary");
    assert.equal((await target.load("portable"))?.id, "portable");
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("SessionStore rejects duplicate imported session ids", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-sessions-"));
  try {
    const store = new SessionStore(dir);
    const record = store.createRecord({
      id: "duplicate",
      cwd: process.cwd(),
      provider: "openai",
      model: "test-model",
      baseUrl: "http://example.test",
      messages: [{ role: "system", content: "hello" }]
    });
    await store.save(record);
    const outputPath = path.join(dir, "duplicate-import.json");
    await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    await assert.rejects(() => store.import(outputPath), /Session already exists: duplicate/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore rejects invalid session imports", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-sessions-"));
  try {
    const store = new SessionStore(dir);
    const outputPath = path.join(dir, "invalid.json");
    await writeFile(outputPath, JSON.stringify({ id: "invalid", messages: [] }), "utf8");

    await assert.rejects(() => store.import(outputPath), /Invalid session file: missing createdAt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore returns the latest updated session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-sessions-"));
  try {
    const store = new SessionStore(dir);
    const older = store.createRecord({
      id: "older",
      cwd: process.cwd(),
      provider: "openai",
      model: "test-model",
      baseUrl: "http://example.test",
      messages: [{ role: "system", content: "old" }]
    });
    const newer = store.createRecord({
      id: "newer",
      cwd: process.cwd(),
      provider: "openai",
      model: "test-model",
      baseUrl: "http://example.test",
      messages: [{ role: "system", content: "new" }]
    });
    older.updatedAt = "2026-01-01T00:00:00.000Z";
    newer.updatedAt = "2026-01-02T00:00:00.000Z";
    await store.ensure();
    await writeFile(path.join(dir, "older.json"), `${JSON.stringify(older)}\n`, "utf8");
    await writeFile(path.join(dir, "newer.json"), `${JSON.stringify(newer)}\n`, "utf8");

    assert.equal((await store.latest())?.id, "newer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore deletes sessions by id only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-sessions-"));
  try {
    const store = new SessionStore(dir);
    const record = store.createRecord({
      id: "delete-me",
      cwd: process.cwd(),
      provider: "openai",
      model: "test-model",
      baseUrl: "http://example.test",
      messages: [{ role: "system", content: "delete" }]
    });
    await store.save(record);

    assert.equal(await store.delete("missing"), false);
    assert.equal(await store.delete("delete-me"), true);
    assert.equal(await store.load("delete-me"), undefined);
    await assert.rejects(() => store.delete(path.join(dir, "delete-me.json")), /expects a session id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore forks sessions by id or json path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mini-agent-sessions-"));
  try {
    const store = new SessionStore(dir);
    const record = store.createRecord({
      id: "source",
      cwd: process.cwd(),
      provider: "openai",
      model: "test-model",
      baseUrl: "http://example.test",
      messages: [{ role: "system", content: "hello" }],
      summary: "summary"
    });
    record.title = "Original";
    record.lastUserMessage = "last";
    await store.save(record);

    const forked = await store.fork("source");
    assert.notEqual(forked.id, "source");
    assert.equal(forked.title, "Fork of Original");
    assert.equal(forked.messages[0]?.content, "hello");
    assert.equal((await store.load("source"))?.title, "Original");
    assert.equal((await store.load(forked.id))?.id, forked.id);

    const pathFork = await store.fork(path.join(dir, "source.json"));
    assert.notEqual(pathFork.id, "source");
    assert.notEqual(pathFork.id, forked.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
