/**
 * Drizzle ORM's Durable Object migration flow, run end-to-end on this runtime.
 *
 * The flow being pinned is the one Drizzle documents for Cloudflare
 * (https://orm.drizzle.team/docs/connect-cloudflare-do): the application
 * changes its schema types, `drizzle-kit generate` turns the diff into SQL
 * compiled into the bundle as `{ journal, migrations }`, and every Durable
 * Object applies whatever it is missing in its constructor under
 * `blockConcurrencyWhile()` — tracked per actor in `__drizzle_migrations`.
 *
 * Each `GENERATION_*` below is one deploy of that application: the schema
 * module as the developer wrote it and the migrations bundle exactly as
 * `drizzle-kit generate` emits it for that schema (written out by hand so the
 * test does not shell out to the CLI). What the runtime supplies underneath —
 * and what this test therefore proves — is boot-time `blockConcurrencyWhile`,
 * synchronous `storage.sql.exec` cursors with workerd's iterator-helper
 * surface (`raw().toArray()` is what Drizzle's driver calls), and
 * `storage.transactionSync`, on a database that outlives the instance.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, test } from "vitest";
import { createNodeSqlProvider } from "../backends/node-sqlite";
import { createActorContainer, noFacets } from "./server/actor-container";
import type { DurableObjectState } from "./api/actor-state";
import type { Timer } from "./io/io-context";

/** Deploy 1: the initial schema module and the bundle generated from it. */
const GENERATION_1 = {
  users: sqliteTable("users", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
  }),
  bundle: {
    journal: {
      entries: [{ idx: 0, when: 1756200000000, tag: "0000_init", breakpoints: true }],
    },
    migrations: {
      m0000:
        "CREATE TABLE `users` (`id` integer PRIMARY KEY, `name` text NOT NULL);\n" +
        "--> statement-breakpoint\n" +
        "CREATE INDEX `users_name_idx` ON `users` (`name`);",
    },
  },
};

/** Deploy 2: the schema types grew `email` and the CLI ran again. */
const GENERATION_2 = {
  users: sqliteTable("users", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
  }),
  bundle: {
    journal: {
      entries: [
        ...GENERATION_1.bundle.journal.entries,
        { idx: 1, when: 1756300000000, tag: "0001_add_email", breakpoints: true },
      ],
    },
    migrations: {
      ...GENERATION_1.bundle.migrations,
      m0001: "ALTER TABLE `users` ADD COLUMN `email` text;",
    },
  },
};

type Generation = typeof GENERATION_1 | typeof GENERATION_2;

/** The class from Drizzle's Durable Object guide, verbatim in shape. */
class UserDirectory {
  readonly #db: ReturnType<typeof drizzle>;
  readonly #ctx: DurableObjectState;
  readonly #generation: Generation;

  constructor(ctx: DurableObjectState, generation: Generation) {
    this.#ctx = ctx;
    this.#generation = generation;
    this.#db = drizzle(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.#db, generation.bundle);
    });
  }

  async addUser(values: { id: number; name: string; email?: string }): Promise<void> {
    await this.#db.insert(this.#generation.users).values(values);
  }

  async listUsers(): Promise<Record<string, unknown>[]> {
    const { users } = this.#generation;
    return await this.#db.select().from(users).orderBy(users.id);
  }

  async appliedMigrations(): Promise<number> {
    return this.#ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM __drizzle_migrations")
      .one().n;
  }
}

const timer: Timer = {
  now: () => Date.now(),
  afterDelay: (ms, signal) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => clearTimeout(handle));
    }),
};

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** One wake of the actor under one deploy: fresh instance, same files. */
async function wake(generation: Generation) {
  if (directory === undefined) directory = await mkdtemp(join(tmpdir(), "drizzle-migrations-"));
  const provider = createNodeSqlProvider({ directory });
  const container = await createActorContainer({
    id: "user-directory",
    uniqueKey: "drizzle-migrations-test",
    exports: {},
    env: {},
    ports: {
      sql: provider,
      alarms: { scheduleRun: () => Promise.resolve() },
      facets: noFacets,
      timer,
    },
  });
  const instance = await container.start((ctx) => new UserDirectory(ctx, generation));
  const actor = container.entry(instance);
  return {
    actor,
    evict: (): void => {
      container.abort(new Error("instance evicted"));
      provider.close();
    },
  };
}

describe("Drizzle durable-sqlite migrations on this runtime", () => {
  test("each schema generation applies on the next wake, keeping the data", async () => {
    // First deploy: the initial schema migrates on first wake, before any event.
    const first = await wake(GENERATION_1);
    expect(await first.actor.appliedMigrations()).toBe(1);
    await first.actor.addUser({ id: 1, name: "ada" });
    first.evict();

    // Second deploy: the same actor's next wake — a fresh instance over the
    // same files — runs only the pending migration, and the old rows survive.
    const second = await wake(GENERATION_2);
    expect(await second.actor.appliedMigrations()).toBe(2);
    await second.actor.addUser({ id: 2, name: "grace", email: "grace@example.com" });
    expect(await second.actor.listUsers()).toEqual([
      { id: 1, name: "ada", email: null },
      { id: 2, name: "grace", email: "grace@example.com" },
    ]);
    second.evict();

    // A wake with nothing pending applies nothing and changes nothing.
    const third = await wake(GENERATION_2);
    expect(await third.actor.appliedMigrations()).toBe(2);
    expect((await third.actor.listUsers()).length).toBe(2);
    third.evict();
  });
});
