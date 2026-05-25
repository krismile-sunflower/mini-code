#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { buildConfig, collectConfigWarnings, readArgs } from "./cli/config.js";
import { runPiCli } from "./cli/piWrapper.js";
import { runPlainCli } from "./cli/plainCli.js";
import { SessionStore } from "./storage/sessionStore.js";
import { discoverSkills } from "./core/skills.js";
import { App } from "./ui/App.js";

async function main(): Promise<void> {
  const args = readArgs();

  if (args.piPassThrough) {
    process.exitCode = await runPiCli(args.piArgs);
    return;
  }

  const config = buildConfig(args);

  if (args.listSessions) {
    const sessions = await new SessionStore(config.sessionDir).list();
    for (const session of sessions) {
      console.log(`${session.id}\t${session.updatedAt}\t${session.model}\t${session.title}\t${session.summary.slice(0, 80)}`);
    }
    return;
  }

  if (!config.apiKey) {
    const keyName = config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    throw new Error(`Set ${keyName} first. For OpenAI-compatible local servers, any placeholder OPENAI_API_KEY is fine.`);
  }

  if (config.plain) {
    await runPlainCli(config, args);
    return;
  }

  const warnings = collectConfigWarnings(config.cwd);
  const skills = await discoverSkills(config.cwd, config.skills, config.enableSkills);
  render(React.createElement(App, { config, warnings, skills }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
