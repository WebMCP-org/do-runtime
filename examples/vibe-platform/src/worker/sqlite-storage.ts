import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

/** sqlite-wasm documents and implements the retry flag but omits it from its declaration. */
export type RetryablePoolOptions = Parameters<Sqlite3Static["installOpfsSAHPoolVfs"]>[0] & {
  forceReinitIfPreviouslyFailed?: boolean;
};
