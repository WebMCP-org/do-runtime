import { SlackAdapter, type SlackAdapterConfig } from "@chat-adapter/slack";

/** Ordinary Socket Mode threads do not have Slack Assistant status/stream APIs. */
export class SocketModeSlackAdapter extends SlackAdapter {
  constructor(config: SlackAdapterConfig) {
    super({ ...config, nativeStreaming: false });
  }

  override startTyping(_threadId: string, _status?: string): Promise<void> {
    return Promise.resolve();
  }
}
