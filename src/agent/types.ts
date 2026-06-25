import type { ChannelName } from '../core/config.js';

export interface TurnMeta {
  channel: ChannelName;
  senderId: string;
  senderName: string | null;
}

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  meta?: TurnMeta;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export type AgentEventHandler = (ev: AgentOutput) => Promise<void> | void;
