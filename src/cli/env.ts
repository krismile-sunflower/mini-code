import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type EnvMap = Record<string, string | undefined>;

export function loadConfigEnv(cwd: string, shellEnv: EnvMap = process.env): EnvMap {
  const fileEnv = readEnvFiles(cwd);
  return { ...fileEnv, ...shellEnv };
}

function readEnvFiles(cwd: string): EnvMap {
  const files = [".env", ".env.local"];
  const values: EnvMap = {};
  for (const file of files) {
    const filePath = path.join(cwd, file);
    if (!existsSync(filePath)) continue;
    Object.assign(values, parseEnvFile(readFileSync(filePath, "utf8")));
  }
  return values;
}

export function parseEnvFile(text: string): EnvMap {
  const result: EnvMap = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const equalsIndex = withoutExport.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = withoutExport.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    result[key] = parseEnvValue(withoutExport.slice(equalsIndex + 1).trim());
  }
  return result;
}

function parseEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }
  const hashIndex = value.search(/\s#/);
  return hashIndex === -1 ? value : value.slice(0, hashIndex).trimEnd();
}
