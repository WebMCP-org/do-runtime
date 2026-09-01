import type { Adapter } from "chat";
import { Think } from "../../think";
import { chatSdkMessenger, type ThinkMessengers } from "../../messengers";

const fakeAdapter = {
  channelIdFromThreadId(threadId: string) {
    return threadId;
  },
  decodeThreadId(threadId: string) {
    return threadId;
  },
  deleteMessage() {
    return Promise.resolve();
  },
  editMessage() {
    return Promise.resolve({ id: "edited", raw: {}, threadId: "fake" });
  },
  encodeThreadId(threadId: string) {
    return threadId;
  },
  fetchMessages() {
    return Promise.resolve({ messages: [] });
  },
  fetchThread(threadId: string) {
    return Promise.resolve({
      channelId: threadId,
      id: threadId,
      isDM: false,
      metadata: {}
    });
  },
  handleWebhook() {
    return Promise.resolve(new Response("messenger"));
  },
  initialize() {
    return Promise.resolve();
  },
  postMessage() {
    return Promise.resolve({ id: "posted", raw: {}, threadId: "fake" });
  },
  removeReaction() {
    return Promise.resolve();
  },
  addReaction() {
    return Promise.resolve();
  },
  userName: "fake_bot"
} as unknown as Adapter;

export class ThinkMessengerRouteTestAgent extends Think {
  private messengerToken?: string | null;

  override getMessengers(): ThinkMessengers {
    if (this.messengerToken === null) {
      return {};
    }
    const token = this.messengerToken;
    return {
      fake: chatSdkMessenger({
        adapter: fakeAdapter,
        provider: "fake",
        userName: "fake_bot",
        verifyWebhook: token
          ? (request) => request.headers.get("x-test-messenger-token") === token
          : false
      })
    };
  }

  async setMessengerToken(token: string | null): Promise<void> {
    this.messengerToken = token ?? null;
    await this.internal_reconcileChannels();
  }

  override onRequest(_request: Request): Response | Promise<Response> {
    return new Response("fallback");
  }
}
