/**
 * ← workerd `src/workerd/server/facet-tree-index.{h,c++}`
 *
 * Upstream's own summary: "Implements an index, stored on disk, which maps
 * leaves of a tree to small integers in a stable way." One facet — id zero — is
 * the root; every other facet has a parent and a name, names are unique among
 * siblings but not globally, and each (parent, name) pair is assigned the next
 * sequential id the first time it is seen. Deleting a facet does not release its
 * id: recreating the same name under the same parent gets the same id back,
 * which is what decision 14 means by "stable ids across delete-and-recreate."
 *
 * The whole index is held in memory, loaded at construction, because upstream
 * assumes "the total number of facets created for a single Durable Object over
 * its entire lifetime will never be very large" (`facet-tree-index.h:19-22`).
 * That is what makes the file append-only, and the append-only format is what
 * makes a torn tail safe to discard: an entry written but not synced cannot have
 * been relied on, so a nonsensical entry ends the read and the remainder is
 * truncated away.
 *
 * **The one seam: `kj::File` becomes `IndexFile`.** Upstream takes a
 * `kj::Own<const kj::File>` and calls exactly four members on it —
 * `readAllBytes`, `write`, `truncate` and `datasync`. There is no `kj/filesystem`
 * port and no reason to build one for four methods, so those four become an
 * interface and `server/` supplies it. Every method is synchronous because every
 * method upstream is, and because `facets.get` is synchronous all the way down;
 * both substrates can answer that (`FileSystemSyncAccessHandle` in a worker,
 * `node:fs`'s sync family), which is the same shape the storage backends already
 * take.
 *
 * **A name is its UTF-8 bytes, not its JS string.** Upstream's names are
 * `kj::String`s, so the on-disk bytes *are* the identity and the ordering.
 * `TextEncoder` is not injective on JS strings — every lone surrogate encodes to
 * U+FFFD — so keying this index by the JS string would let two distinct names
 * collide on disk and share one facet's storage file after a reload. Entries are
 * therefore identified and ordered by their encoded bytes, and `forEachChild`
 * reports the round-tripped name, which is what a reload would report. That also
 * makes the ordering exact: upstream's `kj::TreeSet` orders by `kj::String`'s
 * byte comparison, where JS `<` would order by UTF-16 code unit and disagree for
 * any name mixing astral characters with U+E000..U+FFFF.
 *
 * **The scaffolding recorded a divergence here that is wrong, and it is not
 * kept.** That header said workerd keeps one index per root actor while "our tree
 * spans workers, so each parent indexes its direct children." Upstream's index
 * already *is* keyed by (parent, name) — `getId(parent, name)`,
 * `forEachChild(parentId, …)` — so a per-parent index changes nothing about what
 * is indexed and only changes what an id *means*: upstream's ids are sequential
 * across the whole tree, and they name storage files in one flat namespace,
 * `<actor-id>.<facetId>.sqlite` (`server.c++:2737-2743`). Per-parent counters
 * would mint id 1 under every parent and collide those files. Nor does the
 * premise hold: the index is owned by the root *container*, not by an actor's
 * worker (`server.c++:2680-2681`, `:2697`), and `FacetHost` already speaks a flat
 * `FacetId = number` with a precomputed subtree — which only a whole-tree index
 * can produce. Ported as upstream has it.
 *
 * Spec: §1.10, decision 14 in docs/decisions.md.
 */

/**
 * ← the `kj::File` members `FacetTreeIndex` calls, and nothing else.
 *
 * `datasync()` is not decoration: the format's recovery story is that an entry
 * which was written but never synced was never relied upon, so a substrate that
 * drops it turns a torn tail from "discard and reassign" into "two facets, one
 * id".
 */
export interface IndexFile {
  /** ← `kj::File::readAllBytes()`. Called once, at construction. */
  readAllBytes(): Uint8Array;
  /** ← `kj::File::write(offset, data)`. Extends the file when it writes past the end. */
  write(offset: number, data: Uint8Array): void;
  /** ← `kj::File::truncate(size)`. Only ever shrinks, to drop a corrupted tail. */
  truncate(size: number): void;
  /** ← `kj::File::datasync()`. */
  datasync(): void;
}

