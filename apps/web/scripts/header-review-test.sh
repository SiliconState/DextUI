#!/usr/bin/env bash
# Adversarial header/state matrix, with no live host or provider mutations.
set -euo pipefail
cd "$(dirname "$0")/../../.."
if ! command -v agent-browser >/dev/null 2>&1; then echo 'SKIP: agent-browser unavailable; header matrix not run'; exit 0; fi
PORT=${PORT:-8796}
OUT=apps/web/dist.header-review
TMP=$(mktemp -d)
B=(agent-browser --session dext-header-review)
SRV=''
cleanup() { "${B[@]}" close >/dev/null 2>&1 || true; [ -z "$SRV" ] || kill "$SRV" 2>/dev/null || true; rm -rf "$TMP" "$OUT"; }
trap cleanup EXIT
[ -z "${SCREENSHOTS:-}" ] || mkdir -p "$SCREENSHOTS"
capture() { [ -z "${SCREENSHOTS:-}" ] || "${B[@]}" screenshot "$SCREENSHOTS/$1.png" >/dev/null; }
wait_js() { if ! "${B[@]}" wait --fn "$1" >/dev/null; then echo "FAIL waiting: $1"; "${B[@]}" snapshot; "${B[@]}" eval '({focus:document.activeElement?.dataset.agentId,tag:document.activeElement?.tagName,mainInert:document.querySelector(`main`)?.inert,diff:!!document.querySelector(`[data-agent-id="diff.overlay"]`),launch:[...document.querySelectorAll(`[data-agent-id="diff.open"]`)].map(e=>({connected:e.isConnected,inert:!!e.closest(`[inert]`),rects:e.getClientRects().length,visibility:getComputedStyle(e).visibility,display:getComputedStyle(e).display,top:e.getBoundingClientRect().top})),history:document.querySelector(`.sb`)?.scrollTop})'; capture failure; exit 1; fi; }
check() { local out; out=$("${B[@]}" eval "$1"); if [ "$out" != true ]; then echo "FAIL: $1"; echo "$out"; "${B[@]}" eval 'JSON.stringify({failures:window.__fitFailures,width:innerWidth,work:{summaries:[...document.querySelectorAll(`section[data-agent-id^="phone.work."] > button`)].map(e=>({label:e.getAttribute("aria-label"),text:e.textContent,state:e.parentElement.dataset.state})),steps:document.querySelectorAll(`section[data-agent-id^="phone.work."] .step`).length,tips:[...document.querySelectorAll(`[data-agent-id="phone.work.tip"]`)].map(e=>e.textContent),markers:[...document.querySelectorAll(`.b-marker`)].map(e=>e.textContent)},popup:(()=>{const p=document.querySelector(`[data-agent-id="session.controls.overlay"]`);return p?{height:p.getBoundingClientRect().height,width:p.getBoundingClientRect().width,text:p.textContent,sections:[...p.querySelectorAll(`.sec`)].map(e=>[e.textContent,e.getBoundingClientRect().height])}:null})(),header:(()=>{const h=document.querySelector(`[data-agent-id="status.hud"]`),t=h.querySelector(`.session-name`);return {height:h.getBoundingClientRect().height,scroll:h.scrollWidth,client:h.clientWidth,titleWidth:t.clientWidth,titleScroll:t.scrollWidth,buttons:[...h.querySelectorAll(`:scope > button`)].map(x=>[x.dataset.agentId,x.getBoundingClientRect().height,x.getBoundingClientRect().width])}})()})' || true; capture failure; exit 1; fi; }
(cd apps/web && npm exec -- vite build --config scripts/header-review.vite.ts >"$TMP/build.log" 2>&1) || { cat "$TMP/build.log"; exit 1; }
node packages/mock-server/src/server.mjs --port="$PORT" --static="$OUT" >"$TMP/server.log" 2>&1 &
SRV=$!
sleep 1
"${B[@]}" open "http://127.0.0.1:$PORT" >/dev/null
wait_js '!!window.__headerReview && !!document.querySelector(`[data-agent-id="status.hud"]`)'
"${B[@]}" eval '(()=>{window.__fits=selector=>{const roots=[...document.querySelectorAll(selector)];window.__fitFailures=[];for(const root of roots){const r=root.getBoundingClientRect();for(const child of root.querySelectorAll(`button,input,select,.session-name,.subtitle,.full-auto,.cell-value,.art,.tabs,.search,.appr-actions`)){const c=child.getBoundingClientRect();if(!c.width||!c.height)continue;if(c.left<r.left-1||c.right>r.right+1)window.__fitFailures.push({root:selector,id:child.dataset.agentId,tag:child.tagName,left:c.left,right:c.right,rootLeft:r.left,rootRight:r.right});}}return roots.length>0&&window.__fitFailures.length===0};return true})()' >/dev/null
COUNT=0
for width in ${HEADER_WIDTHS:-360 390 499 501 768 1280}; do
  "${B[@]}" set viewport "$width" 844 >/dev/null
  "${B[@]}" wait 220 >/dev/null
  for theme in ${HEADER_THEMES:-light dim dark}; do
    for state in working review done failed; do
      for auto in false true; do
        "${B[@]}" eval "(()=>{window.__headerReview.theme(\"$theme\");window.__headerReview.set(\"$state\",$auto);return true})()" >/dev/null
        wait_js "document.querySelector(\`[data-agent-id=\"status.hud\"]\`).dataset.state===\"$state\" && !!document.querySelector(\`[data-agent-id=\"status.full-auto\"]\`)===$auto"
        check '(()=>{const h=document.querySelector(`[data-agent-id="status.hud"]`),r=h.getBoundingClientRect(),title=h.querySelector(`.session-name`),s=getComputedStyle(title),children=[...h.children].filter(e=>e.tagName===`BUTTON`);return r.height===(innerWidth<=900||matchMedia(`(pointer: coarse)`).matches||matchMedia(`(hover: none)`).matches?44:32)&&h.scrollWidth<=h.clientWidth&&document.querySelectorAll(`[data-agent-id="status.hud"]`).length===1&&document.querySelectorAll(`[data-agent-id="status.ctx"]`).length===1&&document.querySelectorAll(`[data-agent-id="status.session-state"]`).length===1&&title.scrollWidth>title.clientWidth&&s.textOverflow===`ellipsis`&&s.whiteSpace===`nowrap`&&children.every(e=>{const b=e.getBoundingClientRect();return b.top>=r.top&&b.bottom<=r.bottom&&b.height>=(innerWidth<=900?44:28)})&&window.__fits(`[data-agent-id="status.hud"]`)})()'
        if [ "$auto" = true ]; then check '(()=>{const flag=document.querySelector(`[data-agent-id="status.full-auto"]`),copy=document.querySelector(`.subtitle-copy`),f=flag.getBoundingClientRect(),c=copy.getBoundingClientRect();return f.width>0&&f.height>0&&(innerWidth<=900?getComputedStyle(document.querySelector(`.auto-label`)).display==="none":f.left>=c.right&&Math.abs(f.top-c.top)<4)})()'; fi
        check "!!document.querySelector(\`[data-agent-id=\"status.progress\"]\`) === (\"$state\"===\"working\"||\"$state\"===\"review\")"
        if [ "$state" = working ]; then check 'document.querySelector(`.subtitle-copy`).textContent==="5 of 8 · Rebuilding report" && document.querySelector(`[data-agent-id="status.progress"]`).value===5 && document.querySelector(`[data-agent-id="status.progress"]`).max===8'; fi
        if [ "$width" -le 600 ]; then
          check 'window.__fits(`section[data-agent-id^="phone.work."]`) && (()=>{const w=document.querySelector(`section[data-agent-id^="phone.work."]`);return w.querySelector(`[data-agent-id="phone.summary.passed"]`)?.textContent.includes(w.dataset.state==="working"||w.dataset.state==="failed"?"0 passed":"1 passed")})()'
          if [ "$state" = working ] || [ "$state" = review ]; then check 'document.querySelector(`[data-agent-id="phone.summary.running"]`)?.textContent.includes("1 running")'; fi
          if [ "$state" = failed ]; then check 'document.querySelector(`[data-agent-id="phone.summary.failed"]`)?.textContent.includes("1 failed")'; fi
        fi
        if [ "$state" = done ] && [ "$width" -le 600 ]; then check 'window.__fits(`[data-agent-id="block.text"]`) && window.__fits(`.md-tablewrap`) && document.querySelector(`[data-agent-id="transcript.root"]`).scrollWidth<=document.querySelector(`[data-agent-id="transcript.root"]`).clientWidth'; fi
        if [ "$state" = review ]; then check 'window.__fits(`[data-agent-id="approval.dock"]`)'; fi
        "${B[@]}" click '[data-agent-id="status.session-state"]' >/dev/null
        if [ "$state" = review ]; then wait_js 'document.querySelector(`[data-agent-id="approval.dock"]`).contains(document.activeElement)'; fi
        if [ "$state" = failed ]; then wait_js 'document.activeElement?.textContent.includes("Build failed")'; fi
        capture "$width-$theme-$state-auto-$auto"
        COUNT=$((COUNT+1))
      done
    done
  done
  "${B[@]}" eval '(()=>{window.__headerReview.set(`done`,true);return true})()' >/dev/null
  "${B[@]}" click '[data-agent-id="status.ctx"]' >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="session.controls.overlay"]`)'
  "${B[@]}" wait 180 >/dev/null
  if [ "$width" -le 900 ]; then check 'document.querySelector(`[data-agent-id="session.controls.overlay"]`).getBoundingClientRect().width<=304 && document.querySelector(`[data-agent-id="session.controls.overlay"]`).getBoundingClientRect().height<360 && !document.querySelector(`[data-agent-id="session.background.select"]`)'; fi
  capture "$width-controls"
  check '(innerWidth<=900?document.querySelector(`[data-agent-id="status.model.picker"]`).textContent:document.querySelector(`[data-agent-id="status.model.select"]`).value).includes(`mock-model-with-a-long-name`)'
  check 'window.__fits(`[data-agent-id="session.controls.overlay"]`) && document.querySelector(`[data-agent-id="session.controls.overlay"]`).scrollWidth<=document.querySelector(`[data-agent-id="session.controls.overlay"]`).clientWidth'
  "${B[@]}" press Shift+Tab >/dev/null
  check 'document.querySelector(`[data-agent-id="session.controls.overlay"]`).contains(document.activeElement)'
  "${B[@]}" press Escape >/dev/null
  wait_js 'document.activeElement?.dataset.agentId==="status.ctx"'
  "${B[@]}" click '[data-agent-id="status.details"]' >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="status.details.overlay"]`) && document.querySelector(`[data-agent-id="status.details.overlay"]`).contains(document.activeElement)'
  check 'window.__fits(`[data-agent-id="status.details.overlay"]`)'
  capture "$width-overflow"
  "${B[@]}" press Shift+Tab >/dev/null
  check 'document.querySelector(`[data-agent-id="status.details.overlay"]`).contains(document.activeElement)'
  "${B[@]}" press Escape >/dev/null
  wait_js 'document.activeElement?.dataset.agentId==="status.details"'
  # Title/workspace and Model must route to different surfaces at every size.
  "${B[@]}" click '[data-agent-id="status.workspace"] .session-name' >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="folders.overlay"]`) && !document.querySelector(`[data-agent-id="session.controls.overlay"]`)'
  check 'document.querySelector(`[data-agent-id="folders.intent"]`).dataset.state==="move" && window.__fits(`[data-agent-id="folders.overlay"]`)'
  if [ "$width" -le 900 ]; then
    check '(()=>{const p=document.querySelector(`[data-agent-id="folders.overlay"]`).getBoundingClientRect(),w=document.querySelector(`[data-agent-id="status.workspace"]`).getBoundingClientRect(),c=document.querySelector(`[data-agent-id="status.ctx"]`);return p.width<innerWidth&&p.height<=520&&p.bottom<=visualViewport.height&&w.width<=112&&c.querySelector(`svg`).getBoundingClientRect().width===38&&getComputedStyle(c.querySelector(`span`)).fontSize==="10px"})()'
  fi
  capture "$width-workspace-popup"
  "${B[@]}" click '[data-agent-id="folders.close"]' >/dev/null
  wait_js 'document.activeElement?.dataset.agentId==="status.workspace"'
  "${B[@]}" eval 'window.__headerReview.set("working",false)' >/dev/null
  "${B[@]}" click '[data-agent-id="status.workspace"]' >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="folders.overlay"]`)'
  check 'document.querySelector(`[data-agent-id="folders.use"]`).disabled && document.querySelector(`[data-agent-id="folders.use"]`).textContent.includes("Wait for work to finish") && !document.querySelector(`[data-agent-id="session.controls.overlay"]`)'
  "${B[@]}" click '[data-agent-id="folders.close"]' >/dev/null
  "${B[@]}" eval 'window.__headerReview.set("done",false)' >/dev/null
  if [ "$width" -gt 900 ]; then
    "${B[@]}" click '[data-agent-id="status.workspace"] .subtitle-copy' >/dev/null
    wait_js '!!document.querySelector(`[data-agent-id="folders.overlay"]`)'
    "${B[@]}" click '[data-agent-id="folders.close"]' >/dev/null
  fi
 done
