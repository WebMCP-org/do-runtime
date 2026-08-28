/**
 * The Durable Object. One actor, one SQLite database, one HTTP front door.
 *
 * Nothing in this file knows that it is running in a browser. It imports
 * `DurableObject` from `cloudflare:workers` (aliased in `vite.config.ts` to the
 * runtime's own copy of that module), it reaches storage through
 * `ctx.storage.sql`, and it answers `fetch()`. The same class would run on
 * Cloudflare unchanged.
 *
 * What the runtime is doing underneath, and why the code below is allowed to be
 * this naive:
 *
 * - **The constructor runs under boot semantics.** The input gate is held for
 *   its synchronous slice, so the `CREATE TABLE` and the first-boot seed below
 *   cannot interleave with a request. No "is the schema ready yet" flag, no
 *   promise to await before serving.
 *
 * - **`fetch()` runs under the input gate.** One event at a time, for this actor,
 *   across every caller — so the `PUT` below reads its body and writes the row
 *   as one uninterrupted event, with no lock and no `blockConcurrencyWhile`.
 *   (A *sequence* of requests from the page is not one event. The gate
 *   serialises events, not conversations; a transaction spanning several
 *   requests would still be the caller's problem, as it is on Cloudflare.)
 *
 * - **Writes ride the implicit transaction.** Every `sql.exec` in one event
 *   joins one transaction that commits at the end of the event, and the output
 *   gate holds the `Response` until that commit is durable. A reply that says
 *   "saved" therefore cannot outrun the bytes hitting OPFS.
 */

import { DurableObject } from "cloudflare:workers";

/** This actor takes no bindings. `env` is where they would arrive. */
export type WorkspaceEnv = Record<string, never>;

type FileRow = { path: string; content: string };

export class Workspace extends DurableObject<WorkspaceEnv> {
  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);

    // Synchronous SQLite, in a browser, inside a constructor. This is the whole
    // point of the port: `sql.exec` returns rows, it does not return a promise.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content TEXT NOT NULL)",
    );

    // First boot only: an empty workspace gets the starter app. On every later
    // boot — including the one after a page reload, which is a fresh worker over
    // the same OPFS files — the table already has rows and this does nothing.
    const [row] = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM files")
      .toArray();
    if (row?.n === 0) {
      for (const [path, content] of Object.entries(STARTER)) this.#save(path, content);
    }
  }

  /**
   * The actor's front door, as a real Durable Object fetch handler.
   *
   *   GET    /files          -> ["/src/App.tsx", …]
   *   GET    /file?path=…    -> the file's text
   *   PUT    /file?path=…    -> body becomes the file's text
   *   DELETE /file?path=…    -> removes it
   *
   * The page reaches this through one Cap'n Web call per request (see
   * `host.worker.ts`), so every line below runs inside one gated event.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/files") {
      if (request.method !== "GET") return refuse(405, "GET only");
      const paths = this.ctx.storage.sql
        .exec<Pick<FileRow, "path">>("SELECT path FROM files ORDER BY path")
        .toArray()
        .map((row) => row.path);
      return new Response(JSON.stringify(paths), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/file") {
      const path = url.searchParams.get("path");
      if (path === null) return refuse(400, "missing ?path=");

      switch (request.method) {
        case "GET": {
          const [row] = this.ctx.storage.sql
            .exec<Pick<FileRow, "content">>("SELECT content FROM files WHERE path = ?", path)
            .toArray();
          if (row === undefined) return refuse(404, `no such file: ${path}`);
          return new Response(row.content, { headers: { "content-type": "text/plain" } });
        }

        case "PUT": {
          // The one await in the whole actor, and it is the interesting one.
          //
          // On workerd every asynchronous step of reading a request body is an
          // io-context operation, so the code after this line resumes holding a
          // fresh input lock and may touch storage. A browser `Request` carries
          // no such property, so the host hands this method one whose body reads
          // are wrapped by the runtime's `gateRequestBody(container, request)`.
          // From in here it is invisible, which is the point: the actor is
          // written the way a Durable Object is written.
          const content = await request.text();
          this.#save(path, content);
          return new Response(`saved ${path}`, { headers: { "content-type": "text/plain" } });
        }

        case "DELETE": {
          this.ctx.storage.sql.exec("DELETE FROM files WHERE path = ?", path);
          return new Response(`deleted ${path}`, { headers: { "content-type": "text/plain" } });
        }

        default:
          return refuse(405, `${request.method} is not allowed on /file`);
      }
    }

    return refuse(404, `no route for ${url.pathname}`);
  }

  /** Upsert. Called from the constructor's boot slice and from `PUT`. */
  #save(path: string, content: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO files (path, content) VALUES (?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET content = excluded.content",
      path,
      content,
    );
  }
}

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

