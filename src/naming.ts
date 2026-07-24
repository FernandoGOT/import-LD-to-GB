export const FLAG_NAMING_CONVENTIONS = [
  "kebab-case",
  "snake_case",
  "camelCase",
  "PascalCase",
  "preserve",
] as const;

export type FlagNamingConvention = (typeof FLAG_NAMING_CONVENTIONS)[number];

export function isFlagNamingConvention(
  value: string,
): value is FlagNamingConvention {
  return (FLAG_NAMING_CONVENTIONS as readonly string[]).includes(value);
}

/** Split identifiers on case boundaries, underscores, hyphens, and whitespace. */
export function splitIdentifierParts(input: string): string[] {
  const normalized = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim();
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

export function applyNamingConvention(
  key: string,
  convention: FlagNamingConvention,
): string {
  if (convention === "preserve") return key;

  const parts = splitIdentifierParts(key);
  if (parts.length === 0) return key;

  switch (convention) {
    case "kebab-case":
      return parts.map((part) => part.toLowerCase()).join("-");
    case "snake_case":
      return parts.map((part) => part.toLowerCase()).join("_");
    case "camelCase":
      return parts
        .map((part, index) => {
          const lower = part.toLowerCase();
          if (index === 0) return lower;
          return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join("");
    case "PascalCase":
      return parts
        .map((part) => {
          const lower = part.toLowerCase();
          return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join("");
  }
}
