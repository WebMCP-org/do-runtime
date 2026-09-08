import type { Agent } from "agents";

type Host = Pick<Agent, "mcp" | "sql" | "addMcpServer" | "removeMcpServer">;

export type McpProbeStart = {
  publicReady: boolean;
  authUrls: string[];
};

export type McpProbeResult = {
  tools: string[];
  greetings: unknown[];
  invalidOutputRejected: boolean;
  invalidOutputError: string;
  callbackWrites: number;
  concurrentPkce: boolean;
};

/** Real built Agents client; only the remote HTTP/OAuth provider is a fixture. */
export async function startMcpProbe(agent: Host, origin: string): Promise<McpProbeStart> {
  agent.sql`CREATE TABLE IF NOT EXISTS mcp_probe_callbacks (server_id TEXT NOT NULL)`;
  agent.sql`DELETE FROM mcp_probe_callbacks`;
  agent.mcp.configureOAuthCallback({
    customHandler(result) {
      // This SQL write fails if the host bypasses ActorContainer.fetch ingress.
      if (result.authSuccess) {
        agent.sql`INSERT INTO mcp_probe_callbacks (server_id) VALUES (${result.serverId})`;
      }
      return Response.json(result, { status: result.authSuccess ? 200 : 401 });
    },
  });
  const publicServer = await agent.addMcpServer("CSP schema probe", `${origin}/public`, {
    id: "mcp-public",
    callbackHost: "https://mcp-callback.example",
    callbackPath: "/callback",
    transport: { type: "streamable-http" },
  });
  const authorized = await Promise.all(
    ["first", "second"].map((name) =>
      agent.addMcpServer(`OAuth ${name}`, `${origin}/secure/${name}`, {
        id: `mcp-${name}`,
        callbackHost: "https://mcp-callback.example",
        callbackPath: "/callback",
        transport: { type: "streamable-http" },
      }),
    ),
  );
  return {
    publicReady: publicServer.state === "ready",
    authUrls: authorized.map((server) => {
      if (server.state !== "authenticating") throw new Error("Fixture did not require OAuth");
      return server.authUrl;
    }),
  };
}

async function concurrentPkce(agent: Host): Promise<boolean> {
  const provider = agent.mcp.mcpConnections["mcp-first"].options.transport.authProvider;
  if (!provider?.runWithCodeVerifierState || !provider.state) {
    throw new Error("Built OAuth provider has no PKCE state scope");
  }
  const pending: { state: string; verifier: string }[] = [];
  for (const name of ["first", "second"]) {
    const verifier = `${name}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const state = await provider.state();
    await provider.saveCodeVerifier(verifier);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const url = new URL("https://mcp-provider.example/authorize");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    await provider.redirectToAuthorization(url);
    pending.push({ state, verifier });
  }
  const isolated = await Promise.all(
    pending.map(({ state, verifier }, index) =>
      provider.runWithCodeVerifierState!(state, async () => {
        await scheduler.wait(index === 0 ? 10 : 30);
        const selected = await provider.codeVerifier();
        await provider.deleteCodeVerifier();
        await provider.consumeState(state);
        return selected === verifier;
      }),
    ),
  );
  return isolated.every(Boolean);
}

export async function finishMcpProbe(agent: Host): Promise<McpProbeResult> {
  await agent.mcp.waitForConnections();
  const serverIds = ["mcp-public", "mcp-first", "mcp-second"];
  const greetings = await Promise.all(
    serverIds.map(async (serverId) => {
      const result = await agent.mcp.callTool({
        serverId,
        name: "greet",
        arguments: { name: serverId },
      });
      return result.structuredContent;
    }),
  );
  let invalidOutputError = "";
  try {
    await agent.mcp.callTool({ serverId: "mcp-public", name: "bad-output", arguments: {} });
  } catch (error) {
    invalidOutputError = String(error);
  }
  const result = {
    tools: agent.mcp
      .listTools()
      .map((tool) => `${tool.serverId}:${tool.name}`)
      .sort(),
    greetings,
    invalidOutputRejected: /does not match.*output schema/i.test(invalidOutputError),
    invalidOutputError,
    callbackWrites: agent.sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM mcp_probe_callbacks`[0].count,
    concurrentPkce: await concurrentPkce(agent),
  };
  await Promise.all(serverIds.map((serverId) => agent.removeMcpServer(serverId)));
  return result;
}
