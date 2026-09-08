import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Local protocol boundary: real MCP SDK server and a small OAuth issuer. */
export async function startMcpProvider() {
  const authorizations = new Map();
  const exchanges = [];
  const clients = new Map();
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "browser-csp-probe", version: "1.0.0" });
    for (const name of ["greet", "bad-output"]) {
      server.registerTool(
        name,
        {
          inputSchema: z.object({ name: z.string().optional() }),
          outputSchema: z.object({ greeting: z.string() }),
        },
        async ({ name: recipient }) => ({
          content: [{ type: "text", text: `Hello ${recipient ?? "probe"}` }],
          structuredContent: { greeting: `Hello ${recipient ?? "probe"}` },
        }),
      );
    }
    return server;
  });

  let origin;
  const server = createServer((request, response) => {
    void serve(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });

  async function serve(request, response) {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "*");
    response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader(
      "access-control-expose-headers",
      "WWW-Authenticate, MCP-Protocol-Version, MCP-Session-Id",
    );
    response.setHeader("content-type", "application/json");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url, origin);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const json = (value, status = 200) => response.writeHead(status).end(JSON.stringify(value));

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
      const resourcePath = url.pathname.slice("/.well-known/oauth-protected-resource".length);
      json({
        resource: `${origin}${resourcePath}`,
        authorization_servers: [origin],
        scopes_supported: ["mcp:tools"],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:tools"],
      });
      return;
    }
    if (url.pathname === "/register") {
      const metadata = JSON.parse(body);
      const clientId = randomUUID();
      clients.set(clientId, metadata);
      json({ ...metadata, client_id: clientId }, 201);
      return;
    }
    if (url.pathname === "/authorize") {
      const params = url.searchParams;
      const client = clients.get(params.get("client_id"));
      if (
        !client?.redirect_uris.includes(params.get("redirect_uri")) ||
        params.get("code_challenge_method") !== "S256" ||
        !params.get("state")
      ) {
        json({ error: "invalid_request" }, 400);
        return;
      }
      const code = randomUUID();
      authorizations.set(code, Object.fromEntries(params));
      const callback = new URL(params.get("redirect_uri"));
      callback.searchParams.set("state", params.get("state"));
      callback.searchParams.set("code", code);
      response.writeHead(302, { location: callback.href }).end();
      return;
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(body);
      const authorization = authorizations.get(params.get("code"));
      const challenge = createHash("sha256")
        .update(params.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        !authorization ||
        challenge !== authorization.code_challenge ||
        params.get("client_id") !== authorization.client_id ||
        params.get("redirect_uri") !== authorization.redirect_uri ||
        params.get("resource") !== authorization.resource
      ) {
        json({ error: "invalid_grant" }, 400);
        return;
      }
      authorizations.delete(params.get("code"));
      exchanges.push({ resource: authorization.resource, state: authorization.state });
      json({
        access_token: `probe-token:${authorization.resource}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp:tools",
      });
      return;
    }
    if (url.pathname !== "/public" && !url.pathname.startsWith("/secure/")) {
      json({ error: "not_found" }, 404);
      return;
    }
    if (
      url.pathname.startsWith("/secure/") &&
      request.headers.authorization !== `Bearer probe-token:${url.href}`
    ) {
      response.setHeader(
        "www-authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${url.pathname}", scope="mcp:tools"`,
      );
      json({ error: "unauthorized" }, 401);
      return;
    }
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    const outbound = new Request(url, {
      method: request.method,
      headers: request.headers,
      signal: controller.signal,
      ...(body ? { body } : {}),
    });
    const reply = await handler.fetch(outbound);
    for (const [key, value] of reply.headers) response.setHeader(key, value);
    const rpc = body ? JSON.parse(body) : undefined;
    if (rpc?.method === "tools/call" && rpc.params.name === "bad-output") {
      // The remote peer violates its advertised schema. This must be rejected
      // by the browser client, independently of the real server's validation.
      const text = await reply.text();
      const payload = JSON.parse(
        reply.headers.get("content-type")?.includes("text/event-stream")
          ? text
              .split("\n")
              .find((line) => line.startsWith("data: "))
              .slice(6)
          : text,
      );
      payload.result.structuredContent = { greeting: 42 };
      response.setHeader("content-type", "application/json");
      json(payload, reply.status);
      return;
    }
    response.writeHead(reply.status);
    if (reply.body) for await (const chunk of reply.body) response.write(chunk);
    response.end();
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    exchanges,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
