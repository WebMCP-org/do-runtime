// Same dialect as @cloudflare/shell's helpers.ts and @cloudflare/computer; owned here so the package has no runtime dependency on Shell.

export function createGlobMatcher(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern)}$`);
}

function globSource(pattern: string): string {
  let i = 0;
  let re = "";
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
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i++;
      } else {
        re += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else {
      const group = ch === "{" ? braceAlternatives(pattern, i) : undefined;
      if (group) {
        re += `(?:${group.parts.map(globSource).join("|")})`;
        i = group.end + 1;
      } else {
        re += ch.replace(/[.+^$|\\(){}\]]/g, "\\$&");
        i++;
      }
    }
  }
  return re;
}

// Same dialect as @cloudflare/computer: a group needs a closing brace and at
// least one top-level comma, otherwise `{` is literal. ponytail: commas and
// braces inside a `[...]` class still count as brace syntax.
function braceAlternatives(
  pattern: string,
  open: number
): { parts: string[]; end: number } | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) {
        parts.push(pattern.slice(start, i));
        return parts.length > 1 ? { parts, end: i } : undefined;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  return undefined;
}

export function getGlobPrefix(pattern: string): string {
  const first = pattern.search(/[*?[{]/);
  if (first === -1) return pattern;
  const before = pattern.slice(0, first);
  const lastSlash = before.lastIndexOf("/");
  return lastSlash >= 0 ? before.slice(0, lastSlash + 1) : "/";
}
