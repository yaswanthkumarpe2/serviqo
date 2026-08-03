type ClassValue = string | number | false | null | undefined;

/** Joins truthy class name fragments with a single space. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
