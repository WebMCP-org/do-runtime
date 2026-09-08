// Fetch-backed @slack/web-api for @chat-adapter/slack's forwarded Socket Mode.
// ponytail: bounded method surface, no OAuth/Assistant/native streaming or
// automatic retries; extend it when the adapter requires another API.

import { z, type JSONType } from "zod";

type MethodArgs = {
  [key: string]: JSONType | undefined;
  token?: string;
};

const slackApiResponseSchema = z
  .object({ ok: z.boolean(), error: z.string().optional() })
  .catchall(z.json());
type SlackApiResponse = z.infer<typeof slackApiResponseSchema>;

const slackUploadTicketSchema = slackApiResponseSchema.extend({
  file_id: z.string().min(1),
  upload_url: z.url()
});
const formPrimitiveSchema = z.union([z.string(), z.number(), z.boolean()]);

class SlackPlatformError extends Error {
  readonly code = "slack_webapi_platform_error";
  constructor(readonly data: SlackApiResponse) {
    super(`An API error occurred: ${data.error ?? "unknown_error"}`);
    this.name = "SlackPlatformError";
  }
}

function formEncode(args: MethodArgs): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const primitive = formPrimitiveSchema.safeParse(value);
    params.set(
      key,
      primitive.success ? String(primitive.data) : JSON.stringify(value)
    );
  }
  return params;
}

type FileUploadItem = { file: Uint8Array; filename: string };
type UploadV2Args = {
  channel_id?: string;
  file_uploads?: FileUploadItem[];
  thread_ts?: string;
  token?: string;
};

export class WebClient {
  readonly #token?: string;
  readonly #apiUrl: string;
  readonly #headers: Record<string, string>;

  constructor(
    token?: string,
    options: { headers?: Record<string, string>; slackApiUrl?: string } = {}
  ) {
    this.#token = token;
    const url = options.slackApiUrl ?? "https://slack.com/api/";
    this.#apiUrl = url.endsWith("/") ? url : `${url}/`;
    this.#headers = options.headers ?? {};
  }

  async apiCall(
    method: string,
    args: MethodArgs = {}
  ): Promise<SlackApiResponse> {
    const { token, ...rest } = args;
    const headers = new Headers(this.#headers);
    headers.set("content-type", "application/x-www-form-urlencoded");
    if (this.#token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${this.#token}`);
    }
    if (token !== undefined) {
      if (token) headers.set("authorization", `Bearer ${token}`);
      else headers.delete("authorization");
    }
    const response = await fetch(`${this.#apiUrl}${method}`, {
      method: "POST",
      headers,
      body: formEncode(rest).toString()
    });
    if (!response.ok) {
      const retryHeader = response.headers.get("retry-after");
      const retryAfter = retryHeader === null ? NaN : Number(retryHeader);
      throw Object.assign(
        new Error(`Slack HTTP request failed: statusCode = ${response.status}`),
        {
          code:
            response.status === 429
              ? "slack_webapi_rate_limited_error"
              : "slack_webapi_http_error",
          statusCode: response.status,
          statusMessage: response.statusText,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
          ...(response.status === 429 &&
          Number.isFinite(retryAfter) &&
          retryAfter >= 0
            ? { retryAfter }
            : {})
        }
      );
    }
    const data = slackApiResponseSchema.parse(await response.json());
    if (!data.ok) throw new SlackPlatformError(data);
    return data;
  }

  readonly auth = {
    test: (args: MethodArgs = {}) => this.apiCall("auth.test", args)
  };

  readonly chat = {
    delete: (args: MethodArgs = {}) => this.apiCall("chat.delete", args),
    deleteScheduledMessage: (args: MethodArgs = {}) =>
      this.apiCall("chat.deleteScheduledMessage", args),
    postEphemeral: (args: MethodArgs = {}) =>
      this.apiCall("chat.postEphemeral", args),
    postMessage: (args: MethodArgs = {}) =>
      this.apiCall("chat.postMessage", args),
    scheduleMessage: (args: MethodArgs = {}) =>
      this.apiCall("chat.scheduleMessage", args),
    update: (args: MethodArgs = {}) => this.apiCall("chat.update", args)
  };

  readonly conversations = {
    history: (args: MethodArgs = {}) =>
      this.apiCall("conversations.history", args),
    info: (args: MethodArgs = {}) => this.apiCall("conversations.info", args),
    open: (args: MethodArgs = {}) => this.apiCall("conversations.open", args),
    replies: (args: MethodArgs = {}) =>
      this.apiCall("conversations.replies", args)
  };

  readonly reactions = {
    add: (args: MethodArgs = {}) => this.apiCall("reactions.add", args),
    remove: (args: MethodArgs = {}) => this.apiCall("reactions.remove", args)
  };

  readonly users = {
    info: (args: MethodArgs = {}) => this.apiCall("users.info", args)
  };

  readonly views = {
    open: (args: MethodArgs = {}) => this.apiCall("views.open", args),
    publish: (args: MethodArgs = {}) => this.apiCall("views.publish", args),
    update: (args: MethodArgs = {}) => this.apiCall("views.update", args)
  };

  readonly files = {
    // Upstream's composite helper: external upload URL per file, raw bytes
    // POST, then one completeUploadExternal for the batch. The adapter reads
    // back `{ files: [{ files: [{ id }] }] }`.
    uploadV2: async (args: UploadV2Args): Promise<SlackApiResponse> => {
      const { channel_id, file_uploads = [], thread_ts, token } = args;
      const uploaded: Array<{ id: string; title: string }> = [];
      for (const upload of file_uploads) {
        const ticketArgs = {
          filename: upload.filename,
          length: upload.file.byteLength,
          token
        };
        const ticket = slackUploadTicketSchema.safeParse(
          await this.apiCall("files.getUploadURLExternal", ticketArgs)
        );
        if (!ticket.success) {
          throw new SlackPlatformError({
            ok: false,
            error: "invalid_upload_ticket"
          });
        }
        const post = await fetch(ticket.data.upload_url, {
          method: "POST",
          credentials: "omit",
          body: new Blob([new Uint8Array(upload.file)])
        });
        if (!post.ok) {
          throw new SlackPlatformError({
            ok: false,
            error: `upload_failed_${post.status}`
          });
        }
        uploaded.push({ id: ticket.data.file_id, title: upload.filename });
      }
      const completedArgs = { channel_id, files: uploaded, thread_ts, token };
      const completed = await this.apiCall(
        "files.completeUploadExternal",
        completedArgs
      );
      return { ...completed, files: [{ files: uploaded }] };
    }
  };
}
