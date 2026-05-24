import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type EnvMap = Record<string, string | undefined>;
export type EnvSource = "env" | ".env.local" | ".env";

export interface LoadedEnv {
  values: EnvMap;
  sources: Record<string, EnvSource | undefined>;
}

export function loadConfigEnv(cwd: string, shellEnv: EnvMap = process.env): EnvMap {
  return loadConfigEnvDetailed(cwd, shellEnv).values;
}

export function loadConfigEnvDetailed(cwd: string, shellEnv: EnvMap = process.env): LoadedEnv {
  const values: EnvMap = {};
  const sources: Record<string, EnvSource | undefined> = {};
  for (const file of [".env", ".env.local"] as const) {
    const parsed = readEnvFile(cwd, file);
    Object.assign(values, parsed);
    for (const key of Object.keys(parsed)) sources[key] = file;
  }
  for (const [key, value] of Object.entries(shellEnv)) {
    if (value === undefined) continue;
    values[key] = value;
    sources[key] = "env";
  }
  return { values, sources };
}

function readEnvFile(cwd: string, file: ".env" | ".env.local"): EnvMap {
  const values: EnvMap = {};
  const filePath = path.join(cwd, file);
  if (!existsSync(filePath)) return values;
  Object.assign(values, parseEnvFile(readFileSync(filePath, "utf8")));
  return values;
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
