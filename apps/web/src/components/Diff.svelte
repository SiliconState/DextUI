<script lang="ts">
  // Flat terminal diff: +/-/@@ coloring. Lines never soft-wrap — x-scroll keeps
  // columns honest.
  let { text }: { text: string } = $props();

  interface DLine {
    kind: "add" | "del" | "hunk" | "file" | "ctx";
    text: string;
  }

  const lines = $derived.by<DLine[]>(() => {
    const out: DLine[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) out.push({ kind: "hunk", text: line });
      else if (line.startsWith("+++") || line.startsWith("---")) {
        const m = /^[++-]{3} (?:a\/)?(\S+)/.exec(line);
        if (m?.[1] && m[1] !== "/dev/null") {
          if (line.startsWith("+++")) out.push({ kind: "file", text: `─ ${m[1]}` });
        }
      } else if (line.startsWith("diff --git")) {
        // superseded by the +++ path line
      } else if (line.startsWith("+")) out.push({ kind: "add", text: line });
      else if (line.startsWith("-")) out.push({ kind: "del", text: line });
      else if (line.trim() !== "") out.push({ kind: "ctx", text: line });
    }
    return out;
  });
</script>

<div class="diff" data-agent-id="diff.view">
  {#each lines as l, i (i)}
    <div class={`d-${l.kind}`}><span class="d-text">{l.text}</span></div>
  {/each}
</div>

<style>
  .diff {
    overflow-x: auto;
    white-space: pre;
    max-height: 20rem;
    overflow-y: auto;
    font-size: 12px;
  }
  .d-text {
    white-space: pre;
  }
  .d-add {
    color: var(--green);
    background: color-mix(in srgb, var(--green) 7%, transparent);
  }
  .d-del {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 7%, transparent);
  }
  .d-hunk {
    color: var(--blue);
  }
  .d-file {
    color: var(--dim);
  }
  .d-ctx {
    color: var(--dim);
  }
</style>
