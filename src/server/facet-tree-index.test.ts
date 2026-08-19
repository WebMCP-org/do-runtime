/**
 * ← workerd `src/workerd/server/facet-tree-index-test.c++`, all five `KJ_TEST`s.
 *
 * Upstream's fixture is `kj::newInMemoryFile(kj::nullClock())`, handed to each
 * `FacetTreeIndex` through `file->clone()` so several indexes in a row share one
 * byte array. `newInMemoryIndexFile()` below is that, on this package's
 * `IndexFile` seam: the same object is passed to each index rather than cloned,
 * because a JS reference already is what `kj::Own<const kj::File>::clone()`
 * produces for an in-memory file.
 */

import { describe, expect, test } from "vitest";
import { FacetTreeIndex, type IndexFile } from "./facet-tree-index";

type InMemoryIndexFile = IndexFile & { readonly size: number; readonly datasyncs: number };

/**
 * ← `kj::newInMemoryFile(kj::nullClock())`, restricted to the four members
 * `IndexFile` names. Capacity grows geometrically, as kj's does, so the
 * 65535-entry limit test is not quadratic in the number of appends.
 */
function newInMemoryIndexFile(): InMemoryIndexFile {
  let buffer = new Uint8Array(64);
  let size = 0;
  let datasyncs = 0;

  function reserve(needed: number): void {
    if (needed <= buffer.length) return;
    let capacity = buffer.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(buffer.subarray(0, size));
    buffer = grown;
  }

  return {
    get size() {
      return size;
    },
    get datasyncs() {
      return datasyncs;
    },
    readAllBytes() {
      return buffer.slice(0, size);
    },
    write(offset: number, data: Uint8Array) {
      // kj's in-memory file zero-fills a gap and grows on a write past the end.
      reserve(offset + data.length);
      if (offset > size) buffer.fill(0, size, offset);
      buffer.set(data, offset);
      size = Math.max(size, offset + data.length);
    },
    truncate(newSize: number) {
      reserve(newSize);
      if (newSize > size) buffer.fill(0, size, newSize);
      else buffer.fill(0, newSize, size);
      size = newSize;
    },
    datasync() {
      datasyncs += 1;
    },
  };
}

type ExpectedChildInfo = { id: number; name: string };

/** ← `expectChildren()` (`facet-tree-index-test.c++:18-30`). */
function expectChildren(
  index: FacetTreeIndex,
  parentId: number,
  expected: readonly ExpectedChildInfo[],
): void {
  const seen: ExpectedChildInfo[] = [];
  index.forEachChild(parentId, (id, name) => {
    seen.push({ id, name });
  });
  expect(seen).toEqual(expected);
}

const MAGIC_NUMBER = 0xc4cd_ce5b_c5b0_ef57n;
const MAGIC_LENGTH = 8;

/** The 8-byte little-endian magic number every valid index file opens with. */
function magicBytes(): Uint8Array {
  const bytes = new Uint8Array(MAGIC_LENGTH);
  new DataView(bytes.buffer).setBigUint64(0, MAGIC_NUMBER, true);
  return bytes;
}

/** One on-disk entry: parent id, name length, name — all little-endian. */
function entryBytes(parent: number, name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const bytes = new Uint8Array(4 + nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, parent, true);
  view.setUint16(2, nameBytes.length, true);
  bytes.set(nameBytes, 4);
  return bytes;
}