// =======================================================================================
// The starter app, seeded on first boot
//
// Three front-end files plus the authored actor, so both in-page builds have a real module graph:
// an entry, a component, and a module the component imports by a relative path.
// Bare specifiers (`react`, `react-dom/client`) stay external and are satisfied
// by the preview's import map — see `main.ts`.

const STARTER: Record<string, string> = {
  "/server/agent.ts": `import { Agent } from "agents";

export class MyAgent extends Agent {
  initialState = { visits: 0, recent: [] };

  async onRequest(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/visits") {
      return new Response("not found", { status: 404 });
    }

    if (request.method === "POST") {
      const body = await request.json();
      const note = typeof body === "object" && body !== null && typeof body.note === "string"
        ? body.note.slice(0, 80)
        : "a quiet hello";
      this.setState({
        visits: this.state.visits + 1,
        recent: [{ at: Date.now(), note }, ...this.state.recent].slice(0, 5),
      });
    } else if (request.method !== "GET") {
      return new Response("GET or POST only", { status: 405 });
    }

    return Response.json(this.state);
  }
}
`,

  "/src/main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");
if (root === null) throw new Error("the preview document has no #root");
createRoot(root).render(<App />);
`,

  "/src/plant.ts": `export type Stage = {
  readonly emoji: string;
  readonly name: string;
  readonly note: string;
};

export const STAGES: readonly Stage[] = [
  { emoji: "\\u{1F331}", name: "seedling", note: "two leaves and a great deal of ambition" },
  { emoji: "\\u{1F33F}", name: "sprig", note: "it has opinions about the light now" },
  { emoji: "\\u{1FAB4}", name: "houseplant", note: "officially furniture" },
  { emoji: "\\u{1F333}", name: "situation", note: "you may need a bigger pot" },
];

export function stageFor(drops: number): Stage {
  const stage = STAGES[Math.min(drops, STAGES.length - 1)];
  if (stage === undefined) throw new Error("STAGES is empty");
  return stage;
}
`,

  "/src/App.tsx": `import { useEffect, useState } from "react";
import { stageFor } from "./plant";

const TITLE = "The fern that lives in a Durable Object";

export function App() {
  const [drops, setDrops] = useState(0);
  const [visits, setVisits] = useState(null);
  const stage = stageFor(drops);

  async function loadVisits(method = "GET") {
    const response = await fetch("/api/visits", {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ note: "hello from the fern" }) } : {}),
    });
    if (!response.ok) throw new Error(await response.text());
    setVisits(await response.json());
  }

  useEffect(() => { void loadVisits(); }, []);

  return (
    <main style={styles.main}>
      <h1 style={styles.title} data-testid="title">{TITLE}</h1>
      <p style={styles.blurb}>
        Its source is three rows in a SQLite table, in a Web Worker, in this tab.
        You bundled it here too. Nothing has been to a server.
      </p>

      <div style={styles.pot} aria-hidden="true">{stage.emoji}</div>

      <p data-testid="stage" style={styles.stage}>
        {drops === 0
          ? "a seed, unwatered"
          : \`\${stage.name} — \${stage.note} (watered \${drops}\\u00D7)\`}
      </p>

      <p data-testid="visits" style={styles.stage}>
        {visits === null ? "asking the Durable Object…" : \`visits held in SQLite: \${visits.visits}\`}
      </p>

      <button style={styles.button} onClick={() => setDrops((d) => d + 1)}>
        water it
      </button>
      {" "}
      <button style={styles.button} onClick={() => void loadVisits("POST")}>
        sign the guestbook
      </button>
    </main>
  );
}

const styles = {
  main: {
    font: "16px/1.5 ui-sans-serif, system-ui, sans-serif",
    maxWidth: "30rem",
    margin: "3rem auto",
    padding: "0 1.5rem",
    textAlign: "center",
    color: "#1d2321",
  },
  title: { fontSize: "1.6rem", margin: "0 0 .5rem" },
  blurb: { margin: "0 0 2rem", color: "#5c6b64" },
  pot: { fontSize: "5rem", lineHeight: 1, userSelect: "none" },
  stage: { minHeight: "3rem", margin: ".75rem 0 1.25rem", color: "#33443c" },
  button: {
    font: "inherit",
    padding: ".5rem 1.25rem",
    border: "1px solid #2f6f4f",
    borderRadius: "999px",
    background: "#2f6f4f",
    color: "white",
    cursor: "pointer",
  },
} as const;
`,
};