"${B[@]}" set viewport 390 844 >/dev/null
"${B[@]}" wait 160 >/dev/null
for theme in ${HEADER_THEMES:-light dim dark}; do
  "${B[@]}" eval "(()=>{window.__headerReview.theme(\"$theme\");window.__headerReview.set(\"done\",false);return true})()" >/dev/null
  wait_js 'document.querySelector(`[data-agent-id="status.hud"]`).getBoundingClientRect().height===44'
  "${B[@]}" click '[data-agent-id="status.model-chip"]' >/dev/null
  "${B[@]}" wait 160 >/dev/null
  "${B[@]}" eval '(()=>{const p=document.querySelector(`[data-agent-id="session.controls.overlay"]`),s=getComputedStyle(p);window.__menuTheme=[s.backgroundColor,s.color,s.borderTopColor,s.borderRadius,s.fontFamily];return true})()' >/dev/null
  capture "390-$theme-model-popover"
  "${B[@]}" click '[data-agent-id="status.model.picker"]' >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="session.model.search"]`) && document.activeElement?.dataset.agentId==="session.picker.back"'
  check 'window.__fits(`[data-agent-id="session.controls.overlay"]`) && [...document.querySelectorAll(`[data-agent-id="session.model.option"]`)].some(e=>e.getAttribute("aria-pressed")==="true") && !document.querySelector(`[data-agent-id="status.model.select"]`)'
  capture "390-$theme-model-choices"
  "${B[@]}" fill '[data-agent-id="session.model.search"]' alternate >/dev/null
  wait_js 'document.querySelectorAll(`[data-agent-id="session.model.option"]`).length===1'
  "${B[@]}" click '[data-agent-id="session.model.option"]' >/dev/null
  wait_js 'document.querySelector(`[data-agent-id="status.model.picker"]`)?.textContent.includes("alternate-fixture-model") && document.activeElement?.dataset.agentId==="status.model.picker"'
  "${B[@]}" click '[data-agent-id="status.effort.picker"]' >/dev/null
  check 'window.__fits(`[data-agent-id="session.controls.overlay"]`)'
  capture "390-$theme-effort-choices"
  "${B[@]}" click '[data-agent-id="session.effort.option.high"]' >/dev/null
  wait_js 'document.querySelector(`[data-agent-id="status.effort.picker"]`)?.textContent.includes("high") && document.activeElement?.dataset.agentId==="status.effort.picker"'
  "${B[@]}" click '[data-agent-id="status.approval.picker"]' >/dev/null
  check 'window.__fits(`[data-agent-id="session.controls.overlay"]`) && document.querySelector(`[data-agent-id="session.approval.option.ask"]`).getAttribute("aria-pressed")==="true"'
  capture "390-$theme-permission-choices"
  "${B[@]}" press Escape >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="status.approval.picker"]`) && document.activeElement?.dataset.agentId==="status.approval.picker"'
  "${B[@]}" press Escape >/dev/null
  "${B[@]}" click '[data-agent-id="status.details"]' >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="status.details.overlay"]`)'
  check '(()=>{const s=getComputedStyle(document.querySelector(`[data-agent-id="status.details.overlay"]`));return JSON.stringify([s.backgroundColor,s.color,s.borderTopColor,s.borderRadius,s.fontFamily])===JSON.stringify(window.__menuTheme)})()'
  capture "390-$theme-details-popover"
  "${B[@]}" click '[data-agent-id="settings.open"]' >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="settings.overlay"]`)'
  check '(()=>{const s=getComputedStyle(document.querySelector(`[data-agent-id="settings.overlay"]`));return JSON.stringify([s.backgroundColor,s.color,s.borderTopColor,s.borderRadius,s.fontFamily])===JSON.stringify(window.__menuTheme)})()'
  "${B[@]}" press Escape >/dev/null
  "${B[@]}" click '[data-agent-id="status.details"]' >/dev/null
  "${B[@]}" focus '[data-agent-id="status.todos"]' >/dev/null
  "${B[@]}" wait 100 >/dev/null
  "${B[@]}" click '[data-agent-id="status.todos"]' >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="todos.overlay"]`) && !!document.querySelector(`[data-agent-id="todos.item.2"]`) && document.querySelector(`[data-agent-id="todos.overlay"]`).contains(document.activeElement)'
  check 'getComputedStyle(document.querySelector(`[data-agent-id="todos.root"]`)).display==="none" && document.querySelector(`.todos-row`).getBoundingClientRect().height===0 && window.__fits(`[data-agent-id="todos.overlay"]`) && document.querySelector(`[data-agent-id="todos.overlay"] progress`).value===1 && document.querySelector(`[data-agent-id="todos.overlay"] progress`).max===3'
  check '(()=>{const s=getComputedStyle(document.querySelector(`[data-agent-id="todos.overlay"]`));return JSON.stringify([s.backgroundColor,s.color,s.borderTopColor,s.borderRadius,s.fontFamily])===JSON.stringify(window.__menuTheme)})()'
  "${B[@]}" press Tab >/dev/null
  check 'document.querySelector(`[data-agent-id="todos.overlay"]`).contains(document.activeElement) && document.querySelector(`main`).inert'
  capture "390-$theme-todos-popover"
  "${B[@]}" press Escape >/dev/null
  wait_js '!document.querySelector(`[data-agent-id="todos.overlay"]`) && document.activeElement?.dataset.agentId==="status.details"'
  check 'getComputedStyle(document.querySelector(`.md`)).fontSize==="14px" && getComputedStyle(document.querySelector(`.b-user-text`)).fontSize==="14px" && getComputedStyle(document.querySelector(`[data-agent-id="composer.input"]`)).fontSize==="16px"'
done
"${B[@]}" set viewport 1280 844 >/dev/null
"${B[@]}" wait 160 >/dev/null
check 'getComputedStyle(document.querySelector(`.md`)).fontFamily.includes("Mono") && getComputedStyle(document.querySelector(`.md`)).fontSize==="13px" && document.querySelector(`[data-agent-id="status.hud"]`).getBoundingClientRect().height===(matchMedia(`(pointer: coarse)`).matches||matchMedia(`(hover: none)`).matches?44:32) && getComputedStyle(document.querySelector(`[data-agent-id="todos.root"]`)).display!=="none" && !document.querySelector(`[data-agent-id="todos.overlay"]`)'
"${B[@]}" set viewport 390 844 >/dev/null
"${B[@]}" eval '(()=>{window.__headerReview.set(`done`,false);window.__headerReview.setNoContext();return true})()' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="status.ctx"]`).textContent==="—"'
"${B[@]}" click '[data-agent-id="status.model-chip"]' >/dev/null
"${B[@]}" wait 180 >/dev/null
check 'parseFloat(getComputedStyle(document.querySelector(`.lbl`)).fontSize)>=11 && getComputedStyle(document.querySelector(`[data-agent-id="status.approval.picker"]`)).display!=="none" && !document.querySelector(`[data-agent-id="session.permission.always"]`) && document.querySelector(`[data-agent-id="session.controls.overlay"]`).textContent.includes("Context not reported") && document.querySelector(`[data-agent-id="session.controls.overlay"]`).getBoundingClientRect().width<=304 && document.querySelector(`[data-agent-id="session.controls.overlay"]`).getBoundingClientRect().height<360'
"${B[@]}" click '[data-agent-id="status.approval.picker"]' >/dev/null
"${B[@]}" click '[data-agent-id="session.approval.option.always"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="session.permission.confirm"]`)'
"${B[@]}" click '[data-agent-id="session.controls.close"]' >/dev/null
"${B[@]}" click '[data-agent-id="status.model-chip"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="session.controls.overlay"]`) && !document.querySelector(`[data-agent-id="session.permission.confirm"]`)'
capture '390-controls'
"${B[@]}" click '[data-agent-id="session.controls.more"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="session.background.select"]`) && !!document.querySelector(`[data-agent-id="session.fork"]`)'
check 'window.__fits(`[data-agent-id="session.controls.overlay"]`)'
"${B[@]}" press Escape >/dev/null
"${B[@]}" eval '(()=>{const b=document.querySelector(`[data-agent-id^="phone.work."] > button`);b.click();return true})()' >/dev/null
"${B[@]}" eval 'window.__headerReview.other()' >/dev/null
"${B[@]}" wait 120 >/dev/null
"${B[@]}" eval 'window.__headerReview.back()' >/dev/null
wait_js 'document.querySelector(`[data-agent-id^="phone.work."] > button`)?.getAttribute("aria-expanded")==="true"'
"${B[@]}" set viewport 768 844 >/dev/null
"${B[@]}" wait 120 >/dev/null
"${B[@]}" set viewport 390 844 >/dev/null
"${B[@]}" wait 120 >/dev/null
check 'document.querySelector(`[data-agent-id^="phone.work."] > button`).getAttribute("aria-expanded")==="true"'
"${B[@]}" click '[data-agent-id="phone.tool.fixture-tool"]' >/dev/null
check 'window.__fits(`[data-agent-id="drawer.block"]`)'
capture '390-tool-long-output'
"${B[@]}" click '[data-agent-id="drawer.block.close"]' >/dev/null
"${B[@]}" eval '(()=>{const buttons=[...document.querySelectorAll(`[data-agent-id="markdown.artifact.open"]`)];buttons.at(-1).click();return true})()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="artifact.frame"]`)'
check 'window.__fits(`[data-agent-id="artifact.overlay"]`)'
"${B[@]}" click '[data-agent-id="artifact.more"]' >/dev/null
"${B[@]}" wait 160 >/dev/null
check 'window.__fits(`[data-agent-id="artifact.overlay"]`)'
capture '390-report-overflow'
"${B[@]}" click '[data-agent-id="artifact.back"]' >/dev/null
# Summary stays one row even when passed/failed/running/pending coexist.
"${B[@]}" eval '(()=>{window.__sameWorkLine=()=>{const w=document.querySelector(`section[data-agent-id^="phone.work."]`),b=w.querySelector(`.summary`),h=b.querySelector(`.headline`),s=b.querySelector(`[data-agent-id="phone.summary.steps"]`),r=b.getBoundingClientRect(),t=h.getBoundingClientRect();return Math.abs(r.height-44)<1&&b.scrollWidth<=b.clientWidth&&h.clientWidth>40&&h.scrollWidth<=h.clientWidth&&!!s&&getComputedStyle(s).display!=="none"&&s.getBoundingClientRect().width>0&&s.scrollWidth<=s.clientWidth&&s.getBoundingClientRect().left>=t.right&&Math.abs((s.getBoundingClientRect().top+s.getBoundingClientRect().height/2)-(t.top+t.height/2))<1&&[...b.querySelectorAll(`.outcome`)].every(e=>{const c=e.getBoundingClientRect();return Math.abs((c.top+c.height/2)-(t.top+t.height/2))<1&&c.right<=r.right&&c.left>=r.left})};return true})()' >/dev/null
"${B[@]}" eval 'window.__headerReview.mixedWork()' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="phone.summary.pending"]`)?.textContent.includes("1 pending")'
for width in 320 360 390 600; do
  "${B[@]}" set viewport "$width" 844 >/dev/null
  "${B[@]}" wait 160 >/dev/null
  check 'window.__sameWorkLine() && document.querySelector(`section[data-agent-id^="phone.work."]`).dataset.state==="working" && document.querySelector(`[data-agent-id="phone.summary.passed"]`).textContent.includes("29 passed") && document.querySelector(`[data-agent-id="phone.summary.failed"]`).textContent.includes("1 failed") && document.querySelector(`[data-agent-id="phone.summary.running"]`).textContent.includes("2 running") && ![...document.querySelectorAll(`.sb-axis > .b-marker`)].some(e=>e.textContent.includes("call failed"))'
  "${B[@]}" eval '(()=>{const w=document.querySelector(`section[data-agent-id^="phone.work."]`),b=w.querySelector(`button`);if(b.getAttribute("aria-expanded")==="false")b.click();w.querySelector(`[data-agent-id="phone.work.earlier"]`)?.click();return true})()' >/dev/null
  wait_js '!!document.querySelector(`[data-agent-id="block.thinking"][data-state="thinking"]`)'
  check '(()=>{const t=document.querySelector(`[data-agent-id="block.thinking"][data-state="thinking"]`),s=t.querySelector(`summary`),p=t.querySelector(`.think-p`),label=s.querySelector(`.faint`),gap=p.getBoundingClientRect().top-label.getBoundingClientRect().bottom;return s.getBoundingClientRect().height>=44&&gap>=0&&gap<=6&&getComputedStyle(t).paddingTop==="0px"})()'
  capture "$width-work-outcomes-active"
done
"${B[@]}" set viewport 390 844 >/dev/null
# Stress the expanded card, not only its collapsed summary: long commands,
# reasoning, metadata and duplicate guidance must stay inside one scroll surface.
"${B[@]}" eval 'window.__headerReview.stress()' >/dev/null
wait_js 'document.querySelector(`section[data-agent-id^="phone.work."] > button`)?.textContent.includes("31 steps")'
check 'document.querySelector(`[data-agent-id="phone.summary.passed"]`).textContent.includes("30 passed") && document.querySelector(`[data-agent-id="phone.summary.failed"]`).textContent.includes("1 failed")'
"${B[@]}" eval '(()=>{const w=document.querySelector(`section[data-agent-id^="phone.work."]`),b=w.querySelector(`button`);if(b.getAttribute("aria-expanded")==="true")b.click();w.scrollIntoView({block:"start"});return true})()' >/dev/null
check 'window.__sameWorkLine() && document.querySelector(`[data-agent-id="phone.summary.steps"]`).textContent.includes("31 steps")'
capture '390-work-outcomes-collapsed'
"${B[@]}" eval '(()=>{const b=document.querySelector(`section[data-agent-id^="phone.work."] > button`);if(b.getAttribute("aria-expanded")==="false")b.click();return true})()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="phone.work.earlier"]`)'
check 'document.querySelectorAll(`section[data-agent-id^="phone.work."] .step`).length===13 && document.querySelectorAll(`[data-agent-id="phone.work.tip"]`).length===2 && document.querySelector(`[data-agent-id="phone.work.tip"]`).textContent.includes("×2") && !document.querySelector(`[data-agent-id="block.marker.batch"]`) && [...document.querySelectorAll(`section[data-agent-id^="phone.work."] [data-agent-id="block.marker"]`)].some(e=>e.textContent.includes("1 call failed")) && [...document.querySelectorAll(`.sb-axis > .b-marker.st-yellow`)].some(e=>e.textContent.includes("Workspace policy warning remains visible")) && ![...document.querySelectorAll(`.sb-axis > .b-marker`)].some(e=>e.textContent.includes("bash advisory:")) && !!document.querySelector(`[data-agent-id="phone.work.tip"].warning`)'
"${B[@]}" click '[data-agent-id="phone.work.earlier"]' >/dev/null
wait_js 'document.querySelectorAll(`section[data-agent-id^="phone.work."] .step`).length===31 && !document.querySelector(`[data-agent-id="phone.work.earlier"]`)'
"${B[@]}" eval '(()=>{for(const e of document.querySelectorAll(`section[data-agent-id^="phone.work."] details`))e.open=true;return true})()' >/dev/null
for width in 360 390; do
  "${B[@]}" set viewport "$width" 844 >/dev/null
  "${B[@]}" wait 180 >/dev/null
  for theme in ${HEADER_THEMES:-light dim dark}; do
    "${B[@]}" eval "window.__headerReview.theme(\"$theme\")" >/dev/null
    check '(()=>{const root=document.querySelector(`section[data-agent-id^="phone.work."]`),r=root.getBoundingClientRect();window.__fitFailures=[];for(const e of root.querySelectorAll(`*`)){const b=e.getBoundingClientRect();if(!b.width||!b.height)continue;const s=getComputedStyle(e);if(b.left<r.left-1||b.right>r.right+1||(e.scrollWidth>e.clientWidth+1&&/(auto|scroll)/.test(s.overflowX))||(e.scrollHeight>e.clientHeight+1&&/(auto|scroll)/.test(s.overflowY)))window.__fitFailures.push({tag:e.tagName,cls:e.className,left:b.left,right:b.right,scroll:e.scrollWidth,client:e.clientWidth});}return window.__fitFailures.length===0&&[...root.querySelectorAll(`button,summary`)].every(e=>e.getBoundingClientRect().height>=44)&&document.querySelector(`.sb`).scrollWidth<=document.querySelector(`.sb`).clientWidth})()'
    check 'window.__sameWorkLine() && (()=>{const t=document.querySelector(`[data-agent-id="block.thinking"]`),s=t.querySelector(`summary`),p=t.querySelector(`.think-p`),label=s.querySelector(`.faint`),gap=p.getBoundingClientRect().top-label.getBoundingClientRect().bottom;return s.getBoundingClientRect().height>=44&&gap>=0&&gap<=6&&parseFloat(getComputedStyle(p).fontSize)===13&&getComputedStyle(t.closest(`.row`)).paddingTop==="0px"})()'
    "${B[@]}" eval '(()=>{document.querySelector(`section[data-agent-id^="phone.work."]`).scrollIntoView({block:"start"});return true})()' >/dev/null
    capture "$width-$theme-work-expanded"
    "${B[@]}" eval '(()=>{document.querySelector(`[data-agent-id="block.thinking"]`).scrollIntoView({block:"center"});return true})()' >/dev/null
    capture "$width-$theme-thinking-spacing"
  done