describe("FacetTreeIndex basic functionality", () => {
  test("FacetTreeIndex basic functionality", () => {
    const file = newInMemoryIndexFile();

    {
      // Test with new empty file
      const index = new FacetTreeIndex(file);

      // Get IDs for facets
      const id1 = index.getId(0, "facet1");
      const id2 = index.getId(0, "facet2");
      const id3 = index.getId(id1, "child1");
      const id4 = index.getId(id1, "child2");
      const id5 = index.getId(id2, "child1");

      // Check that IDs are assigned correctly
      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
      expect(id4).toBe(4);
      expect(id5).toBe(5);

      // Check that IDs are stable
      expect(index.getId(0, "facet1")).toBe(id1);
      expect(index.getId(0, "facet2")).toBe(id2);
      expect(index.getId(id1, "child1")).toBe(id3);
      expect(index.getId(id1, "child2")).toBe(id4);
      expect(index.getId(id2, "child1")).toBe(id5);

      // Test forEachChild().
      expectChildren(index, 0, [
        { id: 1, name: "facet1" },
        { id: 2, name: "facet2" },
      ]);
      expectChildren(index, 1, [
        { id: 3, name: "child1" },
        { id: 4, name: "child2" },
      ]);
      expectChildren(index, 2, [{ id: 5, name: "child1" }]);
      expectChildren(index, 3, []);
      expectChildren(index, 4, []);
      expectChildren(index, 5, []);
    }

    {
      // Test with existing file (persistence)
      const index = new FacetTreeIndex(file);

      // Check that IDs are the same as before
      expect(index.getId(0, "facet1")).toBe(1);
      expect(index.getId(0, "facet2")).toBe(2);
      expect(index.getId(1, "child1")).toBe(3);
      expect(index.getId(1, "child2")).toBe(4);
      expect(index.getId(2, "child1")).toBe(5);

      // Add some new facets
      const id6 = index.getId(3, "grandchild1");
      const id7 = index.getId(3, "grandchild2");

      expect(id6).toBe(6);
      expect(id7).toBe(7);

      expectChildren(index, 0, [
        { id: 1, name: "facet1" },
        { id: 2, name: "facet2" },
      ]);
      expectChildren(index, 1, [
        { id: 3, name: "child1" },
        { id: 4, name: "child2" },
      ]);
      expectChildren(index, 2, [{ id: 5, name: "child1" }]);
      expectChildren(index, 3, [
        { id: 6, name: "grandchild1" },
        { id: 7, name: "grandchild2" },
      ]);
      expectChildren(index, 4, []);
      expectChildren(index, 5, []);
      expectChildren(index, 6, []);
      expectChildren(index, 7, []);
    }

    {
      // Test again with existing file
      const index = new FacetTreeIndex(file);

      // Check all IDs were preserved
      expect(index.getId(0, "facet1")).toBe(1);
      expect(index.getId(0, "facet2")).toBe(2);
      expect(index.getId(1, "child1")).toBe(3);
      expect(index.getId(1, "child2")).toBe(4);
      expect(index.getId(2, "child1")).toBe(5);
      expect(index.getId(3, "grandchild1")).toBe(6);
      expect(index.getId(3, "grandchild2")).toBe(7);

      expectChildren(index, 0, [
        { id: 1, name: "facet1" },
        { id: 2, name: "facet2" },
      ]);
      expectChildren(index, 1, [
        { id: 3, name: "child1" },
        { id: 4, name: "child2" },
      ]);
      expectChildren(index, 2, [{ id: 5, name: "child1" }]);
      expectChildren(index, 3, [
        { id: 6, name: "grandchild1" },
        { id: 7, name: "grandchild2" },
      ]);
      expectChildren(index, 4, []);
      expectChildren(index, 5, []);
      expectChildren(index, 6, []);
      expectChildren(index, 7, []);
    }
  });
});

describe("FacetTreeIndex error handling", () => {
  test("FacetTreeIndex error handling", () => {
    const file = newInMemoryIndexFile();
    const index = new FacetTreeIndex(file);

    // Add some initial facets
    index.getId(0, "facet1");
    index.getId(0, "facet2");

    // Test error cases

    // Empty name
    expect(() => index.getId(0, "")).toThrow("Facet name cannot be empty");

    // Invalid parent
    expect(() => index.getId(999, "child")).toThrow("Invalid parent ID");

    // Same name but different parents should get different IDs
    const id1 = index.getId(1, "sameName");
    const id2 = index.getId(2, "sameName");
    expect(id1).not.toBe(id2);

    // Test name uniqueness per parent
    const id3 = index.getId(1, "sameName");
    expect(id3).toBe(id1);
  });
});

