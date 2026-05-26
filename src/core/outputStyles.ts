import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface OutputStyleInfo {
  id: string;
  name: string;
  description: string;
  content: string;
  path?: string;
  source: "builtin" | "project" | "global";
  active: boolean;
}

const builtins: Array<Omit<OutputStyleInfo, "active">> = [
  {
    id: "builtin:default",
    name: "default",
    description: "Balanced, direct engineering responses.",
    source: "builtin",
    content: "Use a direct, pragmatic engineering style. Keep final answers concise, mention verification, and surface blockers plainly."
  },
  {
    id: "builtin:concise",
    name: "concise",
    description: "Short answers with only the highest-signal details.",
    source: "builtin",
    content: "Use very concise responses. Prefer one short paragraph plus verification. Avoid extended rationale unless the user asks."
  },
  {
    id: "builtin:explanatory",
    name: "explanatory",
    description: "More context and reasoning for implementation choices.",
    source: "builtin",
    content: "Explain decisions, tradeoffs, and verification clearly. Keep the answer structured, but do not bury the concrete result."
  },
  {
    id: "builtin:review",
    name: "review",
    description: "Code-review first: findings, risks, and tests.",
    source: "builtin",
    content: "When reviewing or summarizing code, lead with findings ordered by severity, then assumptions and test gaps. Keep summaries secondary."
  }
];

export async function discoverOutputStyles(cwd: string, activeName = "default", includeGlobal = true): Promise<OutputStyleInfo[]> {
  const active = normalizeName(activeName);
  const custom = [
    ...(await readStyleDir(path.join(cwd, ".mini-code", "output-styles"), "project")),
    ...(await readStyleDir(path.join(cwd, ".claude", "output-styles"), "project")),
    ...(includeGlobal ? await readStyleDir(path.join(homedir(), ".mini-code", "output-styles"), "global") : []),
    ...(includeGlobal ? await readStyleDir(path.join(homedir(), ".claude", "output-styles"), "global") : [])
  ];
  const all = [
    ...custom,
    ...builtins
  ];
  const seen = new Set<string>();
  return all
    .filter((style) => {
      const key = style.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((style) => ({ ...style, active: style.name === active || style.id === active }));
}

export async function resolveOutputStyle(cwd: string, name: string, includeGlobal = true): Promise<OutputStyleInfo> {
  const styles = await discoverOutputStyles(cwd, name, includeGlobal);
  const normalized = normalizeName(name);
  return styles.find((style) => style.name === normalized || style.id === normalized)
    ?? styles.find((style) => style.name === "default")
    ?? { ...builtins[0], active: true };
}

export async function createProjectOutputStyle(cwd: string, rawName: string, instructions: string): Promise<OutputStyleInfo> {
  const name = normalizeName(rawName);
  if (!name) throw new Error("Output style name cannot be empty.");
  const trimmed = instructions.trim();
  if (!trimmed) throw new Error("Output style instructions cannot be empty.");
  const dir = path.join(cwd, ".mini-code", "output-styles");
  const filePath = path.join(dir, `${name}.md`);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, `---\ndescription: Custom output style\n---\n\n${trimmed}\n`, { encoding: "utf8", flag: "wx" });
  return {
    id: `project:${name}`,
    name,
    description: "Custom output style",
    content: trimmed,
    path: filePath,
    source: "project",
    active: false
  };
}

export function outputStylePrompt(style: OutputStyleInfo): string {
  return [
    "## Output Style",
    "",
    `Active style: ${style.name}`,
    style.content.trim()
  ].join("\n");
}

export function renderOutputStyleList(styles: OutputStyleInfo[]): string {
  const rows = styles.map((style) => [
    style.active ? "*" : " ",
    style.name.padEnd(18),
    style.source.padEnd(8),
    style.description.padEnd(42),
    style.path ?? style.id
  ].join("  "));
  return ["output styles:", "  name                source    description                                path", ...rows].join("\n");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function readStyleDir(dir: string, source: "project" | "global"): Promise<Array<Omit<OutputStyleInfo, "active">>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const styles: Array<Omit<OutputStyleInfo, "active">> = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await readFile(filePath, "utf8");
      const { description, content } = parseStyleFile(raw);
      const name = normalizeName(path.basename(entry, ".md"));
      if (!name || !content.trim()) continue;
      styles.push({
        id: `${source}:${name}`,
        name,
        description: description || firstLine(content) || "Custom output style",
        content,
        path: filePath,
        source
      });
    } catch {
      // Ignore unreadable style files.
    }
  }
  return styles;
}

function parseStyleFile(raw: string): { description: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { description: "", content: raw.trim() };
  const description = match[1].split(/\r?\n/)
    .map((line) => /^description:\s*(.+)\s*$/i.exec(line)?.[1]?.trim() ?? "")
    .find(Boolean) ?? "";
  return { description, content: match[2].trim() };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
