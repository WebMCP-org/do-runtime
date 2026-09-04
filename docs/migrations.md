# How to migrate Durable Object and Agent data

Use the same application migration mechanism on Cloudflare and on
`@mcp-b/do-runtime`. This package does not add an application migration registry.

Start by identifying what changed:

| Change | Migration owner | What to do |
| --- | --- | --- |
| Add, rename, transfer, or delete a Durable Object class on Cloudflare | Cloudflare deployment configuration | Update Wrangler's `exports`, or the legacy `migrations` array if the Worker still uses it. |
| Change an application SQL table | The application | Generate and run a Drizzle migration in the actor constructor. |
| Change the JSON shape stored by `Agent.state` | The application | Version the state and override `migratePersistedState()` in the Rook Agents SDK fork. |
| Change an Agents SDK internal `cf_agents_*` table | The Agents SDK | Upgrade the SDK. Its `_ensureSchema()` runs automatically. |
| Change a `do-runtime` internal `_cf_*` table | `do-runtime` | Upgrade this package. Runtime storage migration runs before actor construction. |

## Understand the Wrangler declaration

Wrangler's Durable Object configuration manages class and namespace lifecycle. It
does not run application SQL or transform `Agent.state`.

For a new Worker, follow Cloudflare's current `exports` form:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "durable_objects": {
    "bindings": [
      {
        "name": "ROOK_AGENT",
        "class_name": "RookAgent"
      }
    ]
  },
  "exports": {
    "RookAgent": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  }
}
```

An existing Worker may still have the legacy form:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "ROOK_AGENT",
        "class_name": "RookAgent"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["RookAgent"]
    }
  ]
}
```

Keep the legacy history unless you intentionally follow Cloudflare's conversion
guide. A Worker cannot use `exports` and `migrations` together.

The legacy `tag` orders class-lifecycle changes. It is not an application schema
version and does not point at Drizzle migrations. Adding a SQL column or changing
a TypeScript state type does not require another Wrangler entry.

A local `do-runtime` host has no Wrangler deployment. The host registers the
class in `ActorContainerOptions.exports` and constructs its namespace with a
stable `uniqueKey`. Never change that key for an existing namespace: it is part
of every actor ID and therefore determines which storage the actor opens.

Cloudflare reference:

- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Legacy Durable Object class migrations](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)

## Migrate application SQL with Drizzle

Use Drizzle's Durable Object driver and migrator for tables owned by Rook. The
same constructor pattern runs on Cloudflare and on `do-runtime`.

1. Change the Drizzle schema.
2. Run the repository's `drizzle-kit generate` command.
3. Review and commit the generated SQL and migration journal.
4. Import that migration bundle into the actor.
5. Run `migrate()` inside `blockConcurrencyWhile()` so no event can observe a
   partially initialized schema.

```ts
import { Agent } from "agents";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../drizzle/migrations";

export class RookAgent extends Agent<Env> {
  readonly db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);

    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }
}
```

Drizzle records applied migrations in each actor's database. Every actor runs the
constructor on its next wake, applies only missing migrations, and then accepts
events. Do not use schema push as a production migration strategy, and do not
edit or reorder a migration after shipping it.

The executable proof for this runtime is
[`src/drizzle-migrations.test.ts`](../src/drizzle-migrations.test.ts). It starts
an actor with one schema generation, preserves its data across eviction, starts
the same actor with a second generation, and verifies the pending migration runs
once.

Upstream references:

- [Cloudflare: initialize storage and run migrations in the constructor](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#initialize-storage-and-run-migrations-in-the-constructor)
- [Drizzle: Cloudflare Durable Objects SQLite](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-do)

## Migrate persisted `Agent.state`

`Agent.state` is one JSON value stored in the Agents SDK's `cf_agents_state`
table. Drizzle does not know its application shape, and `initialState` applies
only when no persisted state exists.

Give the state an integer version and handle every shipped shape. The
`migratePersistedState()` hook is currently supplied by the Rook Agents SDK fork;
it is not part of upstream Agents 0.22.

```ts
import { Agent } from "agents";

type RookState = {
  stateVersion: 1;
  count: number;
  label: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class RookAgent extends Agent<Env, RookState> {
  override initialState: RookState = {
    stateVersion: 1,
    count: 0,
    label: "current"
  };

  protected override migratePersistedState(value: unknown): RookState {
    if (!isRecord(value) || typeof value.count !== "number") {
      throw new TypeError("invalid persisted Rook state");
    }

    const version = value.stateVersion ?? 0;
    if (version === 0) {
      return {
        stateVersion: 1,
        count: value.count,
        label: typeof value.label === "string" ? value.label : "migrated"
      };
    }

    if (version === 1 && typeof value.label === "string") {
      return value as RookState;
    }

    throw new TypeError(`unsupported persisted Rook state version: ${String(version)}`);
  }
}
```

The hook runs when existing state is first hydrated, before the value is exposed
to the Agent or sent to a client. Returning a changed object persists the new
value without treating boot repair as a user update. Returning the same object
by reference is the no-op path. If migration throws, the stored row remains
unchanged so a fixed release can retry it.

Keep these constraints:

- Treat the input as `unknown`; TypeScript types do not validate stored JSON.
- Retain every migration path for a state shape that reached users.
- Validate the current shape before returning it.
- Do not call `setState()` from the migration hook.
- Do not replace invalid persisted data with `initialState` automatically.

Cloudflare documents the persistence behavior and the fact that existing Agents
load stored state rather than merging `initialState`:

- [Store and sync Agent state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/)

## Leave package-owned schemas alone

The Agents SDK calls its versioned `_ensureSchema()` during construction. Rook
must not create or alter `cf_agents_*` tables itself.

`do-runtime` opens and versions its own `_cf_*` storage before constructing the
actor. Application SQL cannot read or write the runtime's `PRAGMA user_version`,
matching workerd's pragma restrictions. Rook must not create or alter `_cf_*`
tables either.

## Verify an upgrade before release

For every persisted shape that has shipped:

1. Start the previous application version and write representative data.
2. Destroy the actor instance without deleting its storage.
3. Start the new version over the same storage.
4. Verify SQL rows and `Agent.state` were preserved and transformed.
5. Recreate the actor once more and verify every migration is now a no-op.
6. Inject an invalid or future state version and verify the original data remains
   available for recovery.

Run the package's focused checks with:

```sh
pnpm exec vitest run --config vitest.unit.config.ts \
  src/drizzle-migrations.test.ts \
  src/util/sqlite-migrations.test.ts

pnpm --filter do-runtime-example-extension e2e
```

The extension end-to-end test seeds an old unversioned `Agent.state`, destroys
the browser host, and verifies the replacement persists the migrated value before
a newly connected client sees it.
