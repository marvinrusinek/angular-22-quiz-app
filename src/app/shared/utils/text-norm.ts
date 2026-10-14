/** Normalize text for case-insensitive comparison. */
export function norm(t: any): string {
  return String(t ?? '')
    .trim()
    .toLowerCase();
}
