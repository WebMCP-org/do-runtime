import { MIME_BY_EXTENSION } from "./fs/mime-types";
import { createHash } from "node:crypto";
import type {
  StateArchiveEntry,
  StateFileDetection,
  StateFindEntry,
  StateFindOptions,
  StateHashOptions,
  StateJsonUpdateOperation,
  StateJsonUpdateResult,
  StateTreeNode,
  StateTreeOptions,
  StateTreeSummary
} from "./backend";
import { decodeText, diffContent, encodeText } from "./helpers";

type PathToken = string | number;

type TreeOps = {
  lstat(path: string): Promise<{
    type: "file" | "directory" | "symlink";
    size: number;
    mtime: Date;
  } | null>;
  readdirWithFileTypes(path: string): Promise<
    Array<{
      name: string;
      type: "file" | "directory" | "symlink";
    }>
  >;
  resolvePath(base: string, path: string): Promise<string>;
};

export function queryJsonValue(value: unknown, query: string): unknown {
  const tokens = parseJsonPath(query);
  let current = value;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current)) {
        throw new Error(`JSON query expected array access at [${token}]`);
      }
      current = current[token];
    } else {
      if (current === null || typeof current !== "object") {
        throw new Error(`JSON query expected object access at "${token}"`);
      }
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

export function updateJsonValue(
  input: unknown,
  operations: StateJsonUpdateOperation[],
  filePath: string
): StateJsonUpdateResult {
  const clone = structuredClone(input) as unknown;
  for (const operation of operations) {
    const tokens = parseJsonPath(operation.path);
    if (operation.op === "set") {
      setJsonPathValue(clone, tokens, operation.value);
    } else {
      deleteJsonPathValue(clone, tokens);
    }
  }

  const content = JSON.stringify(clone, null, 2) + "\n";
  return {
    value: clone,
    content,
    diff:
      JSON.stringify(input) === JSON.stringify(clone)
        ? ""
        : diffContent(
            JSON.stringify(input, null, 2) + "\n",
            content,
            filePath,
            filePath
          ),
    operationsApplied: operations.length
  };
}

export async function buildTree(
  root: string,
  ops: TreeOps,
  options: StateTreeOptions = {}
): Promise<StateTreeNode> {
  const seenDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  return buildTreeNode(root, 0, seenDepth, ops);
}

export async function summarizeTree(
  root: string,
  ops: TreeOps,
  options: StateTreeOptions = {}
): Promise<StateTreeSummary> {
  const tree = await buildTree(root, ops, options);
  const summary: StateTreeSummary = {
    files: 0,
    directories: 0,
    symlinks: 0,
    totalBytes: 0,
    maxDepth: 0
  };
  summarizeNode(tree, 0, summary);
  return summary;
}

export async function findInTree(
  root: string,
  ops: TreeOps,
  options: StateFindOptions = {}
): Promise<StateFindEntry[]> {
  const results: StateFindEntry[] = [];
  const matcher =
    options.pathPattern !== undefined ? globToRegex(options.pathPattern) : null;
  const nameMatcher =
    options.name !== undefined ? globToRegex(options.name) : null;
  const types = Array.isArray(options.type)
    ? new Set(options.type)
    : options.type
      ? new Set([options.type])
      : null;
  await visitFind(
    root,
    root,
    0,
    ops,
    options,
    matcher,
    nameMatcher,
    types,
    results
  );
  return results;
}

export function detectFile(
  path: string,
  bytes: Uint8Array
): StateFileDetection {
  const extension = getExtension(path);
  const text = isLikelyText(bytes);
  const mime =
    MIME_BY_EXTENSION[extension ?? ""] ??
    (text ? "text/plain" : "application/octet-stream");
  return {
    mime,
    extension: extension ?? undefined,
    binary: !text,
    description: `${mime}${extension ? ` (${extension})` : ""}`
  };
}

export function hashBytes(
  bytes: Uint8Array,
  options: StateHashOptions = {}
): string {
  const algorithm = options.algorithm ?? "sha256";
  return createHash(algorithm).update(bytes).digest("hex");
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return transformBytes(bytes, new CompressionStream("gzip"));
}

export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return transformBytes(bytes, new DecompressionStream("gzip"));
}

