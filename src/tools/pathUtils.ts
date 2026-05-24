import path from "node:path";

export function resolveInside(cwd: string, requestedPath: string): string {
  const cleaned = normalizePatchPath(requestedPath);
  const resolved = path.resolve(cwd, cleaned);
  const root = path.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
  return resolved;
}

export function normalizePatchPath(filePath: string): string {
  let cleaned = filePath.trim();
  if (cleaned === "/dev/null") return cleaned;
  cleaned = cleaned.replace(/^"|"$/g, "");
  cleaned = cleaned.replace(/^[ab]\//, "");
  return cleaned;
}

export function looksSensitivePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const base = path.basename(normalized);
  return (
    normalized.includes("/node_modules/") ||
    normalized.includes("/dist/") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith("dist/") ||
    base === ".env" ||
    base.startsWith(".env.") ||
    base.includes("secret") ||
    base.includes("token") ||
    base.includes("credential") ||
    base.endsWith(".pem") ||
    base.endsWith(".key")
  );
}
