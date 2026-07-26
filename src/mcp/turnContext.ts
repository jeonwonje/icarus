export interface TurnContext {
  jid: string;
  kind: string;
  getSessionId: () => string | undefined;
}

let active: TurnContext | undefined;

export function setActiveTurnContext(ctx: TurnContext): void {
  active = ctx;
}

export function getActiveTurnContext(): TurnContext | undefined {
  return active;
}
