#!/usr/bin/env bash
# Responsive regression and optional screenshot matrix. Uses only a loopback mock.
set -euo pipefail
cd "$(dirname "$0")/../../.."
if ! command -v agent-browser >/dev/null 2>&1; then
  echo 'SKIP: agent-browser unavailable; phone review not run'
  exit 0
fi
PORT=${PORT:-8795}
OUT=apps/web/dist.phone-review
TMP=$(mktemp -d)
B=(agent-browser --session dext-phone-review)
SRV=''
cleanup() { "${B[@]}" close >/dev/null 2>&1 || true; [ -z "$SRV" ] || kill "$SRV" 2>/dev/null || true; rm -rf "$TMP" "$OUT"; }
trap cleanup EXIT
if [ -n "${SCREENSHOTS:-}" ]; then mkdir -p "$SCREENSHOTS"; fi
capture() { [ -z "${SCREENSHOTS:-}" ] || { "${B[@]}" wait 180 >/dev/null; "${B[@]}" screenshot "$SCREENSHOTS/$1.png" >/dev/null; }; }
open_settings() { if ! "${B[@]}" is visible '[data-agent-id="settings.open"]' 2>/dev/null | grep -qx true; then "${B[@]}" click '[data-agent-id="status.details"]' >/dev/null; wait_js '!!document.querySelector(`[data-agent-id="status.details.overlay"]`)'; fi; "${B[@]}" click '[data-agent-id="settings.open"]' >/dev/null; wait_js '!!document.querySelector(`[data-agent-id="settings.overlay"]`)'; }
check() { local result; result=$("${B[@]}" eval "$1"); if [ "$result" != true ]; then echo "FAIL: $1"; echo "$result"; exit 1; fi; }
wait_js() {
  if ! "${B[@]}" wait --fn "$1" >/dev/null; then
    echo "FAIL waiting: $1"
    "${B[@]}" snapshot
    "${B[@]}" eval '(()=>JSON.stringify({artifact:document.querySelector(`[data-agent-id="artifact.overlay"]`)?.dataset.state,source:document.querySelector(`[data-agent-id="artifact.source"]`)?.textContent,buttons:[...document.querySelectorAll(`[data-agent-id^="artifact."]`)].map(x=>[x.dataset.agentId,x.getAttribute("aria-expanded"),x.getBoundingClientRect().width])}))()'
    capture failure
    exit 1
  fi
}
(cd apps/web && npm exec -- vite build --outDir dist.phone-review --emptyOutDir >"$TMP/build.log" 2>&1) || { cat "$TMP/build.log"; exit 1; }
cat >"$TMP/report.md" <<'EOF'
## Daily market brief

Mock review data, not financial advice.

**The signal:** technology led today's sample market. The watchlist is ready to review; no trades were placed.

```html
<!doctype html><html><head><style>body{font:16px system-ui;margin:24px;background:#f4f2ec;color:#242830}h1{font-size:24px}article{padding:20px;border:1px solid #bbb;border-radius:8px}html[data-theme=dark] body{background:#0b0d10;color:#c8cfd9}html[data-theme=dim] body{background:#1b1f27;color:#cdd4de}</style></head><body><h1>Daily market brief</h1><p>Mock review data · prepared for your check-in</p><article><h2>Technology leads</h2><p>Sample index +1.2%. No trades placed.</p><label>Watchlist threshold <input type="range" min="1" max="10" value="4"></label></article><script>addEventListener('message',e=>{if(e.source===parent&&['light','dark','dim'].includes(e.data?.theme))document.documentElement.dataset.theme=e.data.theme})</script></body></html>
```

### Watchlist

| Asset | Move | Why it matters | Next step |
|---|---:|---|---|
| Technology | +1.2% | Led the sample market | Review earnings |
| Energy | −0.4% | Oil softened overnight | Watch inventory |
| Broad market | +0.6% | Breadth improved | Check tomorrow |

