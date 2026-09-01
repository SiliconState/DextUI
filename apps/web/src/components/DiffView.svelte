<script lang="ts">
  // Renders a unified diff with per-file stats and add/del coloring.

  let { text, compact = false }: { text: string; compact?: boolean } = $props();

  interface Row {
    kind: "add" | "del" | "ctx" | "hunk";
    text: string;
  }
  interface File {
    header: string;
    rows: Row[];
    add: number;
    del: number;
  }

  const files = $derived.by<File[]>(() => {
    const out: File[] = [];
    let cur = -1; // index into out; -1 = no bucket yet
    const push = (header: string): File => {
      const f: File = { header, rows: [], add: 0, del: 0 };
      out.push(f);
      cur = out.length - 1;
      return f;
    };
    // Function call (not a captured let read): sidesteps TS closure narrowing.
    const current = (): File | undefined => out[cur];
    for (const line of text.split("\n")) {
      if (line.startsWith("diff --git")) {
        const m = /^diff --git a\/(\S+) b\/\S+$/.exec(line);
        push(m?.[1] ?? line);
        continue;
      }
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        const f0 = current();
        if (!f0) {
          const m = /^[+++-]{3} (?:a\/)?(\S+)/.exec(line);
          push(m?.[1] ?? "changes");
        } else if (f0.rows.length === 0 && f0.header === "changes") {
          const m = /^[+++-]{3} (?:a\/)?(\S+)/.exec(line);
          if (m?.[1]) f0.header = m[1];
        }
        continue;
      }
      const f = current() ?? push("changes");
      if (line.startsWith("@@")) f.rows.push({ kind: "hunk", text: line });
      else if (line.startsWith("+")) {
        f.rows.push({ kind: "add", text: line });
        f.add++;
      } else if (line.startsWith("-")) {
        f.rows.push({ kind: "del", text: line });
        f.del++;
      } else if (line.trim() !== "") f.rows.push({ kind: "ctx", text: line });
    }
    return out.filter((f) => f.rows.length > 0);
  });

  const rowClass: Record<Row["kind"], string> = {
    add: "bg-ok/10 text-ok",
    del: "bg-err/10 text-err",
    ctx: "text-dim",
    hunk: "bg-raised text-accent2",
  };
</script>

<div class="overflow-hidden rounded-lg border border-line" data-agent-id="diff.view">
  {#each files as f, i (i)}
    <div data-agent-id={`diff.file.${i}`} class={i > 0 ? "mt-2" : ""}>
      <div class="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
        <span class="truncate font-mono text-xs text-ink">{f.header}</span>
        <span class="ml-auto shrink-0 font-mono text-[10px] text-ok">+{f.add}</span>
        <span class="shrink-0 font-mono text-[10px] text-err">-{f.del}</span>
      </div>
      <div class={`overflow-x-auto bg-bg font-mono text-xs ${compact ? "max-h-48" : "max-h-72"} overflow-y-auto`}>
        {#each f.rows as r, j (j)}
          <div class={`whitespace-pre px-3 ${rowClass[r.kind]} ${r.kind === "hunk" ? "py-0.5" : "leading-5"}`}>{r.text}</div>
        {/each}
      </div>
    </div>
  {/each}
</div>