done
# Show all keeps rich tools, while recognized warning-level Bash tips stay contained.
"${B[@]}" click '[data-agent-id="status.details"]' >/dev/null
"${B[@]}" click '[data-agent-id="settings.open"]' >/dev/null
"${B[@]}" click '[data-agent-id="tools.view.all"]' >/dev/null
"${B[@]}" press Escape >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="tool.fixture-tool"]`)'
"${B[@]}" eval '(()=>{const w=document.querySelector(`section[data-agent-id^="phone.work."]`);if(w.querySelector(`button`).getAttribute("aria-expanded")==="false")w.querySelector(`button`).click();w.scrollIntoView({block:"center"});return true})()' >/dev/null
check 'document.querySelectorAll(`[data-agent-id="phone.work.tip"]`).length===2 && !document.querySelector(`[data-agent-id="block.marker.advisory"]`) && ![...document.querySelectorAll(`.sb-axis > .b-marker`)].some(e=>e.textContent.includes("bash advisory:")||e.textContent.includes("call failed")) && !!document.querySelector(`section[data-agent-id^="phone.work."] [data-agent-id="block.marker"]`) && getComputedStyle(document.querySelector(`section[data-agent-id^="phone.work."] [data-agent-id="block.marker"]`).closest(`.notice`)).paddingTop==="6px" && [...document.querySelectorAll(`.sb-axis > .b-marker.st-yellow`)].some(e=>e.textContent.includes("Workspace policy warning remains visible"))'
capture '390-show-all-contained-tips'
"${B[@]}" click '[data-agent-id="status.details"]' >/dev/null
"${B[@]}" click '[data-agent-id="settings.open"]' >/dev/null
"${B[@]}" click '[data-agent-id="tools.view.compact"]' >/dev/null
"${B[@]}" press Escape >/dev/null
# Mobile history acceptance: realistic multi-turn prose, notices, code and tables.
"${B[@]}" set viewport 390 844 >/dev/null
"${B[@]}" eval 'window.__headerReview.history()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="transcript.older"]`)'
"${B[@]}" eval '(()=>{const sb=document.querySelector(`.sb`);sb.scrollTop=0;sb.dispatchEvent(new Event("scroll"));const root=document.querySelector(`.sb-axis`);window.__historyAnchor=[...root.children].find(e=>e.dataset.agentId&&e.dataset.agentId!=="transcript.older"&&e.dataset.agentId!=="transcript.collapse-work");window.__historyTop=window.__historyAnchor.getBoundingClientRect().top;return true})()' >/dev/null
"${B[@]}" eval 'document.querySelector(`[data-agent-id="transcript.older"]`).click()' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="transcript.older"]`)'
"${B[@]}" wait 200 >/dev/null
check 'window.__historyAnchor.isConnected&&Math.abs(window.__historyAnchor.getBoundingClientRect().top-window.__historyTop)<2&&document.querySelector(`.sb`).scrollTop>100&&document.querySelectorAll(`[data-agent-id="block.text.copy"]`).length===70'
for theme in ${HEADER_THEMES:-light dim dark}; do
  "${B[@]}" eval "(()=>{window.__headerReview.theme(\"$theme\");const sb=document.querySelector(\`.sb\`);const u=[...document.querySelectorAll(\`[data-agent-id=\"block.user\"]\`)].find(e=>e.textContent.includes(\"History request 68:\"));u.scrollIntoView({block:\"start\"});return true})()" >/dev/null
  check '(()=>{const sb=document.querySelector(`.sb`),md=document.querySelector(`.md`),u=document.querySelector(`.b-user-text`),c=document.querySelector(`.md-code`);const root=document.querySelector(`.sb-axis`),prompt=[...root.children].find(e=>e.dataset.agentId==="block.user"&&e.textContent.includes("History request 68:")),previous=prompt.previousElementSibling,gap=prompt.getBoundingClientRect().top-previous.getBoundingClientRect().bottom;return sb.scrollWidth<=sb.clientWidth&&gap>=16&&gap<=24&&getComputedStyle(md).fontFamily.includes("system-ui")&&getComputedStyle(md).fontSize==="14px"&&getComputedStyle(u).fontSize==="14px"&&getComputedStyle(c).fontFamily.includes("Mono")&&parseFloat(getComputedStyle(md).lineHeight)>=21})()'
  capture "390-$theme-history"
done
# A notification after the latest answer must not remove its Copy action.
check '!document.querySelector(`[data-agent-id="transcript.jump"]`)?.textContent.includes("new")'
"${B[@]}" eval '(()=>{window.__headerReview.event("info","A new history notice");return true})()' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="transcript.jump"]`)?.textContent.includes("1 new")'
check '[...document.querySelectorAll(`[data-agent-id="block.text"]`)].filter(e=>e.querySelector(`[data-agent-id="block.text.copy"]`)).every(e=>e.textContent.includes("History answer"))'
# Inline diff modality: the viewer is outside inert history; background stays inert.
"${B[@]}" eval 'document.querySelector(`[data-agent-id="status.details"]`).click()' >/dev/null
"${B[@]}" click '[data-agent-id="settings.open"]' >/dev/null
"${B[@]}" click '[data-agent-id="tools.view.all"]' >/dev/null
"${B[@]}" press Escape >/dev/null
"${B[@]}" eval '(()=>{const e=[...document.querySelectorAll(`[data-agent-id="diff.open"]`)].at(-1);for(let p=e.parentElement;p;p=p.parentElement)if(p.tagName==="DETAILS")p.open=true;e.scrollIntoView({block:"center"});e.focus();e.click();return true})()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="diff.overlay"]`) && document.querySelector(`[data-agent-id="diff.overlay"]`).contains(document.activeElement)'
check 'document.querySelector(`main`).inert&&!document.querySelector(`[data-agent-id="diff.overlay"]`).closest(`[inert]`)&&!!document.querySelector(`[data-agent-id="diff.scrim"]`)'
"${B[@]}" press Shift+Tab >/dev/null
check 'document.querySelector(`[data-agent-id="diff.overlay"]`).contains(document.activeElement)'
"${B[@]}" click '[data-agent-id="diff.close"]' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="diff.overlay"]`) && !document.querySelector(`main`).inert && document.activeElement?.dataset.agentId==="diff.open"'
"${B[@]}" eval 'window.__headerReview.set("done",false)' >/dev/null
# Session/reset isolation: no modal may silently retarget to the replacement session.
"${B[@]}" click '[data-agent-id="status.model-chip"]' >/dev/null
"${B[@]}" eval 'window.__headerReview.other()' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="session.controls.overlay"]`) && !document.querySelector(`main`).inert'
"${B[@]}" eval 'window.__headerReview.back()' >/dev/null
"${B[@]}" click '[data-agent-id="status.model-chip"]' >/dev/null
"${B[@]}" eval 'window.__headerReview.resetHost()' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="session.controls.overlay"]`) && !document.querySelector(`main`).inert'
# Late native sharing failure belongs to the old report, never its replacement.
"${B[@]}" eval '(()=>{window.__savedShare=navigator.share;window.__savedCanShare=navigator.canShare;navigator.canShare=()=>true;navigator.share=()=>new Promise((resolve,reject)=>{window.__shareReject=reject});window.__headerReview.shareReport();return true})()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="artifact.share"]`)'
"${B[@]}" click '[data-agent-id="artifact.share"]' >/dev/null
"${B[@]}" click '[data-agent-id="artifact.back"]' >/dev/null
"${B[@]}" eval 'window.__headerReview.shareReport()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="artifact.overlay"]`)'
"${B[@]}" eval 'window.__shareReject(new Error("old share failure"))' >/dev/null
"${B[@]}" wait 120 >/dev/null
check '!document.querySelector(`[data-agent-id="artifact.state.status"]`)'
"${B[@]}" click '[data-agent-id="artifact.back"]' >/dev/null
"${B[@]}" eval '(()=>{navigator.share=window.__savedShare;navigator.canShare=window.__savedCanShare;window.__headerReview.set("done",false);return true})()' >/dev/null
"${B[@]}" focus '[data-agent-id="composer.input"]' >/dev/null
"${B[@]}" eval '(()=>{Object.defineProperty(visualViewport,"height",{value:320,configurable:true});visualViewport.dispatchEvent(new Event(`resize`));return true})()' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="app.root"]`).getBoundingClientRect().height===320'
check 'document.querySelector(`[data-agent-id="status.hud"]`).getBoundingClientRect().height===44 && document.querySelector(`[data-agent-id="transcript.root"]`).getBoundingClientRect().height>150'
"${B[@]}" click '[data-agent-id="status.details"]' >/dev/null
check '(()=>{const m=document.querySelector(`[data-agent-id="status.details.overlay"]`),r=m.getBoundingClientRect();return r.top>=0&&r.bottom<=320&&window.__fits(`[data-agent-id="status.details.overlay"]`)})()'
"${B[@]}" press Escape >/dev/null
"${B[@]}" click '[data-agent-id="status.ctx"]' >/dev/null
"${B[@]}" wait 180 >/dev/null
check '(()=>{const m=document.querySelector(`[data-agent-id="session.controls.overlay"]`),r=m.getBoundingClientRect();return r.top>=0&&r.bottom<=320&&window.__fits(`[data-agent-id="session.controls.overlay"]`)})()'
capture '390-keyboard-controls'
"${B[@]}" click '[data-agent-id="status.model.picker"]' >/dev/null
"${B[@]}" focus '[data-agent-id="session.model.search"]' >/dev/null
check '(()=>{const p=document.querySelector(`[data-agent-id="session.controls.overlay"]`).getBoundingClientRect();return p.top>=0&&p.bottom<=320&&window.__fits(`[data-agent-id="session.controls.overlay"]`)})()'
capture '390-keyboard-model-choices'
"${B[@]}" click '[data-agent-id="session.controls.close"]' >/dev/null
"${B[@]}" click '[data-agent-id="status.workspace"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="folders.overlay"]`)'
check '(()=>{const p=document.querySelector(`[data-agent-id="folders.overlay"]`).getBoundingClientRect();return p.top>=0&&p.bottom<=320&&p.height<320&&window.__fits(`[data-agent-id="folders.overlay"]`)})()'
capture '390-keyboard-workspace'
"${B[@]}" click '[data-agent-id="folders.close"]' >/dev/null
"${B[@]}" click '[data-agent-id="status.details"]' >/dev/null
"${B[@]}" focus '[data-agent-id="status.todos"]' >/dev/null
"${B[@]}" click '[data-agent-id="status.todos"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="todos.overlay"]`)'
check '(()=>{const p=document.querySelector(`[data-agent-id="todos.overlay"]`),r=p.getBoundingClientRect();return r.top>=0&&r.bottom<=320&&window.__fits(`[data-agent-id="todos.overlay"]`)})()'
capture '390-keyboard-todos'
echo "HEADER REVIEW PASSED: $COUNT width/theme/state/permission combinations; long content, state actions, focus, disclosure persistence and keyboard checks"
