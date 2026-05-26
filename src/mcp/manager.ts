import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { McpConfig, McpPromptInfo, McpResourceInfo, McpServerConfig, McpToolInfo } from "./types.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class McpServerConnection {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly cwd: string
  ) {}

  async connect(): Promise<void> {
    if (this.process && !this.process.killed) return;
    this.process = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.cwd,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: "pipe",
      windowsHide: true
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.on("exit", () => {
      for (const pending of this.pending.values()) pending.reject(new Error(`MCP server exited: ${this.name}`));
      this.pending.clear();
    });
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mini-code", version: "0.1.0" } }).catch(() => undefined);
    await this.notify("notifications/initialized", {});
  }

  status(): { name: string; status: "connected" | "stopped"; command: string; args: string[]; risk: string } {
    return {
      name: this.name,
      status: this.process && !this.process.killed ? "connected" : "stopped",
      command: this.config.command,
      args: this.config.args ?? [],
      risk: this.config.risk ?? "shell"
    };
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.connect();
    const result = await this.request("tools/list", {});
    const tools = isObject(result) && Array.isArray(result.tools) ? result.tools : [];
    return tools.filter(isObject).map((tool) => ({
      server: this.name,
      name: String(tool.name ?? ""),
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : undefined,
      risk: this.config.risk ?? "shell"
    })).filter((tool) => tool.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return this.request("tools/call", { name, arguments: args });
  }

  async listResources(): Promise<McpResourceInfo[]> {
    await this.connect();
    const result = await this.request("resources/list", {});
    const resources = isObject(result) && Array.isArray(result.resources) ? result.resources : [];
    return resources.filter(isObject).map((resource) => ({
      server: this.name,
      uri: String(resource.uri ?? ""),
      name: typeof resource.name === "string" ? resource.name : undefined,
      description: typeof resource.description === "string" ? resource.description : undefined
    })).filter((resource) => resource.uri);
  }

  async readResource(uri: string): Promise<unknown> {
    await this.connect();
    return this.request("resources/read", { uri });
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    await this.connect();
    const result = await this.request("prompts/list", {});
    const prompts = isObject(result) && Array.isArray(result.prompts) ? result.prompts : [];
    return prompts.filter(isObject).map((prompt) => ({
      server: this.name,
      name: String(prompt.name ?? ""),
      description: typeof prompt.description === "string" ? prompt.description : undefined
    })).filter((prompt) => prompt.name);
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return this.request("prompts/get", { name, arguments: args });
  }

  reconnect(): void {
    this.process?.kill();
    this.process = undefined;
  }

  async shutdown(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    child.stdin.end();
    if (child.exitCode !== null || child.killed) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill();
    await Promise.race([closed, delay(1_000)]);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process?.stdin.write(`${payload}\n`);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${this.name} ${method}`));
      }, 10_000).unref();
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    this.process?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof message.id !== "number") continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "MCP request failed"));
        else pending.resolve(message.result);
      } catch {
        // Ignore non-JSON stdout lines from third-party servers.
      }
    }
  }
}

export class McpManager extends EventEmitter {
  private readonly servers = new Map<string, McpServerConnection>();

  constructor(config: McpConfig, private readonly cwd: string) {
    super();
    for (const [name, server] of Object.entries(config.mcpServers)) {
      this.servers.set(name, new McpServerConnection(name, server, cwd));
    }
  }

  names(): string[] {
    return Array.from(this.servers.keys()).sort();
  }

  serverStatuses(): Array<{ name: string; status: "connected" | "stopped"; command: string; args: string[]; risk: string }> {
    return Array.from(this.servers.values()).map((server) => server.status()).sort((left, right) => left.name.localeCompare(right.name));
  }

  async listTools(): Promise<McpToolInfo[]> {
    const all: McpToolInfo[] = [];
    for (const server of this.servers.values()) {
      try {
        all.push(...(await server.listTools()));
      } catch {
        // Unavailable MCP servers should not prevent the session from starting.
      }
    }
    return all;
  }

  async callTool(server: string, tool: string, input: Record<string, unknown>): Promise<unknown> {
    const connection = this.required(server);
    return connection.callTool(tool, input);
  }

  async listResources(): Promise<McpResourceInfo[]> {
    const all: McpResourceInfo[] = [];
    for (const server of this.servers.values()) {
      try {
        all.push(...(await server.listResources()));
      } catch {
        // best effort
      }
    }
    return all;
  }

  async readResource(server: string, uri: string): Promise<unknown> {
    return this.required(server).readResource(uri);
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    const all: McpPromptInfo[] = [];
    for (const server of this.servers.values()) {
      try {
        all.push(...(await server.listPrompts()));
      } catch {
        // best effort
      }
    }
    return all;
  }

  async getPrompt(server: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.required(server).getPrompt(name, args);
  }

  reconnect(server: string): void {
    this.required(server).reconnect();
  }

  async shutdown(): Promise<void> {
    await Promise.all(Array.from(this.servers.values()).map((server) => server.shutdown()));
  }

  private required(server: string): McpServerConnection {
    const connection = this.servers.get(server);
    if (!connection) throw new Error(`MCP server not found: ${server}`);
    return connection;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
