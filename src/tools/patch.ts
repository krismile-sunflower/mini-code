import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizePatchPath, resolveInside } from "./pathUtils.js";

interface HunkLine {
  type: "context" | "add" | "remove";
  text: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

export interface PatchSummary {
  touchedPaths: string[];
  deletesFiles: boolean;
}

export function inspectPatch(patch: string): PatchSummary {
  const files = parseUnifiedDiff(patch);
  return {
    touchedPaths: files.map((file) => normalizePatchPath(file.newPath === "/dev/null" ? file.oldPath : file.newPath)),
    deletesFiles: files.some((file) => file.newPath === "/dev/null")
  };
}

export async function applyUnifiedPatch(cwd: string, patch: string): Promise<string> {
  const files = parseUnifiedDiff(patch);
  if (files.length === 0) throw new Error("Patch did not contain any file changes.");

  const planned = new Map<string, string | null>();
  const messages: string[] = [];

  for (const filePatch of files) {
    const targetPath = normalizePatchPath(filePatch.newPath === "/dev/null" ? filePatch.oldPath : filePatch.newPath);
    if (targetPath === "/dev/null") throw new Error("Invalid patch target: /dev/null");
    const resolved = resolveInside(cwd, targetPath);
    const exists = await fileExists(resolved);
    const original = exists ? await fs.readFile(resolved, "utf8") : "";
    const next = applyFilePatch(original, filePatch, targetPath, exists);
    planned.set(resolved, next);
    messages.push(`${next === null ? "Deleted" : exists ? "Updated" : "Created"} ${targetPath}`);
  }

  for (const [filePath, content] of planned) {
    if (content === null) {
      await fs.rm(filePath);
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    }
  }

  return messages.join("\n");
}

function parseUnifiedDiff(patch: string): FilePatch[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: FilePatch[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith("--- ")) {
      index += 1;
      continue;
    }
    const oldPath = normalizePatchPath(lines[index].slice(4).split("\t")[0]);
    index += 1;
    if (index >= lines.length || !lines[index].startsWith("+++ ")) {
      throw new Error(`Expected +++ after --- ${oldPath}`);
    }
    const newPath = normalizePatchPath(lines[index].slice(4).split("\t")[0]);
    index += 1;
    const filePatch: FilePatch = { oldPath, newPath, hunks: [] };

    while (index < lines.length && !lines[index].startsWith("--- ")) {
      if (!lines[index].startsWith("@@ ")) {
        index += 1;
        continue;
      }
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]);
      if (!header) throw new Error(`Invalid hunk header: ${lines[index]}`);
      const hunk: Hunk = {
        oldStart: Number(header[1]),
        oldCount: Number(header[2] ?? "1"),
        newStart: Number(header[3]),
        newCount: Number(header[4] ?? "1"),
        lines: []
      };
      index += 1;

      while (index < lines.length && !lines[index].startsWith("@@ ") && !lines[index].startsWith("--- ")) {
        const line = lines[index];
        if (line.startsWith("\\ No newline at end of file")) {
          index += 1;
          continue;
        }
        const marker = line[0];
        if (marker === " ") hunk.lines.push({ type: "context", text: line.slice(1) });
        else if (marker === "+") hunk.lines.push({ type: "add", text: line.slice(1) });
        else if (marker === "-") hunk.lines.push({ type: "remove", text: line.slice(1) });
        else if (line === "" && index === lines.length - 1) break;
        else throw new Error(`Invalid hunk line: ${line}`);
        index += 1;
      }
      filePatch.hunks.push(hunk);
    }
    files.push(filePatch);
  }

  return files;
}

function applyFilePatch(original: string, filePatch: FilePatch, displayPath: string, exists: boolean): string | null {
  if (filePatch.newPath === "/dev/null") {
    if (!exists) throw new Error(`Cannot delete missing file: ${displayPath}`);
  } else if (filePatch.oldPath === "/dev/null" && exists) {
    throw new Error(`Cannot create existing file: ${displayPath}`);
  }

  const hadFinalNewline = original.endsWith("\n");
  const oldLines = original.length === 0 ? [] : original.replace(/\n$/, "").split("\n");
  const newLines: string[] = [];
  let oldIndex = 0;

  for (const hunk of filePatch.hunks) {
    const expectedIndex = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (expectedIndex < oldIndex) throw new Error(`Overlapping hunk in ${displayPath}`);
    newLines.push(...oldLines.slice(oldIndex, expectedIndex));
    oldIndex = expectedIndex;

    for (const line of hunk.lines) {
      if (line.type === "context" || line.type === "remove") {
        if (oldLines[oldIndex] !== line.text) {
          throw new Error(`Patch context mismatch in ${displayPath} near old line ${oldIndex + 1}`);
        }
        if (line.type === "context") newLines.push(oldLines[oldIndex]);
        oldIndex += 1;
      } else {
        newLines.push(line.text);
      }
    }
  }

  newLines.push(...oldLines.slice(oldIndex));
  if (filePatch.newPath === "/dev/null") return null;
  const next = newLines.join("\n");
  return hadFinalNewline || next.length > 0 ? `${next}\n` : next;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
