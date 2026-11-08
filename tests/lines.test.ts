import { describe, expect, it } from "vitest";
import { splitFields, splitKeyValue } from "../src/acmi/fields.ts";
import { LineSplitter, type LogicalLine } from "../src/acmi/lines.ts";

function split(text: string | Uint8Array, chunkSize = 1) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const lines: LogicalLine[] = [];
  const s = new LineSplitter((l) => lines.push(l));
  for (let i = 0; i < bytes.length; i += chunkSize) s.push(bytes.subarray(i, i + chunkSize));
  return { lines, end: s.end() };
}

describe("LineSplitter", () => {
  it("strips the BOM and handles LF and CRLF", () => {
    const { lines, end } = split("﻿FileType=text/acmi/tacview\r\nFileVersion=2.2\n#0\n");
    expect(lines.map((l) => l.text)).toEqual(["FileType=text/acmi/tacview", "FileVersion=2.2", "#0"]);
    expect(end.incompleteTail).toBeNull();
  });

  it("keeps multi-byte UTF-8 intact across 1-byte chunks", () => {
    const { lines } = split("0,Title=古达乌塔vs库塔伊西\n", 1);
    expect(lines[0]?.text).toBe("0,Title=古达乌塔vs库塔伊西");
  });

  it("joins continuation lines (trailing backslash) as seen in DCS Comments", () => {
    // Real shape from the 2v1 ACM sample: text\ / \ / text
    const src = "0,Comments=first part.\\\n\\\nsecond part.\n0,ReferenceLongitude=39\n";
    const { lines } = split(src, 3);
    expect(lines).toEqual([
      { text: "0,Comments=first part.\n\nsecond part.", lineNo: 1 },
      { text: "0,ReferenceLongitude=39", lineNo: 4 },
    ]);
  });

  it("does not treat an escaped backslash at line end as a continuation", () => {
    const { lines } = split("0,Comments=ends with \\\\\n#1\n");
    expect(lines.map((l) => l.text)).toEqual(["0,Comments=ends with \\\\", "#1"]);
  });

  it("reports a final line without newline as an incomplete tail", () => {
    const { lines, end } = split("#42.16\n304,IAS=148\n#42");
    expect(lines.map((l) => l.text)).toEqual(["#42.16", "304,IAS=148"]);
    expect(end.incompleteTail).toEqual({ text: "#42", lineNo: 3 });
  });
});

describe("splitFields", () => {
  it("splits on unescaped commas and unescapes \\,", () => {
    expect(splitFields("0,Comments=in front of you\\, behind you\\, or to the side.,Foo=1")).toEqual([
      "0",
      "Comments=in front of you, behind you, or to the side.",
      "Foo=1",
    ]);
  });

  it("keeps empty T= components", () => {
    expect(splitFields("101,T=5.3|5.2|1997.6||5.2|92.8|503143.59|-297999.97|87.8,IAS=111")).toEqual([
      "101",
      "T=5.3|5.2|1997.6||5.2|92.8|503143.59|-297999.97|87.8",
      "IAS=111",
    ]);
  });

  it("splitKeyValue splits at the first =", () => {
    expect(splitKeyValue("Name=PILOT=ACES")).toEqual(["Name", "PILOT=ACES"]);
    expect(splitKeyValue("novalue")).toBeNull();
  });
});
