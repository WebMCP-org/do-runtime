import { describe, expect, it } from "vitest";
import { createGlobMatcher, getGlobPrefix } from "../glob";

const matches = (pattern: string, path: string) =>
  createGlobMatcher(pattern).test(path);

describe("createGlobMatcher", () => {
  it("compiles globs inside brace alternatives", () => {
    const re = createGlobMatcher("{**/*.ts,**/*.md}");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("docs/b.md")).toBe(true);
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("a.js")).toBe(false);
    expect(matches("src/{*.ts,lib/?.js}", "src/x.ts")).toBe(true);
    expect(matches("src/{*.ts,lib/?.js}", "src/lib/a.js")).toBe(true);
    expect(matches("src/{*.ts,lib/?.js}", "src/lib/ab.js")).toBe(false);
  });

  it("handles nested braces", () => {
    const re = createGlobMatcher("a.{b,{c,d}x}");
    expect(re.test("a.b")).toBe(true);
    expect(re.test("a.cx")).toBe(true);
    expect(re.test("a.dx")).toBe(true);
    expect(re.test("a.c")).toBe(false);
  });

  it("escapes regex metacharacters in alternatives", () => {
    const re = createGlobMatcher("{a.b,c}");
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
    expect(re.test("c")).toBe(true);
    expect(matches("{a+,b(c)}", "a+")).toBe(true);
    expect(matches("{a+,b(c)}", "b(c)")).toBe(true);
  });

  it("treats unclosed and single-item braces literally", () => {
    expect(matches("{a,b", "{a,b")).toBe(true);
    expect(matches("{a,b", "a")).toBe(false);
    expect(matches("x{a}", "x{a}")).toBe(true);
    expect(matches("a}b]", "a}b]")).toBe(true);
  });

  it("keeps [...] classes and escapes an unclosed [", () => {
    expect(matches("[abc].ts", "b.ts")).toBe(true);
    expect(matches("[abc].ts", "d.ts")).toBe(false);
    expect(matches("[abc", "[abc")).toBe(true);
  });

  it("matches ? as one non-slash character", () => {
    expect(matches("a?c", "abc")).toBe(true);
    expect(matches("a?c", "a/c")).toBe(false);
    expect(matches("a?c", "ac")).toBe(false);
  });

  it("keeps **/ and ** semantics", () => {
    expect(matches("**/*.ts", "a.ts")).toBe(true);
    expect(matches("**/*.ts", "x/y/a.ts")).toBe(true);
    expect(matches("/src/**/*.ts", "/src/a.ts")).toBe(true);
    expect(matches("/src/**/*.ts", "/src/x/a.ts")).toBe(true);
    expect(matches("/src/**", "/src/x/a.ts")).toBe(true);
    expect(matches("/src/**", "/src/")).toBe(true);
    expect(matches("/src/*", "/src/x/a.ts")).toBe(false);
    expect(createGlobMatcher("**/").source).toBe("^(?:.+\\/)?$");
  });
});

describe("getGlobPrefix", () => {
  it("stops at the first glob character", () => {
    expect(getGlobPrefix("/src/{**/*.ts,**/*.md}")).toBe("/src/");
    expect(getGlobPrefix("/src/a.ts")).toBe("/src/a.ts");
  });
});