/**
 * ← `FacetTreeIndex::MAGIC_NUMBER` (`facet-tree-index.h:116`). Upstream writes it
 * "in host byte order (which is little-endian on all supported platforms)", so
 * every integer in the format is read and written little-endian here.
 */
const MAGIC_NUMBER = 0xc4cd_ce5b_c5b0_ef57n;

/** The magic number's width, which is also the offset of the first entry. */
const MAGIC_LENGTH = 8;

/** ← `FacetTreeIndex::MAX_ID` — `static_cast<uint16_t>(kj::maxValue)`. */
const MAX_ID = 0xffff;

/** ← `sizeof(FacetTreeIndex::EntryHeader)`: two `uint16_t`s, parent id then name length. */
const ENTRY_HEADER_LENGTH = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A byte sequence as one code unit per byte, which makes it both a byte-exact
 * `Map` key and a byte-lexicographic sort key: JS compares strings by UTF-16 code
 * unit, and over 0..255 that is byte order, with a common prefix sorting first
 * exactly as `memcmp` leaves it.
 */
function byteString(bytes: Uint8Array): string {
  let out = "";
  // Chunked because String.fromCharCode is variadic and a name may be 65535
  // bytes long, which is more arguments than a call is guaranteed to accept.
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return out;
}

/** ← `FacetTreeIndex::Entry`, plus the encoded form upstream gets for free from `kj::String`. */
type Entry = {
  readonly parent: number;
  /** The decoded name, which is what a reload of this file would produce. */
  readonly name: string;
  /** Byte identity and sort key — see the header on why the JS string is neither. */
  readonly nameKey: string;
};

/** ← `FacetTreeIndex` (`facet-tree-index.h:50-123`). */
export class FacetTreeIndex {
  readonly #file: IndexFile;

  /**
   * ← `FacetTreeIndex::offset`. "Offset at which to write the next entry.
   * Typically points to the end of the file (except when a corrupted tail was
   * detected)."
   */
  #offset = 0;

  /**
   * ← `kj::TreeSet<Entry> entries`, split into the two things that set was doing
   * at once. The array is upstream's insertion order — "there's no need to store
   * the ID of each entry since they are strictly ordered with no erasures", so
   * index + 1 is the id — and the map is the (parent, name) lookup the tree
   * ordering provided. Sorting moves to `forEachChild`, which is the only reader
   * that wants it.
   */
  readonly #entries: Entry[] = [];
  readonly #byKey = new Map<string, number>();

  /**
   * ← the constructor (`facet-tree-index.c++:11-86`). "Construct the index,
   * reading the given file to populate the initial index, and then arranging to
   * append new entries to the file as needed."
   */
  constructor(file: IndexFile) {
    this.#file = file;

    // Read the file to populate the initial index
    const fileBytes = file.readAllBytes();

    // Check if the magic number is present.
    //
    // If the file size is less than or equal to the magic number size itself, it's possible that a
    // previous session suffered a failure while writing the magic number. In that case we can assume
    // nothing was ever written to the index, so we just rewrite it and start over.
    if (fileBytes.length <= MAGIC_LENGTH) {
      // New file, initialize with magic number.
      const magic = new Uint8Array(MAGIC_LENGTH);
      new DataView(magic.buffer).setBigUint64(0, MAGIC_NUMBER, true);
      file.write(0, magic);
      file.datasync();
      this.#offset = MAGIC_LENGTH;
      return;
    }

    const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);

    // On the other hand, because we datasync() immediately after writing the magic number, we can
    // assume that if _more_ bytes are written than just the magic number, then a failure did _not_
    // occurr during the writing of the magic number, and therefore, if it contains the wrong bytes,
    // the file must be in a format we don't recognize.
    if (view.getBigUint64(0, true) !== MAGIC_NUMBER) {
      throw new Error("unknown magic number on facet tree index");
    }
    this.#offset = MAGIC_LENGTH;

