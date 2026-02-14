const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

export interface ParsedFrontmatter {
  [key: string]: string | string[];
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item).trim())
          .filter(Boolean);
      }
    } catch {
      const inner = trimmed.slice(1, -1);
      return inner
        .split(",")
        .map((item) => stripQuotes(item))
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return trimmed
    .split(",")
    .map((item) => stripQuotes(item))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return {};
  }

  const map: ParsedFrontmatter = {};
  let activeListKey: string | null = null;
  for (const line of match[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1].trim();
      const rawValue = keyMatch[2].trim();
      if (!key) {
        activeListKey = null;
        continue;
      }

      if (!rawValue) {
        map[key] = [];
        activeListKey = key;
        continue;
      }

      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        map[key] = parseInlineList(rawValue);
      } else {
        map[key] = stripQuotes(rawValue);
      }
      activeListKey = null;
      continue;
    }

    if (activeListKey) {
      const listMatch = line.match(/^\s*-\s*(.+)\s*$/);
      if (listMatch) {
        const current = Array.isArray(map[activeListKey]) ? [...(map[activeListKey] as string[])] : [];
        current.push(stripQuotes(listMatch[1]));
        map[activeListKey] = current;
        continue;
      }
      activeListKey = null;
    }
  }

  return map;
}

export function frontmatterString(frontmatter: ParsedFrontmatter, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

export function frontmatterList(frontmatter: ParsedFrontmatter, key: string): string[] {
  const value = frontmatter[key];
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return parseInlineList(value);
  }
  return [];
}
