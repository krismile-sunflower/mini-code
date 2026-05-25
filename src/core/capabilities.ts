import type { CapabilityDescriptor, ToolRisk } from "./types.js";

export interface TableColumn<T> {
  key: string;
  width: number;
  value(row: T): string;
}

export function renderCapabilityList(capabilities: CapabilityDescriptor[], title = "capabilities"): string {
  if (capabilities.length === 0) return `[no ${title}]`;
  const sorted = [...capabilities].sort((left, right) =>
    `${left.kind}:${left.source}:${left.name}:${left.id}`.localeCompare(`${right.kind}:${right.source}:${right.name}:${right.id}`)
  );
  const sourceCounts = countBy(sorted.map((item) => item.source));
  const riskCounts = countBy<ToolRisk>(sorted.map((item) => item.risk));
  return [
    `${title}: total=${sorted.length} ${renderCounts("source", sourceCounts)} ${renderRiskCounts(riskCounts)}`.trim(),
    renderTable(sorted, [
      { key: "id", width: 34, value: (item) => item.id },
      { key: "name", width: 22, value: (item) => item.name },
      { key: "kind", width: 13, value: (item) => item.kind },
      { key: "source", width: 16, value: (item) => item.source },
      { key: "risk", width: 9, value: (item) => item.risk },
      { key: "description", width: 80, value: (item) => item.description }
    ])
  ].join("\n");
}

export function renderTable<T>(rows: T[], columns: TableColumn<T>[]): string {
  const header = columns.map((column) => pad(column.key, column.width)).join("  ").trimEnd();
  const divider = columns.map((column) => "-".repeat(column.width)).join("  ").trimEnd();
  const body = rows.map((row) => columns.map((column) => pad(column.value(row), column.width)).join("  ").trimEnd());
  return [header, divider, ...body].join("\n");
}

function countBy<T extends string>(values: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function renderCounts(prefix: string, counts: Map<string, number>): string {
  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${prefix}=${key}:${count}`)
    .join(" ");
}

function renderRiskCounts(counts: Map<ToolRisk, number>): string {
  const order: ToolRisk[] = ["read", "write", "shell", "dangerous"];
  return order
    .filter((risk) => counts.has(risk))
    .map((risk) => `${risk}=${counts.get(risk)}`)
    .join(" ");
}

function pad(value: string, width: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const clipped = truncateEnd(normalized, width);
  return clipped.padEnd(width);
}

function truncateEnd(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}