### What changed

- Three assets were added to the watchlist.
- Your risk limits and trading permissions are unchanged.
- The interactive brief contains the full sample.

```text
Review only. No orders submitted.
```
EOF
MOCK_MARKDOWN_FILE="$TMP/report.md" node packages/mock-server/src/server.mjs --port="$PORT" --static="$OUT" >"$TMP/mock.log" 2>&1 &
SRV=$!
sleep 1
"${B[@]}" set viewport 1280 900 >/dev/null
"${B[@]}" open "http://127.0.0.1:$PORT" >/dev/null
"${B[@]}" wait '[data-agent-id="connect.token"]' >/dev/null
"${B[@]}" fill '[data-agent-id="connect.token"]' dev-token >/dev/null
"${B[@]}" click '[data-agent-id="connect.submit"]' >/dev/null
"${B[@]}" wait '[data-agent-id="session.new"]' >/dev/null
for n in $(seq 1 8); do
  "${B[@]}" eval '(()=>{document.querySelector(`[data-agent-id="persona.skip"]`)?.click();document.querySelector(`[data-agent-id="session.new"]`)?.click();return true})()' >/dev/null
  if "${B[@]}" wait --timeout 3000 '[data-agent-id="composer.input"]' >/dev/null 2>&1; then break; fi
