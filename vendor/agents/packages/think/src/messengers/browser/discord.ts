import { DiscordAdapter } from "@chat-adapter/discord";
import type { WebhookOptions } from "chat";
import { z } from "zod";

// Announcement, public, and private threads.
const DISCORD_THREAD_TYPES = new Set([10, 11, 12]);
const discordChannelSchema = z
  .object({
    parent_id: z.string().nullable().optional(),
    type: z.number().int()
  })
  .loose();

// The installed adapter does not export this forwarded-event type even though
// subclasses are its documented extension seam.
interface ForwardedDiscordMessage {
  attachments: Array<{
    content_type?: string;
    filename: string;
    id: string;
    size: number;
    url: string;
  }>;
  author: {
    bot: boolean;
    global_name?: string;
    id: string;
    username: string;
  };
  channel_id: string;
  channel_type?: number;
  content: string;
  guild_id: string | null;
  id: string;
  is_mention?: boolean;
  mention_everyone?: boolean;
  mention_roles?: string[];
  mentions: Array<{ id: string; username: string }>;
  thread?: { id: string; parent_id: string };
  timestamp: string;
}

/**
 * Supplies the channel metadata Discord omits from ordinary MESSAGE_CREATE
 * dispatches. The base adapter already owns thread encoding and routing once
 * it knows the parent, so this resolves only that missing forwarded-event fact.
 */
export class ForwardedDiscordAdapter extends DiscordAdapter {
  // ponytail: per-adapter cache; bound it if one session sees unbounded channels.
  readonly #parentByChannel = new Map<string, string | null>();

  protected override async handleForwardedMessage(
    data: ForwardedDiscordMessage,
    options?: WebhookOptions
  ): Promise<void> {
    if (
      data.guild_id &&
      (data.channel_type === undefined ||
        DISCORD_THREAD_TYPES.has(data.channel_type)) &&
      data.thread === undefined
    ) {
      const parentId = await this.#resolveParentChannel(data.channel_id);
      if (parentId) {
        return super.handleForwardedMessage(
          { ...data, thread: { id: data.channel_id, parent_id: parentId } },
          options
        );
      }
    }
    return super.handleForwardedMessage(data, options);
  }

  async #resolveParentChannel(channelId: string): Promise<string | null> {
    const cached = this.#parentByChannel.get(channelId);
    if (cached !== undefined) return cached;

    const response = await this.discordFetch(`/channels/${channelId}`, "GET");
    const channel = discordChannelSchema.parse(await response.json());
    // Reject before Chat sees the event: routing an unknown thread as a channel
    // would deduplicate it under the wrong conversation and prevent a retry.
    const parentId = DISCORD_THREAD_TYPES.has(channel.type)
      ? z.string().min(1).parse(channel.parent_id)
      : null;
    this.#parentByChannel.set(channelId, parentId);
    return parentId;
  }
}