    // Read entries
    while (this.#offset + ENTRY_HEADER_LENGTH <= fileBytes.length) {
      if (this.#nextId() > MAX_ID) throw new Error("Maximum number of facets exceeded");

      const parentId = view.getUint16(this.#offset, true);
      const nameLength = view.getUint16(this.#offset + 2, true);

      // Validation checks
      if (nameLength === 0) {
        // Empty name is invalid.
        break;
      }

      if (this.#offset + ENTRY_HEADER_LENGTH + nameLength > fileBytes.length) {
        // Name extends beyond file bounds, invalid.
        break;
      }

      if (parentId >= this.#nextId()) {
        // Invalid parent ID (parent must already exist).
        break;
      }

      // Extract the name
      const nameBytes = fileBytes.subarray(
        this.#offset + ENTRY_HEADER_LENGTH,
        this.#offset + ENTRY_HEADER_LENGTH + nameLength,
      );
      const nameKey = byteString(nameBytes);

      if (this.#byKey.has(`${parentId}:${nameKey}`)) {
        // Duplicate entry is invalid.
        break;
      }
      this.#append({ parent: parentId, name: decoder.decode(nameBytes), nameKey });

      // Entry was valid and processed successfully, now we can update the offset
      this.#offset += ENTRY_HEADER_LENGTH + nameLength;
    }

    if (this.#offset < fileBytes.length) {
      // It appears we stopped at a corrupted entry. We assume such corruption can only be the result
      // of a power failure in the middle of writing an entry during a past session. Any entry which
      // was written but not synced can be presumed to have never been used, so we can simply
      // truncate it from the file.
      file.truncate(this.#offset);
    }
  }

  /** ← `FacetTreeIndex::getId`. "Gets the ID for the given facet, assigning it if needed." */
  getId(parent: number, name: string): number {
    const nameBytes = encoder.encode(name);
    if (nameBytes.length === 0) throw new Error("Facet name cannot be empty");
    if (nameBytes.length > MAX_ID) throw new Error("Facet name too long");
    if (parent > this.#entries.length) throw new Error("Invalid parent ID");

    const nameKey = byteString(nameBytes);
    const key = `${parent}:${nameKey}`;

    // Use findOrCreate to either find an existing entry or create a new one
    const found = this.#byKey.get(key);
    if (found !== undefined) return found + 1;

    // New entry, need to assign a new ID and append to file
    if (this.#nextId() > MAX_ID) throw new Error("Maximum number of facets exceeded");

    // Prepare entry data
    const entrySize = ENTRY_HEADER_LENGTH + nameBytes.length;
    const entryData = new Uint8Array(entrySize);
    const header = new DataView(entryData.buffer);
    header.setUint16(0, parent, true);
    header.setUint16(2, nameBytes.length, true);
    entryData.set(nameBytes, ENTRY_HEADER_LENGTH);

    this.#file.write(this.#offset, entryData);

    // We don't want to return an entry that might disappear after a power failure, so sync it
    // now.
    this.#file.datasync();

    this.#offset += entrySize;

    // Calculate the ID based on the entry's position in the set
    // Root facet (ID 0) isn't in the entries set, so add 1 to the index
    return this.#append({ parent, name: decoder.decode(nameBytes), nameKey }) + 1;
  }

  /**
   * ← `FacetTreeIndex::forEachChild`. "For each child of the given parent ID,
   * call the callback."
   *
   * Upstream walks a `kj::TreeSet` range, so children arrive ordered by name
   * rather than by id; the sort here is that ordering, over the same bytes.
   */
  forEachChild(parentId: number, callback: (childId: number, name: string) => void): void {
    const children: { id: number; entry: Entry }[] = [];
    this.#entries.forEach((entry, index) => {
      if (entry.parent === parentId) children.push({ id: index + 1, entry });
    });
    children.sort((a, b) => (a.entry.nameKey < b.entry.nameKey ? -1 : 1));
    for (const child of children) callback(child.id, child.entry.name);
  }

  /** ← `FacetTreeIndex::nextId`. "Off-by-one due to root not being in the set." */
  #nextId(): number {
    return this.#entries.length + 1;
  }

  /** Adds one entry in insertion order and returns its index, which is its id minus one. */
  #append(entry: Entry): number {
    const index = this.#entries.length;
    this.#entries.push(entry);
    this.#byKey.set(`${entry.parent}:${entry.nameKey}`, index);
    return index;
  }
}
