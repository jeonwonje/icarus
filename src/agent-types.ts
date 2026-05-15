export interface AgentInput {
  prompt: string;
  sessionId?: string;
  /** cwd for the claude subprocess. Defaults to the data dir. */
  cwd?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export type AgentEventHandler = (ev: AgentOutput) => Promise<void> | void;
