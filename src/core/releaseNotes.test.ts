import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseNoteHighlights, renderReleaseNotes } from "./releaseNotes.js";

test("release notes render shared highlights and sections", () => {
  const highlights = releaseNoteHighlights(2);
  assert.equal(highlights.length, 2);
  assert.ok(highlights.every((item) => item.length > 0));

  const rendered = renderReleaseNotes();
  assert.match(rendered, /release notes:/);
  assert.match(rendered, /Claude-like command surface/);
  assert.match(rendered, /Agent skills/);
  assert.match(rendered, /Safety and workflow/);
});
