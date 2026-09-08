#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if ! command -v agent-browser >/dev/null 2>&1; then
  echo 'SKIP: agent-browser not installed; chart browser regressions not run'
  exit 0
fi
TMP=$(mktemp -d)
PORT=${PORT:-8794}
B=(agent-browser --session dext-chart-review)
SRV=''
cleanup() { "${B[@]}" close >/dev/null 2>&1 || true; [ -z "$SRV" ] || kill "$SRV" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
cat >"$TMP/chart.md" <<'EOF'
## Chart regression

| Item | Change |
|---|---|
| Alpha | +$2 |
| Beta | −$1 |

```chart
{"type":"hbar","title":"Frozen ranking","labels":["A","B","C"],"values":[10,8,-4],"sort":"desc","dataset":"linked"}
```

```chart
{"type":"hbar","title":"Linked ranking","labels":["A","B","C"],"values":[1,2,3],"sort":"desc","domain":[-3,3],"dataset":"linked"}
```

## Fixed positive

```chart
{"type":"bar","title":"Positive domain","labels":["below","middle","above"],"values":[5,15,30],"domain":[10,20]}
```

## Fixed negative

```chart
{"type":"bar","title":"Negative domain","labels":["below","middle","above"],"values":[-30,-15,-5],"domain":[-20,-10]}
```

## Clipped line

```chart
{"type":"line","title":"Clipped line","values":[-10,0,10],"domain":[-3,3]}
```

## Long outlier labels

| Item | Change |
|---|---|
| A | -3000% |
| B | +3000% |

```chart
{"type":"hbar","title":"Outliers","values":[-3000,3000,0],"labels":["low","high","zero"],"domain":[-3,3],"unit":"%"}
```
EOF
MOCK_MARKDOWN_FILE="${REPORT_FILE:-$TMP/chart.md}" node packages/mock-server/src/server.mjs --port="$PORT" >"$TMP/mock.log" 2>&1 &
SRV=$!
"${B[@]}" set viewport 1440 1000 >/dev/null
"${B[@]}" open "http://127.0.0.1:$PORT" >/dev/null
"${B[@]}" wait '[data-agent-id="connect.token"]' >/dev/null
"${B[@]}" fill '[data-agent-id="connect.token"]' dev-token >/dev/null
"${B[@]}" click '[data-agent-id="connect.submit"]' >/dev/null
"${B[@]}" wait '[data-agent-id="session.new"]' >/dev/null
"${B[@]}" eval 'document.querySelector(`[data-agent-id="persona.skip"]`)?.click()' >/dev/null
"${B[@]}" click '[data-agent-id="session.new"]' >/dev/null
"${B[@]}" wait '[data-agent-id="composer.input"]' >/dev/null
"${B[@]}" fill '[data-agent-id="composer.input"]' 'markdown demo' >/dev/null
"${B[@]}" press Enter >/dev/null
N=${REPORT_CHARTS:-6}
"${B[@]}" wait --fn "document.querySelectorAll('.chart-wrap').length === $N" >/dev/null
# Wait for the complete streamed answer rather than inspecting an intermediate layout.
"${B[@]}" wait --fn "document.querySelectorAll('.md-chartbox .chart-wrap').length === $N && !document.querySelector('[data-agent-id=\"composer.stop\"]')" >/dev/null
check() { local result; result=$("${B[@]}" eval "$1"); echo "$result"; grep -qx true <<<"$result" || { echo 'FAIL: chart browser assertion'; exit 1; }; }
check 'document.querySelectorAll(`.md-tape .chart-wrap`).length >= 2 && document.body.scrollWidth <= innerWidth'
check '[...document.querySelectorAll(`.md-tape .chart-wrap`)].every(e => e.clientWidth >= 500)'
if [ -z "${REPORT_FILE:-}" ]; then
  check '!!document.querySelector(`td.pos`) && !!document.querySelector(`td.neg`) && !document.querySelector(`tr.pos, tr.neg`)'
  check '[...document.querySelectorAll(`.chart-wrap`)].filter(e=>/domain/.test(e.querySelector(`.chart-title`).textContent)).every(e=>[...e.querySelectorAll(`rect[rx="2"]`)].every(r=>+r.getAttribute(`y`) >= 26 && +r.getAttribute(`y`)+ +r.getAttribute(`height`) <= 190.01))'
  check 'document.querySelectorAll(`clipPath`).length === 1 && !!document.querySelector(`g[clip-path]`)'
  check '[...document.querySelectorAll(`.chart-wrap`)].at(-1).querySelectorAll(`g > text`).length === 6 && [...[...document.querySelectorAll(`.chart-wrap`)].at(-1).querySelectorAll(`g > text:last-child`)].every(t=>{const b=t.getBBox();return b.x>=124 && b.x+b.width<=560})'
  # Real pointer capture, then move A below B: axis and row order stay frozen until release.
  POS=$("${B[@]}" eval 'JSON.stringify((()=>{const svg=document.querySelector(`.chart-wrap svg`);svg.scrollIntoView({block:`center`});const r=svg.getBoundingClientRect();const k=r.width/560;return [r.left+400*k,r.top+35*k,r.left+350*k]})())' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log((typeof v==="string"?JSON.parse(v):v).map(Math.round).join(" "))})')
  read -r X Y END <<<"$POS"
  "${B[@]}" mouse move "$X" "$Y" >/dev/null
  "${B[@]}" mouse down >/dev/null
  "${B[@]}" mouse move "$END" "$Y" >/dev/null
  check '(()=>{const s=document.querySelector(`.chart-wrap svg`);const r=s.querySelector(`g rect[rx="3"] + rect`);return s.querySelector(`g text`).textContent===`A` && Math.abs(+r.getAttribute(`x`)+ +r.getAttribute(`width`)-350)<2})()'
  "${B[@]}" mouse up >/dev/null
  "${B[@]}" wait --fn 'document.querySelector(`.chart-wrap svg g text`).textContent === `B`' >/dev/null
  "${B[@]}" eval '[...document.querySelectorAll(`.chart-btn`)].find(b=>b.textContent===`Reset edits`)?.click()' >/dev/null
  # Click original A in first chart. The linked chart ranks A last, but still highlights A.
  "${B[@]}" wait --fn 'document.querySelector(`.chart-wrap svg g text`).textContent === `A`' >/dev/null
  "${B[@]}" mouse move "$X" "$Y" >/dev/null
  "${B[@]}" mouse down >/dev/null
  "${B[@]}" mouse up >/dev/null
  check '(()=>{const c=document.querySelectorAll(`.chart-wrap`)[1];const rows=[...c.querySelectorAll(`svg g`)];return rows.filter(g=>g.querySelector(`text`)?.textContent===`A`).every(g=>g.querySelectorAll(`rect`)[1].getAttribute(`opacity`)===`1`) && rows.filter(g=>g.querySelector(`text`)?.textContent===`B`).every(g=>+g.querySelectorAll(`rect`)[1].getAttribute(`opacity`)<1)})()'
fi
for WIDTH in 1440 900 390; do
  "${B[@]}" set viewport "$WIDTH" 1000 >/dev/null
  check 'document.body.scrollWidth <= innerWidth && [...document.querySelectorAll(`.md-tape`)].every(e=>e.scrollWidth <= e.clientWidth+1)'
  check '[...document.querySelectorAll(`.md-tape .chart-wrap`)].every(e=>e.clientWidth >= 500)'
  if [ "$WIDTH" -lt 1000 ]; then
    check '[...document.querySelectorAll(`.md-tape`)].every(e=>getComputedStyle(e).gridTemplateColumns.trim().split(/\s+/).length===1)'
  fi
  "${B[@]}" eval 'document.querySelector(`.md-tape`).scrollIntoView()' >/dev/null
  if [ -n "${SCREENSHOT_DIR:-}" ]; then
    mkdir -p "$SCREENSHOT_DIR"
    "${B[@]}" screenshot "$SCREENSHOT_DIR/report-$WIDTH.png" >/dev/null
  fi
done
ERR=$("${B[@]}" errors)
[ -z "$ERR" ] || { echo "$ERR"; exit 1; }
echo 'CHART BROWSER CHECKS PASSED'
