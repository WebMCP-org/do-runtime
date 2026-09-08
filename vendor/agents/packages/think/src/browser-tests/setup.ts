import { Buffer } from "buffer";
import process from "process";

// Chat SDK adapters use Buffer for token checks and attachment conversion.
globalThis.Buffer = Buffer;
// Node stream dependencies read process.browser/version and use nextTick.
globalThis.process = process;