done
"${B[@]}" fill '[data-agent-id="composer.input"]' 'markdown demo' >/dev/null
"${B[@]}" click '[data-agent-id="composer.send"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="markdown.artifact.open"]`) && !document.querySelector(`[data-agent-id="composer.stop"]`)'
for size in ${REVIEW_SIZES:-390x844 768x1024 1280x900}; do
  read -r width height <<<"${size/x/ }"
  "${B[@]}" set viewport "$width" "$height" >/dev/null
  "${B[@]}" wait 250 >/dev/null
  if [ "$width" -le 900 ]; then wait_js 'document.querySelector(`[data-agent-id="status.hud"]`).getBoundingClientRect().height===44'; fi
  for theme in ${REVIEW_THEMES:-light dim dark}; do
    open_settings
    "${B[@]}" click "[data-agent-id=\"theme.set.$theme\"]" >/dev/null
    "${B[@]}" press Escape >/dev/null
    wait_js "document.documentElement.dataset.theme===\"$theme\""
    "${B[@]}" eval '(()=>{const s=document.querySelector(`.sb`);s.scrollTop=0;return true})()' >/dev/null
    check 'document.documentElement.scrollWidth<=innerWidth && Math.abs(document.querySelector(`[data-agent-id="app.root"]`).getBoundingClientRect().height-visualViewport.height)<2'
    if [ "$width" -le 900 ]; then
      check 'document.querySelector(`[data-agent-id="status.hud"]`).getBoundingClientRect().bottom<=document.querySelector(`[data-agent-id="transcript.root"]`).getBoundingClientRect().top && document.querySelector(`[data-agent-id="composer.root"]`).getBoundingClientRect().bottom<=visualViewport.height && document.querySelector(`[data-agent-id="status.session-state"] .state-label`).textContent==="Idle"'
    else
      check '!document.querySelector(`[data-agent-id="session.rail.wrap"]`).inert && document.querySelector(`[data-agent-id="status.hud"]`).getBoundingClientRect().bottom<=document.querySelector(`[data-agent-id="transcript.root"]`).getBoundingClientRect().top && document.querySelectorAll(`[data-agent-id="status.hud"]`).length===1'
    fi
    if [ "$width" -eq 390 ] && [ "${REVIEW_PHASE:-1}" -ge 2 ]; then
      check 'getComputedStyle(document.querySelector(`.md`)).fontFamily.includes("system-ui") && getComputedStyle(document.querySelector(`.md-table td`)).display==="grid" && getComputedStyle(document.querySelector(`.md-code`)).fontFamily.includes("Mono")'
    fi
    capture "$width-$theme-session"
    "${B[@]}" click '[data-agent-id="status.model-chip"]' >/dev/null
    check '(()=>{const m=document.querySelector(`[data-agent-id="session.controls.overlay"]`),r=m.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=visualViewport.height&&m.scrollWidth<=m.clientWidth})()'
    capture "$width-$theme-controls"
    "${B[@]}" press Escape >/dev/null
    if [ "${REVIEW_PHASE:-1}" -ge 2 ]; then
      "${B[@]}" click '[data-agent-id="markdown.artifact.open"]' >/dev/null
      wait_js '!!document.querySelector(`[data-agent-id="artifact.frame"]`)'
      check '(()=>{const r=document.querySelector(`[data-agent-id="artifact.overlay"]`).getBoundingClientRect();return r.right<=innerWidth&&r.width<=(innerWidth+1)&&r.bottom<=visualViewport.height})()'
      capture "$width-$theme-report"
      if [ "$width" -le 900 ]; then
        check 'document.querySelector(`[data-agent-id="artifact.back"]`).getBoundingClientRect().height>=44 && getComputedStyle(document.querySelector(`[data-agent-id="artifact.code"]`).parentElement).display==="none"'
        "${B[@]}" eval '(()=>{window.__originalShare=navigator.share;window.__originalCanShare=navigator.canShare;navigator.canShare=()=>true;navigator.share=async data=>{window.__sharedFile=await data.files[0].text()};return true})()' >/dev/null
        "${B[@]}" click '[data-agent-id="artifact.share"]' >/dev/null
        wait_js 'window.__sharedFile?.includes("Daily market brief") && !window.__sharedFile.includes("?t=")'
        "${B[@]}" eval '(()=>{navigator.share=window.__originalShare;navigator.canShare=window.__originalCanShare;return true})()' >/dev/null
        "${B[@]}" click '[data-agent-id="artifact.more"]' >/dev/null
        wait_js 'document.querySelector(`[data-agent-id="artifact.more"]`).getAttribute("aria-expanded")==="true" && document.querySelector(`[data-agent-id="artifact.code"]`).getBoundingClientRect().height>=44'
        "${B[@]}" wait 250 >/dev/null
        "${B[@]}" click '[data-agent-id="artifact.code"]' >/dev/null
        wait_js '!!document.querySelector(`[data-agent-id="artifact.source"]`) && document.querySelector(`[data-agent-id="artifact.source"]`).textContent.includes("Daily market brief")'
        "${B[@]}" click '[data-agent-id="artifact.report"]' >/dev/null
        "${B[@]}" click '[data-agent-id="artifact.more"]' >/dev/null
        "${B[@]}" click '[data-agent-id="artifact.back"]' >/dev/null
      else "${B[@]}" click '[data-agent-id="artifact.close"]' >/dev/null; fi
    fi
    if [ "$width" -eq 390 ]; then
      "${B[@]}" focus '[data-agent-id="composer.input"]' >/dev/null
      "${B[@]}" eval '(()=>{const v=visualViewport;Object.defineProperty(v,"height",{value:390,configurable:true});v.dispatchEvent(new Event("resize"));return true})()' >/dev/null
      wait_js 'Math.abs(document.querySelector(`[data-agent-id="app.root"]`).getBoundingClientRect().height-390)<2'
      check 'document.querySelector(`[data-agent-id="composer.input"]`).getBoundingClientRect().bottom<=390 && document.querySelector(`[data-agent-id="transcript.root"]`).getBoundingClientRect().height>150'
      capture "$width-$theme-keyboard"
      "${B[@]}" eval '(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event("resize"));document.activeElement.blur();return true})()' >/dev/null
    fi
  done
