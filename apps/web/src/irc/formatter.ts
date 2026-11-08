// Classic IRC formatting parser. Pure: no DOM, no React.

export interface Span {
  readonly text: string;
  readonly fg?: number;
  readonly bg?: number;
  readonly bold: boolean;
  readonly underline: boolean;
}

const isDigit = (c: string | undefined): c is string => c !== undefined && c >= "0" && c <= "9";

/** Parse up to two digits at `i`. Returns the value and the next index. */
function readNumber(text: string, i: number): { readonly value: number; readonly next: number } {
  let digits = text.charAt(i);
  if (isDigit(text[i + 1])) digits += text.charAt(i + 1);
  return { value: Number(digits), next: i + digits.length };
}

export function formatIrc(text: string): readonly Span[] {
  const spans: Span[] = [];
  let fg: number | undefined;
  let bg: number | undefined;
  let bold = false;
  let underline = false;
  let buf = "";

  const flush = (): void => {
    if (buf === "") return;
    spans.push({
      text: buf,
      ...(fg !== undefined ? { fg } : {}),
      ...(bg !== undefined ? { bg } : {}),
      bold,
      underline,
    });
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const code = ch.charCodeAt(0);
    if (ch === "\x03") {
      flush();
      i += 1;
      if (!isDigit(text[i])) {
        fg = undefined;
        bg = undefined;
        continue;
      }
      const f = readNumber(text, i);
      i = f.next;
      if (f.value <= 15) fg = f.value;
      if (text[i] === "," && isDigit(text[i + 1])) {
        const b = readNumber(text, i + 1);
        i = b.next;
        if (b.value <= 15) bg = b.value;
      }
      continue;
    }
    i += 1;
    if (ch === "\x02") {
      flush();
      bold = !bold;
    } else if (ch === "\x1f") {
      flush();
      underline = !underline;
    } else if (ch === "\x0f") {
      flush();
      fg = undefined;
      bg = undefined;
      bold = false;
      underline = false;
    } else if (ch === "\t") {
      buf += " ";
    } else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) || // DEL and C1 controls
      (code >= 0x202a && code <= 0x202e) || // bidi embeddings and overrides
      (code >= 0x2066 && code <= 0x2069) || // bidi isolates
      code === 0x200b || // zero-width space
      code === 0x200e || // left-to-right mark
      code === 0x200f || // right-to-left mark
      code === 0x061c // Arabic letter mark
    ) {
      // Dropped control character.
    } else {
      buf += ch;
    }
  }
  flush();
  return spans;
}

/** True when the formatted text holds at least one non-whitespace character. */
export function hasVisibleText(text: string): boolean {
  return formatIrc(text).some((span) => span.text.trim() !== "");
}