export function buildTar(entries: Array<TarInputEntry>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = createTarHeader(entry);
    chunks.push(header);
    if (entry.type === "file") {
      chunks.push(entry.bytes);
      const remainder = entry.bytes.byteLength % 512;
      if (remainder !== 0) {
        chunks.push(new Uint8Array(512 - remainder));
      }
    }
  }
  chunks.push(new Uint8Array(1024));
  return concatBytes(chunks);
}

export type ArchiveEntry = {
  path: string;
  type: "file" | "directory";
  bytes: Uint8Array;
};

/**
 * Reads every entry of a tar, gzip-compressed tar or ZIP archive, chosen by
 * its leading bytes. Anything else, and any entry that fails its integrity
 * check, rejects before a caller writes a single entry.
 */
export async function readArchive(
  path: string,
  bytes: Uint8Array
): Promise<ArchiveEntry[]> {
  if (startsWithBytes(bytes, GZIP_MAGIC)) {
    const tar = await gunzipBytes(bytes);
    if (!isTar(tar)) {
      throw new Error(
        `${path} is gzip-compressed but does not contain a tar archive`
      );
    }
    return parseTar(path, tar);
  }
  if (
    startsWithBytes(bytes, ZIP_LOCAL_MAGIC) ||
    startsWithBytes(bytes, ZIP_EMPTY_MAGIC)
  ) {
    return parseZip(path, bytes);
  }
  if (isTar(bytes)) {
    return parseTar(path, bytes);
  }
  const known = KNOWN_NON_ARCHIVES.find(([magic]) =>
    startsWithBytes(bytes, magic)
  );
  throw new Error(
    `${path} is ${known ? `${known[1]}, not` : "not"} a tar, gzip-compressed tar or ZIP archive`
  );
}

export function describeArchiveEntry(entry: ArchiveEntry): StateArchiveEntry {
  return { path: entry.path, type: entry.type, size: entry.bytes.byteLength };
}

export type TarInputEntry =
  | {
      path: string;
      type: "directory";
    }
  | {
      path: string;
      type: "file";
      bytes: Uint8Array;
    };

function parseJsonPath(query: string): PathToken[] {
  const trimmed = query.trim();
  if (!trimmed || trimmed === ".") {
    return [];
  }
  let cursor = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
  const tokens: PathToken[] = [];
  while (cursor.length > 0) {
    if (cursor[0] === "[") {
      const close = cursor.indexOf("]");
      if (close === -1) {
        throw new Error(`Invalid JSON path: ${query}`);
      }
      tokens.push(Number(cursor.slice(1, close)));
      cursor = cursor.slice(close + 1);
      if (cursor.startsWith(".")) cursor = cursor.slice(1);
      continue;
    }
    const dot = cursor.search(/[.[\]]/);
    if (dot === -1) {
      tokens.push(cursor);
      break;
    }
    tokens.push(cursor.slice(0, dot));
    cursor = cursor.slice(dot);
    if (cursor.startsWith(".")) cursor = cursor.slice(1);
  }
  return tokens.filter((token) => token !== "");
}

