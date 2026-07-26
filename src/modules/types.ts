import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Context } from 'grammy';
import type { TurnResult } from '../queue.js';

export type McpStdioConfig = {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type TurnJobLike = { browser?: boolean; jid: string; kind: string };

export interface SystemScheduleSpec {
  name: string;
  cron: string;
  prompt: string;
  catch_up?: boolean;
  onFire?: (ctx: { id: number; catchUp: boolean }) => void | Promise<void>;
  buildPrompt?: () => { prompt: string; after?: (res: TurnResult) => void };
  capMs?: number;
}

export type CommandHandler = (ctx: Context) => void | Promise<void>;
export type CallbackHandler = (ctx: Context) => void | Promise<void>;

export interface Module {
  id: string;
  register(host: ModuleHost): void | Promise<void>;
}

export interface ModuleHost {
  addMcp(
    name: string,
    server: McpStdioConfig | (() => McpStdioConfig),
    opts?: { when?: (job: TurnJobLike) => boolean },
  ): void;
  addTools(tools: SdkMcpToolDefinition[]): void;
  addCommand(name: string, description: string, handler: CommandHandler): void;
  addCallback(prefix: string, handler: CallbackHandler): void;
  onStart(fn: () => void | Promise<void>): void;
  onStop(fn: () => void | Promise<void>): void;
  statusLine(fn: () => string | null): void;
  seedSchedule(spec: SystemScheduleSpec): void;
}

export type HostMcpEntry = {
  name: string;
  server: McpStdioConfig | (() => McpStdioConfig);
  when?: (job: TurnJobLike) => boolean;
};

export type HostCommandEntry = {
  name: string;
  description: string;
  handler: CommandHandler;
};

export type HostCallbackEntry = {
  prefix: string;
  handler: CallbackHandler;
};

export type HostSnapshot = {
  mcps: HostMcpEntry[];
  tools: SdkMcpToolDefinition[];
  commands: HostCommandEntry[];
  callbacks: HostCallbackEntry[];
  startHooks: Array<() => void | Promise<void>>;
  stopHooks: Array<() => void | Promise<void>>;
  statusLines: Array<() => string | null>;
  schedules: SystemScheduleSpec[];
};