describe("FacetTreeIndex corruption handling", () => {
  test("FacetTreeIndex corruption handling", () => {
    const file = newInMemoryIndexFile();

    // Create a file with corrupted data
    {
      // Write valid header and some valid entries
      file.write(0, magicBytes());

      // Write valid entry: parent=0, name="valid"
      const entry = entryBytes(0, "valid");
      file.write(8, entry);

      // Write corrupted entry: parent=999 (invalid), name="corrupt"
      const badEntry = entryBytes(999, "corrupt");
      file.write(8 + entry.length, badEntry);

      // Write valid entry after corruption that should be ignored
      const ignoredEntry = entryBytes(0, "ignored");
      file.write(8 + entry.length + badEntry.length, ignoredEntry);
    }

    // Open corrupted file
    {
      const index = new FacetTreeIndex(file);

      // Check that only valid entries were read
      expect(index.getId(0, "valid")).toBe(1);

      // The corrupted entry and everything after it should have been ignored
      // So this should create a new entry
      const id = index.getId(0, "corrupt");
      expect(id).toBe(2);

      // Similarly, "ignored" should be new
      const id2 = index.getId(0, "ignored");
      expect(id2).toBe(3);
    }

    // Open yet again, make sure that the newly-added entries were written successfully.
    {
      const index = new FacetTreeIndex(file);
      expect(index.getId(0, "valid")).toBe(1);
      expect(index.getId(0, "corrupt")).toBe(2);
      expect(index.getId(0, "ignored")).toBe(3);
    }
  });
});

describe("FacetTreeIndex tree structure", () => {
  test("FacetTreeIndex tree structure", () => {
    const file = newInMemoryIndexFile();

    const index = new FacetTreeIndex(file);

    // Build a tree with multiple levels
    const id1 = index.getId(0, "root1");
    const id2 = index.getId(0, "root2");

    const id3 = index.getId(id1, "level1_1");
    const id4 = index.getId(id1, "level1_2");
    const id5 = index.getId(id2, "level1_3");

    const id6 = index.getId(id3, "level2_1");
    const id7 = index.getId(id3, "level2_2");
    const id8 = index.getId(id4, "level2_3");

    const id9 = index.getId(id6, "level3_1");

    // Verify IDs
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(id3).toBe(3);
    expect(id4).toBe(4);
    expect(id5).toBe(5);
    expect(id6).toBe(6);
    expect(id7).toBe(7);
    expect(id8).toBe(8);
    expect(id9).toBe(9);

    // Verify stable lookup
    expect(index.getId(id1, "level1_1")).toBe(id3);
    expect(index.getId(id3, "level2_1")).toBe(id6);
    expect(index.getId(id6, "level3_1")).toBe(id9);
  });
});

describe("FacetTreeIndex handles truncated files correctly", () => {
  test("FacetTreeIndex handles truncated files correctly", () => {
    const file = newInMemoryIndexFile();

    // Step 1: Create a file with a few entries
    {
      const index = new FacetTreeIndex(file);
      const id1 = index.getId(0, "entry1");
      const id2 = index.getId(0, "entry2");
      const id3 = index.getId(0, "entry3");

      expect(id1).toBe(1);
      expect(id2).toBe(2);
      expect(id3).toBe(3);
    }

    // Step 2: Corrupt the last entry by overwriting its nameLength field with an invalid large value
    const fileSize = file.size;
    // Go to the nameLength field of the last entry (2 bytes before "entry3")
    const offset = fileSize - 8;

    // Write an impossibly large nameLength value
    const hugeNameLength = new Uint8Array(2);
    new DataView(hugeNameLength.buffer).setUint16(0, 65000, true);
    file.write(offset, hugeNameLength);

    // Step 3: Re-read the index and add a new entry
    {
      const index = new FacetTreeIndex(file);

      // First two entries should still be valid
      expect(index.getId(0, "entry1")).toBe(1);
      expect(index.getId(0, "entry2")).toBe(2);

      // The corrupted entry (entry3) should not be found, so this new entry
      // should get the ID 3 (reusing the ID that was intended for entry3)
      const id = index.getId(0, "replacement");
      expect(id).toBe(3);
    }

    // Step 4: Re-read the file again and add yet another new entry
    {
      const index = new FacetTreeIndex(file);

      // Immediately get a new entry, without checking existing ones first
      // This should get ID 4, not reuse ID 3 again
      const id = index.getId(0, "another");

      // Now check that all previous entries are remembered
      expect(id).toBe(4);
      expect(index.getId(0, "entry1")).toBe(1);
      expect(index.getId(0, "entry2")).toBe(2);
      expect(index.getId(0, "replacement")).toBe(3);
    }
  });
});

/**
 * Built from code points rather than written as literals: three of the four are
 * invisible in a source file, and one of them cannot survive a round trip
 * through UTF-8 at all, which is the point of the tests below.
 */
const LONE_SURROGATE = String.fromCharCode(0xd800);
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
const PRIVATE_USE_E000 = String.fromCharCode(0xe000);
const ASTRAL = String.fromCodePoint(0x10000);