function setJsonPathValue(
  root: unknown,
  tokens: PathToken[],
  value: unknown
): void {
  if (tokens.length === 0) {
    throw new Error("JSON update path must not be empty");
  }
  let current = root as Record<string, unknown> | unknown[];
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    if (typeof token === "number") {
      if (!Array.isArray(current)) {
        throw new Error(`JSON update expected array at [${token}]`);
      }
      if (current[token] === undefined) {
        current[token] = typeof nextToken === "number" ? [] : {};
      }
      current = current[token] as Record<string, unknown> | unknown[];
    } else {
      if (
        current === null ||
        typeof current !== "object" ||
        Array.isArray(current)
      ) {
        throw new Error(`JSON update expected object at "${token}"`);
      }
      if ((current as Record<string, unknown>)[token] === undefined) {
        (current as Record<string, unknown>)[token] =
          typeof nextToken === "number" ? [] : {};
      }
      current = (current as Record<string, unknown>)[token] as
        | Record<string, unknown>
        | unknown[];
    }
  }
  const finalToken = tokens[tokens.length - 1];
  if (typeof finalToken === "number") {
    if (!Array.isArray(current)) {
      throw new Error(`JSON update expected array at [${finalToken}]`);
    }
    current[finalToken] = value;
  } else {
    if (current === null || typeof current !== "object") {
      throw new Error(`JSON update expected object at "${finalToken}"`);
    }
    (current as Record<string, unknown>)[finalToken] = value;
  }
}

function deleteJsonPathValue(root: unknown, tokens: PathToken[]): void {
  if (tokens.length === 0) {
    throw new Error("JSON delete path must not be empty");
  }
  let current = root as Record<string, unknown> | unknown[];
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index];
    const next =
      typeof token === "number"
        ? (current as unknown[])[token]
        : (current as Record<string, unknown>)[token];
    current = next as Record<string, unknown> | unknown[];
    if (current === undefined) {
      return;
    }
  }
  const finalToken = tokens[tokens.length - 1];
  if (typeof finalToken === "number") {
    if (Array.isArray(current) && finalToken < current.length) {
      current.splice(finalToken, 1);
    }
  } else if (current && typeof current === "object") {
    delete (current as Record<string, unknown>)[finalToken];
  }
}

async function buildTreeNode(
  path: string,
  depth: number,
  maxDepth: number,
  ops: TreeOps
): Promise<StateTreeNode> {
  const stat = await ops.lstat(path);
  if (!stat) {
    throw new Error(`ENOENT: no such file or directory: ${path}`);
  }
  const node: StateTreeNode = {
    path,
    name: path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1),
    type: stat.type,
    size: stat.size
  };
  if (stat.type === "directory" && depth < maxDepth) {
    const entries = await ops.readdirWithFileTypes(path);
    node.children = [];
    for (const entry of entries) {
      const childPath = await ops.resolvePath(path, entry.name);
      node.children.push(
        await buildTreeNode(childPath, depth + 1, maxDepth, ops)
      );
    }
  }
  return node;
}

function summarizeNode(
  node: StateTreeNode,
  depth: number,
  summary: StateTreeSummary
): void {
  summary.maxDepth = Math.max(summary.maxDepth, depth);
  if (node.type === "file") {
    summary.files++;
    summary.totalBytes += node.size;
  } else if (node.type === "directory") {
    summary.directories++;
  } else {
    summary.symlinks++;
  }
  for (const child of node.children ?? []) {
    summarizeNode(child, depth + 1, summary);
  }
}

async function visitFind(
  path: string,
  root: string,
  depth: number,
  ops: TreeOps,
  options: StateFindOptions,
  pathMatcher: RegExp | null,
  nameMatcher: RegExp | null,
  types: Set<string> | null,
  results: StateFindEntry[]
): Promise<void> {
  const stat = await ops.lstat(path);
  if (!stat) return;
  const name = path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  if (
    matchesFind(
      path,
      name,
      depth,
      stat,
      options,
      pathMatcher,
      nameMatcher,
      types
    )
  ) {
    results.push({
      path,
      name,
      type: stat.type,
      depth,
      size: stat.size,
      mtime: stat.mtime
    });
  }
  if (stat.type === "directory") {
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    if (depth >= maxDepth) return;
    const entries = await ops.readdirWithFileTypes(path);
    for (const entry of entries) {
      const child = await ops.resolvePath(path, entry.name);
      await visitFind(
        child,
        root,
        depth + 1,
        ops,
        options,
        pathMatcher,
        nameMatcher,
        types,
        results
      );
    }
  }
}