done
"${B[@]}" set viewport 390 844 >/dev/null
"${B[@]}" wait 250 >/dev/null
"${B[@]}" click '[data-agent-id="index.toggle"]' >/dev/null
check '!!document.querySelector(`[data-agent-id="sessions.group.idle"]`)'
capture '390-dark-sessions'
"${B[@]}" press Escape >/dev/null
"${B[@]}" click '[data-agent-id="status.model-chip"]' >/dev/null
"${B[@]}" click '[data-agent-id="status.approval.picker"]' >/dev/null
"${B[@]}" click '[data-agent-id="session.approval.option.always"]' >/dev/null
check '!!document.querySelector(`[data-agent-id="session.permission.confirm"]`) && !document.querySelector(`[data-agent-id="status.full-auto"]`)'
"${B[@]}" click '[data-agent-id="session.permission.enable"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="status.full-auto"]`)'
"${B[@]}" click '[data-agent-id="status.approval.picker"]' >/dev/null
"${B[@]}" click '[data-agent-id="session.approval.option.ask"]' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="status.full-auto"]`)'
"${B[@]}" press Escape >/dev/null
"${B[@]}" fill '[data-agent-id="composer.input"]' 'Attached image candidate for native read_image read_image(path)' >/dev/null
"${B[@]}" click '[data-agent-id="composer.send"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="approval.dock"]`)'
for size in ${REVIEW_SIZES:-390x844 768x1024 1280x900}; do
  read -r width height <<<"${size/x/ }"
  "${B[@]}" set viewport "$width" "$height" >/dev/null
  "${B[@]}" wait 250 >/dev/null
  if [ "$width" -le 900 ]; then wait_js 'document.querySelector(`[data-agent-id="status.hud"]`).getBoundingClientRect().height===44'; fi
  for theme in ${REVIEW_THEMES:-light dim dark}; do
    open_settings
    "${B[@]}" click "[data-agent-id=\"theme.set.$theme\"]" >/dev/null
    "${B[@]}" press Escape >/dev/null
    wait_js "document.documentElement.dataset.theme===\"$theme\""
    check 'document.querySelector(`[data-agent-id="status.session-state"] .state-label`).textContent==="Needs input"'
    check '(()=>{const b=document.querySelector(`[data-agent-id^="approval."][data-agent-id$=".once"]`),r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=visualViewport.height&&(innerWidth>600||r.height>=44)})()'
    capture "$width-$theme-approval"
  done
