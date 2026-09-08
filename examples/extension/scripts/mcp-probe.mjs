import assert from "node:assert/strict";
import { startMcpProvider } from "./mcp-provider.mjs";

/** Reuses the loaded MV3 extension and its existing Host RPC entry. */
export async function runMcpProbe(popup, op) {
  const provider = await startMcpProvider();
  try {
    const start = await op(popup, "startMcpProbe", [provider.origin]);
    assert.equal(start.publicReady, true);
    assert.equal(start.authUrls.length, 2);
    const callbacks = await Promise.all(
      start.authUrls.map(async (url) => {
        const response = await fetch(url, { redirect: "manual" });
        assert.equal(response.status, 302);
        return response.headers.get("location");
      }),
    );
    const completed = await Promise.all(
      callbacks.map((url) => op(popup, "deliverMcpProbeCallback", [url])),
    );
    assert.ok(
      completed.every((result) => result.authSuccess === true),
      JSON.stringify(completed),
    );
    const result = await op(popup, "finishMcpProbe");
    assert.equal(
      result.callbackWrites,
      2,
      "OAuth custom callback SQL must run inside actor ingress",
    );
    assert.equal(
      result.concurrentPkce,
      true,
      "overlapping OAuth verifier scopes must stay isolated",
    );
    assert.equal(result.invalidOutputRejected, true, result.invalidOutputError);
    assert.equal(result.tools.length, 6);
    assert.deepEqual(
      result.greetings,
      ["mcp-public", "mcp-first", "mcp-second"].map((name) => ({ greeting: `Hello ${name}` })),
    );
    assert.equal(provider.exchanges.length, 2);
    assert.notEqual(provider.exchanges[0].state, provider.exchanges[1].state);
    assert.deepEqual(
      provider.exchanges.map((exchange) => exchange.resource).sort(),
      ["first", "second"].map((name) => `${provider.origin}/secure/${name}`),
    );
    console.log(
      "PASS  MV3 outbound MCP discovery/calls validate schemas; OAuth callbacks persist through actor ingress; concurrent PKCE remains isolated",
    );
  } finally {
    await provider.close();
  }
}
