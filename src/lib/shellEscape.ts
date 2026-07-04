export function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