done
"${B[@]}" eval 'document.querySelector(`[data-agent-id^="approval."][data-agent-id$=".deny"]`).click()' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="approval.dock"]`)'
if [ "${REVIEW_PHASE:-1}" -ge 2 ]; then
  "${B[@]}" set viewport 390 844 >/dev/null
  "${B[@]}" wait 250 >/dev/null
  "${B[@]}" fill '[data-agent-id="composer.input"]' 'tool folding demo' >/dev/null
  "${B[@]}" click '[data-agent-id="composer.send"]' >/dev/null
  wait_js 'document.body.textContent.includes("Tool folding demo complete") && !document.querySelector(`[data-agent-id="composer.stop"]`)'
  check 'document.querySelectorAll(`[data-agent-id^="phone.work."]`).length>=1 && [...document.querySelectorAll(`[data-agent-id^="phone.work."]`)].at(-1).querySelector(`button`).getAttribute("aria-expanded")==="false" && [...document.querySelectorAll(`[data-agent-id^="phone.work."]`)].at(-1).querySelector(`[data-agent-id="phone.summary.failed"]`).textContent.includes("1 failed") && [...document.querySelectorAll(`[data-agent-id^="phone.work."]`)].at(-1).querySelector(`[data-agent-id="phone.summary.passed"]`).textContent.includes("10 passed") && !document.querySelector(`[data-agent-id="tool.fold-bash"]`)'
  if [ "$width" -le 900 ]; then wait_js 'document.querySelector(`[data-agent-id="status.hud"]`).getBoundingClientRect().height===44'; fi
  for theme in ${REVIEW_THEMES:-light dim dark}; do
    open_settings
    "${B[@]}" click "[data-agent-id=\"theme.set.$theme\"]" >/dev/null
    "${B[@]}" press Escape >/dev/null
    "${B[@]}" eval '(()=>{const s=document.querySelector(`.sb`);s.scrollTop=s.scrollHeight;return true})()' >/dev/null
    capture "390-$theme-work-summary"
  done
  "${B[@]}" eval '[...document.querySelectorAll(`[data-agent-id^="phone.work."]`)].at(-1).querySelector(`button`).click()' >/dev/null
  for size in '390 844' '768 1024' '1280 900'; do
    read -r width height <<<"$size"
    "${B[@]}" set viewport "$width" "$height" >/dev/null
    "${B[@]}" wait 250 >/dev/null
    if [ "$width" -le 600 ]; then
      "${B[@]}" click '[data-agent-id="phone.tool.fold-bash"]' >/dev/null
    else
      "${B[@]}" eval 'document.querySelector(`[data-agent-id="tool.fold-bash.inspect"]`).click()' >/dev/null
    fi
    for theme in ${REVIEW_THEMES:-light dim dark}; do
      # The inspector owns focus; change theme via device preference plus reload
      # is unnecessary. Apply the theme tokens directly for this surface matrix.
      "${B[@]}" eval "document.documentElement.dataset.theme=\"$theme\"" >/dev/null
      check 'document.querySelector(`[data-agent-id="tool.detail.output"]`).getAttribute("aria-pressed")==="true" && document.querySelector(`[data-agent-id="tool.detail.text"]`).textContent.includes("249 tests passed") && document.querySelector(`.metadata`).textContent.includes("exit 0")'
      check '(()=>{const r=document.querySelector(`[data-agent-id="drawer.block"]`).getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=visualViewport.height&&(innerWidth>900||Math.abs(r.width-innerWidth)<1)})()'
      capture "$width-$theme-tool-output"
      "${B[@]}" fill '[data-agent-id="tool.detail.search"]' 'passed' >/dev/null
      check 'document.querySelector(`[data-agent-id="tool.detail.text"]`).textContent.trim()==="3  249 tests passed"'
      "${B[@]}" click '[data-agent-id="tool.detail.raw"]' >/dev/null
      check 'JSON.parse(document.querySelector(`[data-agent-id="drawer.block.json"]`).textContent).call_id==="fold-bash"'
      "${B[@]}" click '[data-agent-id="tool.detail.command"]' >/dev/null
      check 'document.querySelector(`[data-agent-id="tool.detail.text"]`).textContent==="npm test"'
      "${B[@]}" click '[data-agent-id="tool.detail.output"]' >/dev/null
    done
    "${B[@]}" click '[data-agent-id="drawer.block.close"]' >/dev/null
  done
  "${B[@]}" set viewport 390 844 >/dev/null
  "${B[@]}" wait 250 >/dev/null
  "${B[@]}" eval '(()=>{const b=[...document.querySelectorAll(`[data-agent-id^="phone.work."]`)].at(-1).querySelector(`button`);if(b.getAttribute("aria-expanded")==="false")b.click();return true})()' >/dev/null
  "${B[@]}" click '[data-agent-id="phone.tool.fold-diff"]' >/dev/null
  check 'document.querySelector(`[data-agent-id="diff.view"]`).classList.contains("expanded") && getComputedStyle(document.querySelector(`[data-agent-id="diff.view"]`)).maxHeight==="none"'
  "${B[@]}" click '[data-agent-id="diff.wrap"]' >/dev/null
  check 'document.querySelector(`[data-agent-id="diff.wrap"]`).getAttribute("aria-pressed")==="false"'
  capture '390-dark-diff'
  "${B[@]}" click '[data-agent-id="drawer.block.close"]' >/dev/null
fi
echo 'PHONE REVIEW PASSED: size/theme matrix, session state, controls, approvals, full-auto confirmation and keyboard viewport'
