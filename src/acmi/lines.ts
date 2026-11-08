/**
 * Streaming UTF-8 → logical-line splitter for ACMI text.
 *
 * Handles:
 * - UTF-8 BOM (stripped by TextDecoder) and multi-byte characters split across chunks.
 * - LF and CRLF line endings.
 * - Continuation lines: a physical line ending in an odd number of backslashes continues on the next
 *   line. The final backslash is dropped and a "\n" is kept in the value. Seen in multi-paragraph
 *   `Comments=` values written by DCS2ACMI; the official spec does not document this.
 * - Truncated files: unfinished recordings end mid-line with no trailing newline. That last line is
 *   reported as incomplete rather than silently parsed.
 */

export interface LogicalLine {
  text: string;
  /** 1-based physical line number where this logical line starts. */
  lineNo: number;
}

export interface SplitterEnd {
  /** The final line had no terminating newline, so the file was probably cut off. */
  incompleteTail: LogicalLine | null;
}

export class LineSplitter {
  private readonly decoder = new TextDecoder("utf-8");
  private pending = "";
  private physicalLineNo = 0;
  private contText: string | null = null;
  private contStart = 0;
  private readonly onLine: (line: LogicalLine) => void;

  constructor(onLine: (line: LogicalLine) => void) {
    this.onLine = onLine;
  }

  push(bytes: Uint8Array): void {
    this.pushText(this.decoder.decode(bytes, { stream: true }));
  }

  end(): SplitterEnd {
    this.pushText(this.decoder.decode());
    let tail: LogicalLine | null = null;
    if (this.pending.length > 0 || this.contText !== null) {
      const raw = stripCR(this.pending);
      this.physicalLineNo++;
      tail =
        this.contText !== null
          ? { text: this.contText + raw, lineNo: this.contStart }
          : { text: raw, lineNo: this.physicalLineNo };
      this.pending = "";
      this.contText = null;
    }
    return { incompleteTail: tail };
  }

  private pushText(text: string): void {
    if (text.length === 0) return;
    const data = this.pending + text;
    let start = 0;
    for (;;) {
      const nl = data.indexOf("\n", start);
      if (nl < 0) break;
      this.handlePhysical(stripCR(data.slice(start, nl)));
      start = nl + 1;
    }
    this.pending = data.slice(start);
  }

  private handlePhysical(raw: string): void {
    this.physicalLineNo++;
    const continues = endsWithOddBackslashes(raw);
    const body = continues ? `${raw.slice(0, -1)}\n` : raw;
    if (this.contText === null) {
      if (continues) {
        this.contText = body;
        this.contStart = this.physicalLineNo;
      } else {
        this.onLine({ text: body, lineNo: this.physicalLineNo });
      }
      return;
    }
    this.contText += body;
    if (!continues) {
      this.onLine({ text: this.contText, lineNo: this.contStart });
      this.contText = null;
    }
  }
}

function stripCR(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

function endsWithOddBackslashes(s: string): boolean {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s.charCodeAt(i) === 0x5c; i--) n++;
  return n % 2 === 1;
}