/**
 * Cases upstream cannot have, because a `kj::String` is already bytes and a JS
 * string is not.
 */
describe("FacetTreeIndex identifies a name by its UTF-8 bytes", () => {
  test("two JS strings that encode identically are one facet", () => {
    const file = newInMemoryIndexFile();
    const index = new FacetTreeIndex(file);

    // A lone surrogate is not encodable, and TextEncoder substitutes U+FFFD for
    // it. Both names therefore reach the file as the same three bytes, so they
    // have to be the same entry — anything else gives two facets one storage
    // file the moment the index is reloaded.
    const loneSurrogate = index.getId(0, LONE_SURROGATE);
    expect(index.getId(0, REPLACEMENT_CHARACTER)).toBe(loneSurrogate);

    // And the name reported is the one a reload would report.
    const names: string[] = [];
    index.forEachChild(0, (_id, name) => names.push(name));
    expect(names).toEqual([REPLACEMENT_CHARACTER]);

    const reopened = new FacetTreeIndex(file);
    expect(reopened.getId(0, LONE_SURROGATE)).toBe(loneSurrogate);
  });

  test("forEachChild orders by UTF-8 byte, not by UTF-16 code unit", () => {
    const file = newInMemoryIndexFile();
    const index = new FacetTreeIndex(file);

    // U+10000 encodes to f0 90 80 80 and U+E000 to ee 80 80, so bytes order the
    // astral name second. JS `<` sees its lead surrogate U+D800 and would order
    // it first.
    const astral = index.getId(0, ASTRAL);
    const privateUse = index.getId(0, PRIVATE_USE_E000);
    expect(astral).toBe(1);
    expect(privateUse).toBe(2);

    expectChildren(index, 0, [
      { id: 2, name: PRIVATE_USE_E000 },
      { id: 1, name: ASTRAL },
    ]);
  });

  test("the length bound is bytes, so a 32768-character name can be too long", () => {
    const index = new FacetTreeIndex(newInMemoryIndexFile());

    // 65535 bytes is the longest name the two-byte length field can describe.
    expect(index.getId(0, "x".repeat(65535))).toBe(1);
    expect(() => index.getId(0, "x".repeat(65536))).toThrow("Facet name too long");

    // Two bytes each, so half as many characters trips the same bound.
    expect(() => index.getId(0, "é".repeat(32768))).toThrow("Facet name too long");
    expect(index.getId(0, "é".repeat(32767))).toBe(2);
  });
});

