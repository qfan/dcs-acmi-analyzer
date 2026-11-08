/**
 * Split an ACMI line on unescaped commas and unescape `\,` (and `\\`, defensively) in each field.
 * The spec documents only `\,`. A backslash before any other character is kept as-is so that
 * no text is lost.
 */
export function splitFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      const next = line[i + 1];
      if (next === "," || next === "\\") {
        cur += next;
        i++;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Split `Key=Value` at the first `=`. Returns null when there is no `=`. */
export function splitKeyValue(field: string): [string, string] | null {
  const eq = field.indexOf("=");
  if (eq <= 0) return null;
  return [field.slice(0, eq), field.slice(eq + 1)];
}

/** Object IDs are 64-bit hexadecimal. Keep them as normalised lowercase strings, never JS numbers. */
const HEX_ID = /^[0-9a-fA-F]{1,16}$/;
export function isObjectId(s: string): boolean {
  return HEX_ID.test(s);
}
