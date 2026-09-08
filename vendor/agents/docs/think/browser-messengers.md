# Browser Slack and Discord channels

The fork ships the reusable browser parts previously owned by Rook. Think's
`configureChannels()`, `chatSdkMessenger()` and channel delivery still own
policy, conversations, subscriptions and replies. These helpers supply native
outbound sockets and the small adapter gaps; they do not create another channel
runtime.

## Connect and stop

```ts
import {
  startSlackSocketClient,
  startDiscordGatewayClient
} from "@cloudflare/think/messengers/browser";

const stopSlack = startSlackSocketClient({
  appToken,
  onEvent: (event) => forwardToActor("/messengers/slack/webhook", event),
  onStatus: (status) => console.log(status.phase)
});
const stopDiscord = startDiscordGatewayClient({
  botToken,
  onEvent: (event) => forwardToActor("/messengers/discord/webhook", event)
});

// Call before replacing credentials, disabling a provider, or stopping the host.
stopSlack();
stopDiscord();
```

`forwardToActor` is the host's existing actor-entry transport. Each event has
`body` and `headers`, which can cross a MessagePort and become
`new Request(url, { method: "POST", ...event })` at the actor. Dispatch that
request through the actor's normal gated `fetch()` path. The host owns delivery
errors, configuration changes and any durable admission before processing.
Keep forwarded events private: their headers contain provider credentials.

Run sockets in the long-lived host/offscreen document, outside an evictable
actor. Closing a tab, browser or offscreen document stops its sockets. Discord
resumes a retained Gateway session after reconnecting while that client remains
alive; process loss requires a fresh session. Slack acknowledges envelopes
before handing them to the host and does not recover disconnected delivery
gaps. These are live transports, not a durable inbox.

## Register the adapters with Think

Use `SocketModeSlackAdapter` from
`@cloudflare/think/messengers/browser/slack` and `ForwardedDiscordAdapter` from
`@cloudflare/think/messengers/browser/discord` with their ordinary adapter
configuration. Install the optional `@chat-adapter/slack@4.37.0` and/or
`@chat-adapter/discord@4.37.0` peers for the leaves you use. The socket-only
entry does not import either adapter.

`SocketModeSlackAdapter` disables native Assistant streaming and makes the
Assistant typing indicator a no-op; Chat SDK supplies post/edit streaming.
Provide `appToken`, `botToken` and a `webhookVerifier` that rejects ordinary
HTTP webhook events when accepting only forwarded Socket Mode events.
`ForwardedDiscordAdapter` resolves missing thread-parent metadata through the
adapter's authenticated REST client, including announcement threads (type 10).
Failed or malformed parent lookups reject delivery without caching a false
non-thread result; the host can retry the same envelope.

Return `messengerChannel(chatSdkMessenger({ adapter, provider, userName,
verifyWebhook, respondTo }))` from `configureChannels()`. For the usual
mention-followed-by-conversation behavior, set
`respondTo: ["direct-message", "mention", "subscribed-thread"]`. Verify the
appropriate forwarded token at the host ingress; the adapters also verify
`x-slack-socket-token` / `x-discord-gateway-token`. After a credential change,
stop the old socket client, reconcile the actor's channels through
`internal_reconcileChannels()`, then start the new client.

## Browser bundle aliases

The pinned adapters statically import Node transports even in forwarded mode.
Configure these exact module replacements in the browser bundler:

| Import               | Replacement                                              |
| -------------------- | -------------------------------------------------------- |
| `@slack/web-api`     | `@cloudflare/think/messengers/browser/slack-web-api`     |
| `@slack/socket-mode` | `@cloudflare/think/messengers/browser/slack-socket-mode` |
| `discord.js`         | `@cloudflare/think/messengers/browser/discord-js`        |

Resolve replacements to their ESM files (for example,
`fileURLToPath(import.meta.resolve(specifier))` in Vite). The two Node transport
replacements throw if constructed; the native socket clients own that work.

The fetch-backed Slack `WebClient` supports the adapter's ordinary
post/edit/delete, history/replies, reactions, views and external file uploads.
It honors `slackApiUrl`, custom headers and per-call tokens. Platform failures
retain `slack_webapi_platform_error`; HTTP failures expose `statusCode`, and
429 exposes `retryAfter` when provided. There are no automatic retries or
timeouts, OAuth helpers, Assistant APIs or native Slack streaming. It is a
bounded adapter shim, not the complete `@slack/web-api` package.

The host must also supply its existing Node compatibility for `Buffer`,
`async_hooks`, `crypto` (including Slack's `timingSafeEqual` import) and
`process` (not just `process.env`). Use the dependency's `worker` condition for markdown decoding;
the DOM decoder cannot load in a Worker. The browser test config is an
executable alias recipe. This extraction does not solve browser-wide async
context propagation or OAuth encryption.

Extension host permissions and browser HTTP/CORS rules still apply. Rook's
Discord REST `User-Agent` rule remains a Chrome network-boundary concern;
the local test server does not verify Discord's live network acceptance.

## Verification and provenance

```sh
pnpm --dir vendor/agents test:browser
pnpm --dir vendor/agents test:think
pnpm --dir vendor/agents check
```

The browser gate exercises protocol lifecycle races in Chromium and the built
package in a real Worker against local HTTP/WebSocket endpoints, through real
Chat adapters and Chat's in-memory test state. It also checks token rejection,
thread routing and upload errors. Native Workers tests retain Think's SQL,
channel policy, threading and recovery coverage. No test uses live tokens or
posts to Slack/Discord.

The extraction comes from Rook's `offscreen/messengers/{slack-socket,
discord-gateway}.ts` and `offscreen/worker/host/shims/`. Protocol references:
[Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[Discord Gateway](https://docs.discord.com/developers/events/gateway), and
[Chat SDK Slack adapter](https://chat-sdk.dev/adapters/official/slack).
