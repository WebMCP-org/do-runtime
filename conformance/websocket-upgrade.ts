import { withWebSocketUpgrade } from "../src/browser";

/** Preserve workerd's upgrade signal when browser Request.clone() drops forbidden headers. */
export function webSocketUpgradeRequest(url: string, tags: readonly string[]): Request {
  const request = new Request(`${url}?${tags.map((tag) => `tag=${encodeURIComponent(tag)}`).join("&")}`);
  return withWebSocketUpgrade(request);
}
