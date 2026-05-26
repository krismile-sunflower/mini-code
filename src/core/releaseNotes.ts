export interface ReleaseNote {
  title: string;
  items: string[];
}

export const releaseNotes: ReleaseNote[] = [
  {
    title: "Claude-like command surface",
    items: [
      "Added project and user custom slash commands from .mini-code/commands and .claude/commands.",
      "Added hooks from Mini Code and Claude-style settings files.",
      "Added persistent project config commands and estimated session cost reporting."
    ]
  },
  {
    title: "Agent skills",
    items: [
      "Added project, shared, Claude-style, global, and configured skill discovery.",
      "Added /skill create, /skill reload, /skill inspect, and model-callable create_skill.",
      "Duplicate skill names are visible instead of hidden.",
      "Added project and user subagent discovery with /agent create, model-callable create_subagent, and SubagentStop hooks."
    ]
  },
  {
    title: "Safety and workflow",
    items: [
      "Added settings-based permission allow/deny rules with deny precedence.",
      "Added plan creation, plan execution, context compaction hooks, and notification hooks.",
      "Improved session capability diffs, diagnostics, and provider-native tool normalization."
    ]
  }
];

export function releaseNoteHighlights(limit = 4): string[] {
  return releaseNotes.flatMap((section) => section.items).slice(0, limit);
}

export function renderReleaseNotes(): string {
  return [
    "release notes:",
    ...releaseNotes.flatMap((section) => [
      "",
      `## ${section.title}`,
      ...section.items.map((item) => `- ${item}`)
    ])
  ].join("\n");
}
