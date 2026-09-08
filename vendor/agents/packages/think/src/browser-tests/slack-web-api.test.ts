import { afterEach, describe, expect, it, vi } from "vitest";
import { WebClient } from "../messengers/browser/slack-web-api";

function mockFetch(...responses: Response[]): Request[] {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch request");
      return response;
    })
  );
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("browser Slack Web API", () => {
  it("encodes nested arguments and lets a per-call token override client headers", async () => {
    const requests = mockFetch(
      Response.json({ ok: true, ts: "1.2" }),
      Response.json({ ok: true })
    );
    const client = new WebClient("default-token", {
      slackApiUrl: "https://slack.test/api",
      headers: { authorization: "Bearer header-token", "x-client": "browser" }
    });
    await expect(
      client.chat.postMessage({
        token: "call-token",
        channel: "C1",
        blocks: [
          { type: "section", text: { type: "plain_text", text: "Hi & bye" } }
        ],
        metadata: { event_type: "test", event_payload: { count: 0 } },
        unfurl_links: false,
        count: 0,
        thread_ts: undefined,
        nullable: null
      })
    ).resolves.toEqual({ ok: true, ts: "1.2" });
    expect(requests[0].url).toBe("https://slack.test/api/chat.postMessage");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("authorization")).toBe("Bearer call-token");
    expect(requests[0].headers.get("x-client")).toBe("browser");
    expect(requests[0].headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded"
    );
    const form = new URLSearchParams(await requests[0].text());
    expect(Object.fromEntries(form)).toEqual({
      channel: "C1",
      blocks: JSON.stringify([
        { type: "section", text: { type: "plain_text", text: "Hi & bye" } }
      ]),
      metadata: JSON.stringify({
        event_type: "test",
        event_payload: { count: 0 }
      }),
      unfurl_links: "false",
      count: "0"
    });
    await client.auth.test();
    expect(requests[1].headers.get("authorization")).toBe(
      "Bearer header-token"
    );
  });

  it("preserves Slack platform errors for adapter error handling", async () => {
    mockFetch(Response.json({ ok: false, error: "ratelimited" }));
    await expect(new WebClient().chat.postMessage()).rejects.toMatchObject({
      code: "slack_webapi_platform_error",
      data: { ok: false, error: "ratelimited" }
    });
  });

  it.each([
    {
      status: 429,
      body: '{"ok":true}',
      code: "slack_webapi_rate_limited_error"
    },
    {
      status: 503,
      body: "Service unavailable",
      code: "slack_webapi_http_error"
    }
  ])(
    "rejects HTTP $status before treating the body as an API success",
    async ({ status, body, code }) => {
      const requests = mockFetch(
        new Response(body, { status, headers: { "retry-after": "12" } })
      );
      await expect(new WebClient().auth.test()).rejects.toMatchObject({
        code,
        statusCode: status,
        body,
        headers: { "retry-after": "12" },
        ...(status === 429 ? { retryAfter: 12 } : {})
      });
      expect(requests).toHaveLength(1);
    }
  );

  it.each(["not JSON", "null", "[]", "{}", '{"ok":"true"}'])(
    "rejects malformed API responses: %s",
    async (body) => {
      mockFetch(new Response(body));
      await expect(new WebClient().auth.test()).rejects.toThrow();
    }
  );

  it("uploads exact view bytes without credentials and completes the batch with the call token", async () => {
    const requests = mockFetch(
      Response.json({
        ok: true,
        file_id: "F1",
        upload_url: "https://files.test/one"
      }),
      new Response("OK"),
      Response.json({
        ok: true,
        file_id: "F2",
        upload_url: "https://files.test/two"
      }),
      new Response("OK"),
      Response.json({ ok: true })
    );
    const client = new WebClient("default-token", {
      headers: { authorization: "Bearer header-token", "x-private": "private" }
    });
    const bytes = new Uint8Array([9, 0, 128, 255, 7]).subarray(1, 4);
    await expect(
      client.files.uploadV2({
        channel_id: "C1",
        thread_ts: "1.1",
        token: "upload-token",
        file_uploads: [
          { filename: "one.bin", file: bytes },
          { filename: "two.txt", file: new TextEncoder().encode("世界") }
        ]
      })
    ).resolves.toEqual({
      ok: true,
      files: [
        {
          files: [
            { id: "F1", title: "one.bin" },
            { id: "F2", title: "two.txt" }
          ]
        }
      ]
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.test/one",
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.test/two",
      "https://slack.com/api/files.completeUploadExternal"
    ]);
    for (const index of [0, 2, 4]) {
      expect(requests[index].headers.get("authorization")).toBe(
        "Bearer upload-token"
      );
    }
    for (const index of [1, 3]) {
      expect(requests[index].method).toBe("POST");
      expect(requests[index].headers.has("authorization")).toBe(false);
      expect(requests[index].headers.has("x-private")).toBe(false);
      expect(requests[index].credentials).toBe("omit");
    }
    expect(new Uint8Array(await requests[1].arrayBuffer())).toEqual(bytes);
    expect(await requests[3].text()).toBe("世界");
    expect(
      Object.fromEntries(new URLSearchParams(await requests[0].text()))
    ).toEqual({
      filename: "one.bin",
      length: "3"
    });
    expect(
      Object.fromEntries(new URLSearchParams(await requests[4].text()))
    ).toEqual({
      channel_id: "C1",
      thread_ts: "1.1",
      files: JSON.stringify([
        { id: "F1", title: "one.bin" },
        { id: "F2", title: "two.txt" }
      ])
    });
  });

  it("stops before completion when the upload endpoint rejects a file", async () => {
    const requests = mockFetch(
      Response.json({
        ok: true,
        file_id: "F1",
        upload_url: "https://files.test/one"
      }),
      new Response("Unavailable", { status: 503 })
    );
    await expect(
      new WebClient("token").files.uploadV2({
        file_uploads: [{ filename: "one.bin", file: new Uint8Array([1]) }]
      })
    ).rejects.toMatchObject({
      code: "slack_webapi_platform_error",
      data: { error: "upload_failed_503" }
    });
    expect(requests).toHaveLength(2);
  });

  it("rejects an invalid upload ticket without sending file bytes", async () => {
    const requests = mockFetch(Response.json({ ok: true, file_id: "F1" }));
    await expect(
      new WebClient().files.uploadV2({
        file_uploads: [{ filename: "one.bin", file: new Uint8Array([1]) }]
      })
    ).rejects.toMatchObject({
      code: "slack_webapi_platform_error",
      data: { error: "invalid_upload_ticket" }
    });
    expect(requests).toHaveLength(1);
  });
});