function matchesFind(
  path: string,
  name: string,
  depth: number,
  stat: { type: string; size: number; mtime: Date },
  options: StateFindOptions,
  pathMatcher: RegExp | null,
  nameMatcher: RegExp | null,
  types: Set<string> | null
): boolean {
  if (depth < (options.minDepth ?? 0)) return false;
  if (types && !types.has(stat.type)) return false;
  if (pathMatcher && !pathMatcher.test(path)) return false;
  if (nameMatcher && !nameMatcher.test(name)) return false;
  if (options.sizeMin !== undefined && stat.size < options.sizeMin)
    return false;
  if (options.sizeMax !== undefined && stat.size > options.sizeMax)
    return false;
  if (options.mtimeAfter && stat.mtime <= new Date(options.mtimeAfter))
    return false;
  if (options.mtimeBefore && stat.mtime >= new Date(options.mtimeBefore))
    return false;
  if (options.empty === true && !(stat.type === "directory" || stat.size === 0))
    return false;
  return true;
}

async function transformBytes(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const input = new Blob([new Uint8Array(bytes)]).stream();
  const transformed = input.pipeThrough(stream);
  const chunks: Uint8Array[] = [];
  const reader = transformed.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function createTarHeader(entry: TarInputEntry): Uint8Array {
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.type === "directory" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(
    header,
    124,
    12,
    entry.type === "file" ? entry.bytes.byteLength : 0
  );
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  for (let i = 148; i < 156; i++) header[i] = 32;
  header[156] =
    entry.type === "directory" ? "5".charCodeAt(0) : "0".charCodeAt(0);
  writeAscii(header, 257, 6, "ustar");
  writeAscii(header, 263, 2, "00");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

const GZIP_MAGIC = [0x1f, 0x8b];
const ZIP_LOCAL_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06];
const KNOWN_NON_ARCHIVES: Array<[number[], string]> = [
  [[0x25, 0x50, 0x44, 0x46], "a PDF document"],
  [
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    "a legacy Office (OLE) document"
  ],
  [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], "a 7z archive"],
  [[0x52, 0x61, 0x72, 0x21], "a RAR archive"],
  [[0x42, 0x5a, 0x68], "a bzip2 file"],
  [[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], "an xz file"],
  [[0x28, 0xb5, 0x2f, 0xfd], "a Zstandard file"]
];

function startsWithBytes(bytes: Uint8Array, magic: number[]): boolean {
  return (
    bytes.byteLength >= magic.length &&
    magic.every((byte, index) => bytes[index] === byte)
  );
}

/** A tar stream opens with a checksummed header, or with the zero end block. */
function isTar(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 512) return false;
  const header = bytes.subarray(0, 512);
  return header.every((byte) => byte === 0) || tarChecksumMatches(header);
}

