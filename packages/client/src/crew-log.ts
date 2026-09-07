import type { CrewLogChunk, CrewLogCursor, CrewTailReply } from "@dextui/protocol";

/** One selected subscription; obsolete frames cannot reset a newer selection. */
export class CrewLogBuffer {
  cursor: CrewLogCursor | undefined;
  private decoder = new TextDecoder();
  private text = "";
  private gap = false;

  reset(): void {
    this.cursor = undefined;
    this.decoder = new TextDecoder();
    this.text = "";
    this.gap = false;
  }

  accept(chunk: CrewLogChunk, subscription: string): CrewTailReply | "stale" | "resync" | "unavailable" {
    if (chunk.subscription !== subscription) return "stale";
    if (chunk.unavailable) return "unavailable";
    if (!chunk.reset && (!this.cursor || chunk.generation !== this.cursor.generation || chunk.start !== this.cursor.offset)) return "resync";
    if (chunk.reset) {
      this.reset();
      this.gap = chunk.gap;
    }
    this.text += this.decoder.decode(Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)), { stream: true });
    if (this.text.length > 65536) { this.text = this.text.slice(-65536); this.gap = true; }
    this.cursor = { generation: chunk.generation, offset: chunk.offset };
    const lines = this.text.replace(/\r/g, "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const retained = lines.slice(-80);
    const truncated = this.gap || lines.length > 80 || retained.some((line) => line.length > 400);
    return {
      run: chunk.run, worker: chunk.worker, bytes: chunk.bytes, truncated,
      lines: [...(this.gap ? ["[Earlier log output unavailable or outside the retained window]"] : []), ...retained.map((line) => line.slice(0, 400))],
    };
  }
}
