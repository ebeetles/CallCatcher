/**
 * Splits streaming LLM text into speakable segments so TTS can start on the
 * first sentence while later ones are still being generated.
 */

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "inc", "no"]);

export class SentenceChunker {
  private buffer = "";
  private readonly minLen: number;
  private readonly softMax: number;

  constructor(opts?: { minLen?: number; softMax?: number }) {
    this.minLen = opts?.minLen ?? 12;
    this.softMax = opts?.softMax ?? 160;
  }

  /** Feed a delta; returns zero or more completed segments. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let seg: string | undefined;
    while ((seg = this.takeSegment()) !== undefined) out.push(seg);
    return out;
  }

  /** Return whatever is left (end of stream). */
  flush(): string | undefined {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? rest : undefined;
  }

  private takeSegment(): string | undefined {
    // Hard boundary: sentence-ending punctuation followed by whitespace.
    const re = /[.!?]+["')\]]*\s/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buffer)) !== null) {
      const end = m.index + m[0].length;
      const candidate = this.buffer.slice(0, end).trim();
      if (candidate.length < this.minLen) continue;
      const lastWord = candidate
        .slice(0, m.index)
        .split(/\s+/)
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z]/g, "");
      if (lastWord && ABBREVIATIONS.has(lastWord)) continue;
      // Don't split decimals like "4.5"
      const before = this.buffer[m.index - 1];
      const after = this.buffer[end];
      if (/\d/.test(before ?? "") && /\d/.test(after ?? "")) continue;
      this.buffer = this.buffer.slice(end);
      return candidate;
    }
    // Newlines are always boundaries.
    const nl = this.buffer.indexOf("\n");
    if (nl >= 0) {
      const candidate = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (candidate.length > 0) return candidate;
      return this.buffer.length > 0 ? this.takeSegment() : undefined;
    }
    // Soft boundary: very long clause — split at the last comma so TTS isn't starved.
    if (this.buffer.length > this.softMax) {
      const comma = this.buffer.lastIndexOf(", ");
      if (comma > this.minLen) {
        const candidate = this.buffer.slice(0, comma + 1).trim();
        this.buffer = this.buffer.slice(comma + 2);
        return candidate;
      }
    }
    return undefined;
  }
}
