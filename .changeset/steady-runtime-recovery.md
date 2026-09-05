---
"@mcp-b/do-runtime": patch
---

Keep transformed foreign awaits visible to lifecycle checks until their continuations are published, and preserve native synchronous-iterable behavior in transformed `for await` loops.

Restore WebSocket auto-response configuration and timestamps when a host recreates an actor from its hibernation mirror.

Roll back failed SQLite WASM snapshot replacements and direct storage copies. If rollback also fails, retain the original database images in `SqliteWasmRestoreError.recoverySnapshot` for host recovery. This rollback is in memory; hosts needing replacement to survive process loss should restore into a fresh prefix before switching placement.

Correct the minimal-host setup and verify its documented TypeScript configuration and code against the files included in the package.
