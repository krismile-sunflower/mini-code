export function requiresWorkspaceTool(userRequest: string): boolean {
  const text = userRequest.toLowerCase();
  const hasPathLikeText = /(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt|css|html|yml|yaml|toml|env|sh|py|rs|go|java|c|cpp|h)\b/.test(text);
  const toolIntent = [
    /\b(read|open|inspect|view|show|search|find|grep|cat|look at|check|edit|modify|update|write|create|delete|run|execute|test|build)\b/i,
    /\b(git|status|diff|file|folder|directory|repo|workspace|package\.json|readme)\b/i,
    /(?:\u8bfb\u53d6|\u67e5\u770b|\u6253\u5f00|\u641c\u7d22|\u67e5\u627e|\u68c0\u67e5|\u4fee\u6539|\u66f4\u65b0|\u5199\u5165|\u521b\u5efa|\u65b0\u5efa|\u5220\u9664|\u8fd0\u884c|\u6267\u884c|\u6d4b\u8bd5|\u6784\u5efa|\u6587\u4ef6|\u76ee\u5f55|\u4ed3\u5e93|\u9879\u76ee|\u72b6\u6001|\u5dee\u5f02|\u6280\u80fd)/
  ];
  return hasPathLikeText || toolIntent.some((pattern) => pattern.test(userRequest));
}

export function requiresPlan(userRequest: string): boolean {
  const patterns = [
    /\b(implement|fix|refactor|add|change|modify|update|build|test|redesign|rework|migrate|integrate)\b/i,
    /(?:\u5b9e\u73b0|\u4fee\u590d|\u91cd\u6784|\u65b0\u589e|\u589e\u52a0|\u4fee\u6539|\u66f4\u65b0|\u6784\u5efa|\u6d4b\u8bd5|\u91cd\u65b0\u8bbe\u8ba1|\u8fc1\u79fb|\u63a5\u5165|\u5b8c\u5584|\u4f18\u5316|\u521b\u5efa\u6280\u80fd|\u65b0\u5efa\u6280\u80fd)/
  ];
  return patterns.some((pattern) => pattern.test(userRequest));
}

export function finalClaimsToolUse(answer: string): boolean {
  return /(I (?:read|inspected|opened|searched|checked|ran|executed|edited|modified|updated|created)|I've (?:read|inspected|searched|checked|run|created)|(?:\u6211)?(?:\u5df2\u7ecf)?(?:\u8bfb\u53d6|\u67e5\u770b|\u68c0\u67e5|\u641c\u7d22|\u8fd0\u884c|\u6267\u884c|\u4fee\u6539|\u66f4\u65b0|\u521b\u5efa)(?:\u4e86)?)/i.test(answer);
}

export function fallbackReadFilePath(userRequest: string): string | undefined {
  const text = userRequest.trim();
  const explicit = /(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|json|md|txt|css|html|yml|yaml|toml|env|sh|py|rs|go|java|c|cpp|h))\b/i.exec(text);
  if (explicit?.[1]) return normalizeMentionedPath(explicit[1]);
  if (/readme/i.test(text)) return "README.md";
  return undefined;
}

function normalizeMentionedPath(value: string): string {
  const cleaned = value.replace(/^\.\//, "");
  if (/^readme\.md$/i.test(cleaned)) return "README.md";
  return cleaned;
}
