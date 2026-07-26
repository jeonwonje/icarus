import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type {
  HostSnapshot,
  ModuleHost,
  SystemScheduleSpec,
  TurnJobLike,
} from './types.js';

type HostState = {
  mcps: HostSnapshot['mcps'];
  tools: SdkMcpToolDefinition[];
  commands: HostSnapshot['commands'];
  callbacks: HostSnapshot['callbacks'];
  startHooks: HostSnapshot['startHooks'];
  stopHooks: HostSnapshot['stopHooks'];
  statusLines: HostSnapshot['statusLines'];
  schedules: SystemScheduleSpec[];
};

function snapshotOf(state: HostState): HostSnapshot {
  return {
    mcps: [...state.mcps],
    tools: [...state.tools],
    commands: [...state.commands],
    callbacks: [...state.callbacks],
    startHooks: [...state.startHooks],
    stopHooks: [...state.stopHooks],
    statusLines: [...state.statusLines],
    schedules: [...state.schedules],
  };
}

export function createModuleHost(): ModuleHost & { snapshot(): HostSnapshot } {
  const state: HostState = {
    mcps: [],
    tools: [],
    commands: [],
    callbacks: [],
    startHooks: [],
    stopHooks: [],
    statusLines: [],
    schedules: [],
  };

  return {
    addMcp(name, server, opts) {
      state.mcps.push({ name, server, when: opts?.when });
    },
    addTools(tools) {
      state.tools.push(...tools);
    },
    addCommand(name, description, handler) {
      state.commands.push({ name, description, handler });
    },
    addCallback(prefix, handler) {
      state.callbacks.push({ prefix, handler });
    },
    onStart(fn) {
      state.startHooks.push(fn);
    },
    onStop(fn) {
      state.stopHooks.push(fn);
    },
    statusLine(fn) {
      state.statusLines.push(fn);
    },
    seedSchedule(spec) {
      state.schedules.push(spec);
    },
    snapshot() {
      return snapshotOf(state);
    },
  };
}

function hostSnapshot(host: ModuleHost): HostSnapshot {
  return (host as ModuleHost & { snapshot(): HostSnapshot }).snapshot();
}

export function mcpServersForTurn(host: ModuleHost, job: TurnJobLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of hostSnapshot(host).mcps) {
    if (entry.when && !entry.when(job)) continue;
    const cfg = typeof entry.server === 'function' ? entry.server() : entry.server;
    out[entry.name] = cfg;
  }
  return out;
}

export function extraTools(host: ModuleHost): SdkMcpToolDefinition[] {
  return [...hostSnapshot(host).tools];
}
