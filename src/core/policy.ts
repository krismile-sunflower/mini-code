export function requiresWorkspaceTool(userRequest: string): boolean {
  const text = userRequest.toLowerCase();
  const hasPathLikeText = /(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt|css|html|yml|yaml|toml|env|sh|py|rs|go|java|c|cpp|h)\b/.test(text);
  const toolIntent = [
    /\b(read|open|inspect|view|show|search|find|grep|cat|look at|check|edit|modify|update|write|create|delete|run|execute|test|build)\b/i,
    /\b(git|status|diff|file|folder|directory|repo|workspace|package\.json|readme)\b/i,
    /(读取|读一下|查看|打开|搜索|查找|修改|更新|写入|创建|删除|运行|执行|测试|构建|文件|目录|仓库|项目|状态|差异)/
  ];
  return hasPathLikeText || toolIntent.some((pattern) => pattern.test(userRequest));
}

export function requiresPlan(userRequest: string): boolean {
  const patterns = [
    /\b(implement|fix|refactor|add|change|modify|update|build|test|redesign|rework|migrate|integrate)\b/i,
    /(实现|修复|重构|新增|增加|修改|更新|构建|测试|重新设计|迁移|接入|完善|优化)/
  ];
  return patterns.some((pattern) => pattern.test(userRequest));
}

export function finalClaimsToolUse(answer: string): boolean {
  return /(I (?:read|inspected|opened|searched|checked|ran|executed|edited|modified|updated)|I've (?:read|inspected|searched|checked|run)|我(?:已|已经)?(?:读取|查看|检查|搜索|运行|执行|修改|更新)了?)/i.test(answer);
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
