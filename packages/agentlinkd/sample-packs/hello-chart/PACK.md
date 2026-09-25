---
name: hello-chart
description: Emit one interactive chart fence from a tiny deterministic dataset. The DextUI gallery's guaranteed sub-10-second first artifact; no tools, no files, no network.
ui-starter-prompt: Run hello-chart
ui-artifact: chart
ui-time-to-first-artifact: 5
ui-requires: []
ui-gallery: true
ui-tags: [sample, chart]
ui-icon: chart
---

# Hello Chart

The smallest possible pack: it proves the pack → DextUI → interactive chart
path works before a new user has to trust anything slower.

## Use when

- The task says "hello-chart", "demo chart", or "show me a chart quickly".
- A user is exploring DextUI for the first time and needs a result in seconds.

## Workflow

1. Do not run tools, read files, or browse. Everything below is fixed.
2. Reply with exactly one short sentence, then one ```chart fence:

```chart
{"type":"bar","title":"Hello from a pack","labels":["packs","run","edit","share"],"values":[4,3,2,1],"unit":"","dataset":"hello"}
```

3. After the fence, one line: "Hover, drag a bar, or click sort, this chart is
   live. Try `/pack list` to see what else is installed."

## Output

- One sentence, one chart fence, one hint line. Nothing else.
