import { Buffer } from "buffer";
import process from "process";

// Chat adapters need Buffer; Node streams read process.browser/version and nextTick.
Object.assign(globalThis, { Buffer, process });