/** POSIX sums unsigned bytes; some historic writers summed signed ones. */
function tarChecksumMatches(header: Uint8Array): boolean {
  const stored = readOctal(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < 512; index++) {
    const byte = index >= 148 && index < 156 ? 32 : header[index];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function parseTar(archivePath: string, bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (!tarChecksumMatches(header)) {
      throw new Error(
        `${archivePath}: tar header at byte ${offset} fails its checksum`
      );
    }
    const path = readAscii(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 48);
    const type = typeFlag === "5" ? "directory" : "file";
    offset += 512;
    if (offset + size > bytes.byteLength) {
      throw new Error(`${archivePath}: tar entry ${path} is truncated`);
    }
    entries.push({
      path,
      type,
      bytes: new Uint8Array(bytes.subarray(offset, offset + size))
    });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP64_END_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_END_LENGTH = 22;

/**
 * Reads entries through the central directory, which carries final sizes and
 * CRCs even when an archiver streamed them into trailing data descriptors.
 */
async function parseZip(
  archivePath: string,
  bytes: Uint8Array
): Promise<ArchiveEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const end = findZipEnd(view);
  if (end === -1) {
    throw new Error(
      `${archivePath}: ZIP end of central directory not found; the archive is truncated`
    );
  }
  const count = u16(end + 10);
  const centralOffset = u32(end + 16);
  if (
    count === 0xffff ||
    centralOffset === 0xffffffff ||
    (end >= 20 && u32(end - 20) === ZIP64_END_LOCATOR_SIGNATURE)
  ) {
    throw new Error(`${archivePath}: ZIP64 archives are not supported`);
  }
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0) {
    throw new Error(
      `${archivePath}: multi-disk ZIP archives are not supported`
    );
  }

  const entries: ArchiveEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || u32(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error(`${archivePath}: ZIP central directory is corrupt`);
    }
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    const compressedSize = u32(cursor + 20);
    const size = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const localOffset = u32(cursor + 42);
    const name = decodeText(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    );
    cursor += 46 + nameLength + u16(cursor + 30) + u16(cursor + 32);

    if (name.endsWith("/")) {
      entries.push({
        path: name.slice(0, -1),
        type: "directory",
        bytes: new Uint8Array()
      });
      continue;
    }
    const entryError = (problem: string) =>
      new Error(`${archivePath}: ZIP entry ${name} ${problem}`);
    if (flags & 0x1) throw entryError("is encrypted");
    if (method !== 0 && method !== 8) {
      throw entryError(
        `uses compression method ${method}; only stored (0) and deflate (8) are supported`
      );
    }
    if (
      localOffset + 30 > bytes.byteLength ||
      u32(localOffset) !== ZIP_LOCAL_SIGNATURE
    ) {
      throw entryError("has no local header");
    }
    const dataStart =
      localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    if (dataStart + compressedSize > bytes.byteLength) {
      throw entryError("is truncated");
    }
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    let content: Uint8Array;
    try {
      content =
        method === 8
          ? await transformBytes(data, new DecompressionStream("deflate-raw"))
          : new Uint8Array(data);
    } catch (error) {
      throw entryError(
        `could not be inflated: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (content.byteLength !== size) {
      throw entryError(
        `holds ${content.byteLength} bytes; its directory record says ${size}`
      );
    }
    if (crc32(content) !== crc) throw entryError("failed its CRC-32 check");
    entries.push({ path: name, type: "file", bytes: content });
  }
  return entries;
}

/** The end record sits last, followed only by an archive comment of up to 64 KiB. */
function findZipEnd(view: DataView): number {
  const last = view.byteLength - ZIP_END_LENGTH;
  for (let offset = last; offset >= Math.max(0, last - 0xffff); offset--) {
    if (
      view.getUint32(offset, true) === ZIP_END_SIGNATURE &&
      offset + ZIP_END_LENGTH + view.getUint16(offset + 20, true) <=
        view.byteLength
    ) {
      return offset;
    }
  }
  return -1;
}

let crc32Table: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
      crc32Table[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeAscii(
  buffer: Uint8Array,
  offset: number,
  length: number,
  value: string
): void {
  const bytes = encodeText(value);
  buffer.set(bytes.subarray(0, length), offset);
}

function writeOctal(
  buffer: Uint8Array,
  offset: number,
  length: number,
  value: number
): void {
  const str = value.toString(8).padStart(length - 2, "0") + "\0 ";
  writeAscii(buffer, offset, length, str);
}

function readAscii(buffer: Uint8Array, offset: number, length: number): string {
  const value = decodeText(buffer.subarray(offset, offset + length));
  return value.split("\u0000", 1)[0].trim();
}

function readOctal(buffer: Uint8Array, offset: number, length: number): number {
  const text = readAscii(buffer, offset, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function getExtension(path: string): string | null {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? null : path.slice(idx + 1).toLowerCase();
}

function isLikelyText(bytes: Uint8Array): boolean {
  for (const byte of bytes.subarray(0, Math.min(bytes.length, 512))) {
    if (byte === 0) return false;
    if (byte < 9) return false;
  }
  return true;
}

function globToRegex(pattern: string): RegExp {
  let i = 0;
  let re = "^";
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          re += "(?:.+/)?";
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else {
      re += ch.replace(/[.+^$|\\()]/g, "\\$&");
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}