/** Branches upstream has but `facet-tree-index-test.c++` does not reach. */
describe("FacetTreeIndex file validation", () => {
  test("a file longer than the magic number with the wrong magic is refused", () => {
    const file = newInMemoryIndexFile();
    file.write(0, new Uint8Array(16));

    expect(() => new FacetTreeIndex(file)).toThrow("unknown magic number on facet tree index");
  });

  test("a file no longer than the magic number is assumed to be a torn create", () => {
    const file = newInMemoryIndexFile();
    // Eight wrong bytes, which is exactly the boundary: a previous session may
    // have died partway through writing the magic number, so it is rewritten
    // rather than refused.
    file.write(0, new Uint8Array(MAGIC_LENGTH));

    const index = new FacetTreeIndex(file);
    expect(index.getId(0, "first")).toBe(1);

    // The magic number it rewrote has to be the real one.
    expect(new FacetTreeIndex(file).getId(0, "first")).toBe(1);
  });

  test("an entry with an empty name ends the read", () => {
    const file = newInMemoryIndexFile();
    file.write(0, magicBytes());
    file.write(MAGIC_LENGTH, entryBytes(0, "valid"));
    file.write(MAGIC_LENGTH + 9, entryBytes(0, ""));
    file.write(MAGIC_LENGTH + 9 + 4, entryBytes(0, "ignored"));

    const index = new FacetTreeIndex(file);
    expect(index.getId(0, "valid")).toBe(1);
    expect(index.getId(0, "ignored")).toBe(2);
  });

  test("a duplicate entry ends the read", () => {
    const file = newInMemoryIndexFile();
    file.write(0, magicBytes());
    file.write(MAGIC_LENGTH, entryBytes(0, "valid"));
    file.write(MAGIC_LENGTH + 9, entryBytes(0, "valid"));
    file.write(MAGIC_LENGTH + 18, entryBytes(0, "ignored"));

    const index = new FacetTreeIndex(file);
    expect(index.getId(0, "valid")).toBe(1);
    expect(index.getId(0, "ignored")).toBe(2);
  });

  test("a corrupted tail is truncated away rather than left to be re-read", () => {
    const file = newInMemoryIndexFile();
    file.write(0, magicBytes());
    file.write(MAGIC_LENGTH, entryBytes(0, "valid"));
    file.write(MAGIC_LENGTH + 9, entryBytes(999, "corrupt"));

    new FacetTreeIndex(file);
    expect(file.size).toBe(MAGIC_LENGTH + 9);
  });

  test("every entry is synced before its id is handed out", () => {
    const file = newInMemoryIndexFile();

    const index = new FacetTreeIndex(file);
    // One for the magic number the constructor wrote.
    expect(file.datasyncs).toBe(1);

    index.getId(0, "first");
    expect(file.datasyncs).toBe(2);

    // A name already in the index writes nothing, so it syncs nothing.
    index.getId(0, "first");
    expect(file.datasyncs).toBe(2);
  });

  test("a reopened index remembers the tree before it is asked for any name", () => {
    const file = newInMemoryIndexFile();
    {
      const index = new FacetTreeIndex(file);
      index.getId(0, "parent");
      index.getId(1, "child1");
      index.getId(1, "child2");
    }

    // Read straight out of the file. Upstream's own tests call getId() for every
    // name first, which re-assigns the same ids in the same order and so cannot
    // distinguish a remembered entry from a re-created one.
    const reopened = new FacetTreeIndex(file);
    expectChildren(reopened, 0, [{ id: 1, name: "parent" }]);
    expectChildren(reopened, 1, [
      { id: 2, name: "child1" },
      { id: 3, name: "child2" },
    ]);
    expect(file.size).toBe(MAGIC_LENGTH + (4 + 6) + (4 + 6) + (4 + 6));
  });

  test("an entry claiming the id it would itself receive ends the read", () => {
    const file = newInMemoryIndexFile();
    file.write(0, magicBytes());
    file.write(MAGIC_LENGTH, entryBytes(0, "valid"));
    // Its parent is 2, and 2 is the id this very entry would be given: a parent
    // has to already exist, so this is corruption rather than a forward
    // reference.
    file.write(MAGIC_LENGTH + 9, entryBytes(2, "selfparent"));

    const index = new FacetTreeIndex(file);
    expect(index.getId(0, "valid")).toBe(1);
    expect(index.getId(0, "next")).toBe(2);
    expectChildren(index, 2, []);
  });

  test("a parent id one past the last assigned one is refused", () => {
    const index = new FacetTreeIndex(newInMemoryIndexFile());

    index.getId(0, "facet1");
    // The most recently assigned id is a legal parent...
    expect(index.getId(1, "child")).toBe(2);
    // ...and the id that has not been assigned yet is not.
    expect(() => index.getId(3, "grandchild")).toThrow("Invalid parent ID");
    expect(index.getId(2, "grandchild")).toBe(3);
  });
});

describe("FacetTreeIndex enforces the format's 65535-facet ceiling", () => {
  test("the 65536th facet is refused, and so is a file that already holds one", () => {
    const file = newInMemoryIndexFile();
    const index = new FacetTreeIndex(file);

    for (let i = 1; i <= 65535; i++) index.getId(0, `f${i}`);
    expect(index.getId(0, "f65535")).toBe(65535);

    expect(() => index.getId(0, "one-too-many")).toThrow("Maximum number of facets exceeded");

    // The refusal happens before the write, so the file is still loadable.
    const sizeBeforeCorruption = file.size;
    expect(new FacetTreeIndex(file).getId(0, "f65535")).toBe(65535);

    // A file that somehow holds a 65536th entry is refused outright rather than
    // read up to the limit, which is upstream's KJ_REQUIRE inside the read loop.
    file.write(sizeBeforeCorruption, entryBytes(0, "one-too-many"));
    expect(() => new FacetTreeIndex(file)).toThrow("Maximum number of facets exceeded");

    // Including one whose name never made it to disk: the limit is checked once
    // per header the file has room for, before the header is even looked at.
    file.truncate(sizeBeforeCorruption + 4);
    expect(() => new FacetTreeIndex(file)).toThrow("Maximum number of facets exceeded");
  });
});
