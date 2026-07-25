export type TelegramPeerKind = 'dm' | 'group' | 'supergroup';
export type TelegramConfigState = 'not_configured' | 'partial' | 'configured';
export type TelegramHealthState =
  | 'not_configured'
  | 'partial_config'
  | 'connecting'
  | 'connected'
  | 'temporarily_offline'
  | 'authorization_failed';
export type TelegramImportState =
  | 'paused'
  | 'scanning'
  | 'acquiring'
  | 'complete'
  | 'cancelled'
  | 'error';

export interface TelegramHealth {
  state: TelegramHealthState;
  selectedChats: number;
  activeChatTitle?: string;
  importedMessages?: number;
  totalMessages?: number;
  lastLiveAt?: string;
  lastReconciledAt?: string;
  error?: string;
}

export interface TelegramDialog {
  peerKey: string;
  kind: TelegramPeerKind;
  title: string;
  username?: string;
  accessHash?: string;
  selected: boolean;
  totalMessages?: number;
}

export interface TelegramMediaDescriptor {
  mediaKey: string;
  kind: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  descriptorJson: string;
}

export interface TelegramLinkDescriptor {
  url: string;
  previewJson?: string;
}

export interface TelegramPollSnapshot {
  pollId: string;
  question: string;
  closed: boolean;
  options: { optionKey: string; text: string; voters?: number; chosen: boolean }[];
}

export interface TelegramMessage {
  peerKey: string;
  messageId: number;
  senderKey?: string;
  senderName?: string;
  sentAt: string;
  editedAt?: string;
  replyToMessageId?: number;
  groupedId?: string;
  text: string;
  entitiesJson: string;
  reactionsJson: string;
  poll?: TelegramPollSnapshot;
  media: TelegramMediaDescriptor[];
  links: TelegramLinkDescriptor[];
}

export type TelegramLiveEvent =
  | { type: 'message'; message: TelegramMessage }
  | { type: 'edit'; message: TelegramMessage }
  | { type: 'delete'; peerKey?: string; messageIds: number[]; observedAt: string }
  | {
      type: 'reactions';
      peerKey: string;
      messageId: number;
      reactionsJson: string;
      observedAt: string;
    }
  | {
      type: 'poll';
      peerKey: string;
      messageId: number;
      poll: TelegramPollSnapshot;
      observedAt: string;
    };

export interface HistoryPage {
  messages: TelegramMessage[];
  totalMessages: number;
  nextBeforeMessageId: number | null;
}

export interface DifferenceResult {
  events: TelegramLiveEvent[];
  globalState?: string;
  channelState?: string;
  complete: boolean;
}

export interface TelegramAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isAuthorized(): Promise<boolean>;
  listDialogs(): Promise<TelegramDialog[]>;
  countMessages(peerKey: string): Promise<number>;
  fetchHistoryPage(peerKey: string, beforeMessageId: number | null, limit: number): Promise<HistoryPage>;
  fetchMessage(peerKey: string, messageId: number): Promise<TelegramMessage | undefined>;
  downloadMedia(peerKey: string, messageId: number, mediaKey: string, outputPath: string): Promise<number>;
  getGlobalDifference(state: string | undefined): Promise<DifferenceResult>;
  getChannelDifference(peerKey: string, state: string | undefined): Promise<DifferenceResult>;
  onEvent(handler: (event: TelegramLiveEvent) => Promise<void>): () => void;
  onConnectionChange(handler: (connected: boolean) => void): () => void;
}
