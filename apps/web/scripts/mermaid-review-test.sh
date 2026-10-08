#!/usr/bin/env bash
# Mermaid/PWA fixture. No live host, provider or session mutations.
set -euo pipefail
cd "$(dirname "$0")/../../.."
if ! command -v agent-browser >/dev/null 2>&1; then echo 'SKIP: agent-browser unavailable; Mermaid review not run'; exit 0; fi
PORT=${PORT:-8798}
OUT=apps/web/dist.header-review
TMP=$(mktemp -d)
B=(agent-browser --session dext-mermaid-review)
SRV=''
cleanup() { "${B[@]}" close >/dev/null 2>&1 || true; [ -z "$SRV" ] || kill "$SRV" 2>/dev/null || true; rm -rf "$TMP" "$OUT"; }
trap cleanup EXIT
[ -z "${SCREENSHOTS:-}" ] || mkdir -p "$SCREENSHOTS"
capture() { [ -z "${SCREENSHOTS:-}" ] || "${B[@]}" screenshot "$SCREENSHOTS/$1.png" >/dev/null; }
check() { local out; out=$("${B[@]}" eval "$1"); if [ "$out" != true ]; then echo "FAIL: $1"; echo "$out"; "${B[@]}" eval '(()=>{const img=document.querySelector(`[data-agent-id="mermaid.image"]`);return img?{natural:[img.naturalWidth,img.naturalHeight],actual:img.getBoundingClientRect().toJSON(),status:document.querySelector(`[data-agent-id="markdown.mermaid"]`).dataset.state}:null})()'; "${B[@]}" snapshot; capture mermaid-failure; exit 1; fi; }
wait_js() { if ! "${B[@]}" wait --timeout 20000 --fn "$1" >/dev/null; then echo "FAIL waiting: $1"; "${B[@]}" snapshot; "${B[@]}" errors; capture mermaid-failure; exit 1; fi; }
(cd apps/web && npm exec -- vite build --config scripts/header-review.vite.ts >"$TMP/build.log" 2>&1) || { cat "$TMP/build.log"; exit 1; }
node packages/mock-server/src/server.mjs --port="$PORT" --static="$OUT" >"$TMP/server.log" 2>&1 &
SRV=$!
sleep 1
"${B[@]}" set viewport 375 812 >/dev/null
"${B[@]}" open "http://127.0.0.1:$PORT" >/dev/null
wait_js '!!window.__headerReview'
"${B[@]}" eval '(()=>{window.__revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=u=>{window.__revoked.push(u);revoke(u)};return true})()' >/dev/null
"${B[@]}" eval '(()=>{window.__flow="flowchart LR\n  A[Any browser] --> B[HTTPS + login]\n  B --> C[DextUI host]\n  C --> D[dext agent]\n  C --> E[Saved state]";window.__flow2="flowchart LR\n  A[Any browser] --> B[Cloudflare Access]\n  B --> C[Named tunnel]\n  C --> D[DextUI host]\n  D --> E[dext and files]";window.__engineLoads=()=>performance.getEntriesByType("resource").filter(e=>/mermaid-render/.test(e.name)).length;return true})()' >/dev/null
check 'window.__engineLoads()===0'
# Register the existing PWA cache. This fixture is never shipped.
"${B[@]}" eval 'navigator.serviceWorker.register("/sw.js?v=mermaid-review").then(()=>true)' >/dev/null
wait_js '!!navigator.serviceWorker.controller'
"${B[@]}" eval '(()=>{window.__resourceAttempts=[];const ImageOriginal=window.Image;window.Image=function(...args){window.__resourceAttempts.push("Image");return new ImageOriginal(...args)};window.__renderAttempts=0;window.__scratchObserver=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node instanceof HTMLElement&&node.style.left==="-100000px")window.__renderAttempts++});window.__scratchObserver.observe(document.body,{childList:true});return true})()' >/dev/null
# Unsafe and unfinished diagrams must not even import the engine.
"${B[@]}" eval 'window.__headerReview.diagram("flowchart LR\nA[<img src=https://invalid.example/x>]")' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="fallback"'
check 'window.__engineLoads()===0 && !document.querySelector(`[data-agent-id="mermaid.image"]`) && document.querySelector(`[data-agent-id="mermaid.source"]`).textContent.includes("<img")'
for attack in quoted-image escaped-image sequence-properties c4-style c4-keyword c4-attribute; do
  "${B[@]}" eval "(()=>{const samples={\"c4-style\":'C4Context\\nPerson(a,\"A\")\\nUpdateElementStyle(a,\"u\\\\\\\\72l(/blocked-paint.svg)\")',\"c4-keyword\":'C4Context\\nPerson(a,\"A\")\\nUpdateElementStyle(a,\"red\")',\"c4-attribute\":'C4Context\\nPerson(a,\"A\",\u0024bgColor=\"red\")',\"quoted-image\":'flowchart LR\\nA@{ \"img\": \"/sessions/test/file/blocked.png\" }',\"escaped-image\":'flowchart LR\\nA@{ \"\\\\\\\\u0069mg\": \"/blocked.png\" }',\"sequence-properties\":'sequenceDiagram\\nparticipant A\\nproperties A: {\"icon\":\"/blocked.svg\"}'};window.__blockedSource=samples[\"$attack\"];window.__headerReview.diagram(window.__blockedSource);return true})()" >/dev/null
  "${B[@]}" wait 120 >/dev/null
  wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="fallback" && document.querySelector(`[data-agent-id="mermaid.source"]`)?.textContent===window.__blockedSource'
  check 'window.__engineLoads()===0&&window.__resourceAttempts.length===0&&window.__renderAttempts===0&&!performance.getEntriesByType("resource").some(e=>/blocked(?:-paint)?\.(png|svg)/.test(e.name))'
done
"${B[@]}" eval 'window.__headerReview.diagram(window.__flow,false)' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="pending"'
check 'window.__engineLoads()===0 && document.querySelector(`[data-agent-id="mermaid.status"]`).textContent.includes("drawing")'
"${B[@]}" eval 'window.__headerReview.diagram(window.__flow,true,true)' >/dev/null
"${B[@]}" wait 250 >/dev/null
check 'window.__engineLoads()===0'
"${B[@]}" eval 'document.querySelector(`[data-agent-id="markdown.mermaid"]`).scrollIntoView({block:"center"})' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="rendered" && document.querySelector(`[data-agent-id="mermaid.image"]`).complete'
"${B[@]}" eval '(()=>{window.__firstAssets=performance.getEntriesByType("resource").filter(e=>e.name.includes("/assets/")).map(e=>e.name);return true})()' >/dev/null
check '!window.__firstAssets.some(p=>/elk-|katex-|cytoscape/.test(p))'
"${B[@]}" eval 'fetch(document.querySelector(`[data-agent-id="mermaid.image"]`).src).then(r=>r.text()).then(svg=>{const doc=new DOMParser().parseFromString(svg,"image/svg+xml");window.__svgMarkersOK=doc.querySelectorAll("marker").length>0&&[...doc.querySelectorAll("[marker-end]")].every(e=>/^url\(#[\w:.-]+\)$/.test(e.getAttribute("marker-end")))&&doc.querySelectorAll("[marker-end]").length>0;return true})' >/dev/null
check 'window.__svgMarkersOK===true'
"${B[@]}" eval 'JSON.stringify({firstDiagramAssets:window.__firstAssets})'
for width in 320 375 768 1280; do
  "${B[@]}" set viewport "$width" 812 >/dev/null
  "${B[@]}" wait 200 >/dev/null
  for theme in light dark dim; do
    "${B[@]}" eval "(()=>{window.__headerReview.theme(\"$theme\");window.__headerReview.diagram(window.__flow);return true})()" >/dev/null
    "${B[@]}" wait 150 >/dev/null
    wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="rendered" && document.querySelector(`[data-agent-id="mermaid.image"]`).complete'
    check '(()=>{const d=document.querySelector(`[data-agent-id="markdown.mermaid"]`),c=d.querySelector(`[data-agent-id="mermaid.canvas"]`),img=d.querySelector(`img`),r=d.getBoundingClientRect(),ir=img.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth&&c.scrollWidth<=c.clientWidth&&ir.width<=c.clientWidth&&img.naturalWidth>0&&getComputedStyle(c).overflowX==="hidden"&&!d.querySelector(`svg,iframe,foreignObject`)&&(innerWidth>900||[...d.querySelectorAll(`button`)].every(e=>e.getBoundingClientRect().height>=44))&&document.documentElement.scrollWidth<=innerWidth})()'
    if [ "$width" -le 375 ]; then check '(()=>{const d=document.querySelector(`[data-agent-id="markdown.mermaid"]`),i=d.querySelector(`img`),r=i.getBoundingClientRect();return d.textContent.includes("vertical fit")&&r.height/r.width>0.7&&r.width/i.naturalWidth>0.7})()'; fi
    "${B[@]}" click '[data-agent-id="mermaid.source.toggle"]' >/dev/null
    check 'document.querySelector(`[data-agent-id="mermaid.source"]`).textContent===window.__flow'
    "${B[@]}" click '[data-agent-id="mermaid.source.toggle"]' >/dev/null
    "${B[@]}" eval '(()=>{window.__imageBeforeZoom=document.querySelector(`[data-agent-id="mermaid.image"]`).src;return true})()' >/dev/null
    "${B[@]}" click '[data-agent-id="mermaid.zoom"]' >/dev/null
    check '(()=>{const c=document.querySelector(`[data-agent-id="mermaid.canvas"]`),i=c.querySelector(`img`);return getComputedStyle(c).overflowX==="auto"&&c.tabIndex===0&&i.src===window.__imageBeforeZoom&&document.documentElement.scrollWidth<=innerWidth})()'
    if [ "$width" = 375 ] && [ "$theme" = dark ]; then
      "${B[@]}" eval 'document.documentElement.style.setProperty("--mobile-viewport-height","320px")' >/dev/null
      check 'document.querySelector(`[data-agent-id="mermaid.canvas"]`).getBoundingClientRect().height<=200'
      "${B[@]}" eval 'document.documentElement.style.removeProperty("--mobile-viewport-height")' >/dev/null
    fi
    "${B[@]}" click '[data-agent-id="mermaid.zoom"]' >/dev/null
    capture "$width-$theme-mermaid-fit"
  done
done
for kind in second sequence state subgraph invalid; do
  "${B[@]}" eval "(()=>{const samples={second:window.__flow2,sequence:\"sequenceDiagram\\nparticipant P as Phone\\nparticipant H as Host\\nP->>H: Message\\nH-->>P: Answer\",state:\"stateDiagram-v2\\n[*] --> Idle\\nIdle --> Active: Message\\nActive --> [*]\",subgraph:\"flowchart TD\\nsubgraph Browser\\nA[Web UI] --> B[Controls]\\nend\\nB --> C[Host]\",invalid:\"not-a-diagram\\nA nonsense B\"};window.__headerReview.diagram(samples[\"$kind\"]);return true})()" >/dev/null
  "${B[@]}" wait 150 >/dev/null
  if [ "$kind" = invalid ]; then
    wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="fallback"'
    check 'document.querySelector(`[data-agent-id="mermaid.source"]`).textContent.includes("not-a-diagram")'
  else
    wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="rendered" && document.querySelector(`[data-agent-id="mermaid.image"]`).complete'
  fi
  capture "$kind-mermaid"
done
# Failed diagrams stay source-backed on scroll re-entry, without repeated work.
"${B[@]}" eval '(()=>{window.__failedAttempts=window.__renderAttempts;const d=document.querySelector(`[data-agent-id="markdown.mermaid"]`);d.style.marginTop="10000px";document.querySelector(`.sb`).scrollTop=0;return true})()' >/dev/null
"${B[@]}" wait 200 >/dev/null
"${B[@]}" eval '(()=>{const d=document.querySelector(`[data-agent-id="markdown.mermaid"]`);d.style.marginTop="0";d.scrollIntoView({block:"center"});return true})()' >/dev/null
"${B[@]}" wait 300 >/dev/null
check 'document.querySelector(`[data-agent-id="markdown.mermaid"]`).dataset.state==="fallback"&&window.__renderAttempts===window.__failedAttempts'
"${B[@]}" click '[data-agent-id="mermaid.retry"]' >/dev/null
wait_js 'window.__renderAttempts===window.__failedAttempts+1 && document.querySelector(`[data-agent-id="markdown.mermaid"]`).dataset.state==="fallback"'
# Streaming completion/incomplete final source, then reset cleanup.
"${B[@]}" eval 'window.__headerReview.diagram(window.__flow,false)' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="pending"'
"${B[@]}" eval 'window.__headerReview.event("text_block_complete","```mermaid\n"+window.__flow)' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="mermaid.status"]`)?.textContent.includes("Incomplete diagram") && !!document.querySelector(`[data-agent-id="mermaid.source"]`)'
"${B[@]}" eval 'window.__headerReview.diagram(window.__flow2)' >/dev/null
"${B[@]}" wait 150 >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="rendered"'
"${B[@]}" eval '(()=>{window.__resetURL=document.querySelector(`[data-agent-id="mermaid.image"]`).src;window.__headerReview.resetHost();return true})()' >/dev/null
"${B[@]}" wait 150 >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="rendered" && document.querySelector(`[data-agent-id="mermaid.image"]`).src!==window.__resetURL'
check 'window.__revoked.includes(window.__resetURL) && !document.querySelector(`[id^="dextdiagram"]`)'
# Image failure recovers with Retry; old image events cannot erase a new image.
"${B[@]}" eval '(()=>{window.__oldImage=document.querySelector(`[data-agent-id="mermaid.image"]`);window.__oldImage.dispatchEvent(new Event("error"));return true})()' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`).dataset.state==="fallback" && !document.querySelector(`[data-agent-id="mermaid.image"]`)'
"${B[@]}" click '[data-agent-id="mermaid.retry"]' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`).dataset.state==="rendered" && document.querySelector(`[data-agent-id="mermaid.image"]`).complete'
"${B[@]}" eval 'window.__oldImage.dispatchEvent(new Event("error"))' >/dev/null
check 'document.querySelector(`[data-agent-id="markdown.mermaid"]`).dataset.state==="rendered"'
"${B[@]}" eval '(()=>{window.__signedOutURL=document.querySelector(`[data-agent-id="mermaid.image"]`).src;window.__headerReview.needsToken(true);return true})()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="connect.form"]`) && !document.querySelector(`[data-agent-id="mermaid.image"]`) && window.__revoked.includes(window.__signedOutURL)'
"${B[@]}" eval 'window.__headerReview.needsToken(false)' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="rendered"'
# A failure cannot poison the next render; callbacks cannot execute or load URLs.
"${B[@]}" eval 'window.__headerReview.diagram(window.__flow2)' >/dev/null
"${B[@]}" wait 150 >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="rendered"'
"${B[@]}" eval '(()=>{window.__copy="";Object.defineProperty(navigator,"clipboard",{value:{writeText:async text=>{window.__copy=text}},configurable:true});return true})()' >/dev/null
"${B[@]}" click '[data-agent-id="mermaid.copy"]' >/dev/null
check 'window.__copy===window.__flow2'
# Demand-loaded render assets are cacheable; no diagram/session data is cached.
"${B[@]}" eval 'caches.open("dextui-mermaid-review").then(async c=>{window.__cached=(await c.keys()).map(r=>r.url);return true})' >/dev/null
check 'window.__cached.some(p=>p.includes("mermaid-render")) && !window.__cached.some(p=>p.includes("/sessions/")||p.startsWith("blob:"))'
"${B[@]}" eval 'JSON.stringify({cachedAssets:window.__cached.filter(p=>p.includes("/assets/")),loadedAssets:performance.getEntriesByType("resource").filter(e=>e.name.includes("/assets/")).map(e=>e.name)})'
# Offline PWA assets are reusable even without an in-memory module/cache hit.
"${B[@]}" eval '(()=>{window.__offlineModule=window.__cached.find(p=>p.includes("mermaid-render"));return true})()' >/dev/null
"${B[@]}" set offline on >/dev/null
"${B[@]}" eval 'fetch(window.__offlineModule).then(r=>{window.__offlineAssetOK=r.ok;return r.text()}).then(s=>{window.__offlineAssetSize=s.length;return true})' >/dev/null
check 'window.__offlineAssetOK && window.__offlineAssetSize>1000'
"${B[@]}" eval 'window.__headerReview.diagram("flowchart LR\nA[Offline phone] --> B[Cached renderer]")' >/dev/null
"${B[@]}" wait 150 >/dev/null
wait_js 'document.querySelector(`[data-agent-id="markdown.mermaid"]`)?.dataset.state==="rendered" && document.querySelector(`[data-agent-id="mermaid.image"]`).complete'
capture 'offline-mermaid'
"${B[@]}" set offline off >/dev/null
echo 'MERMAID REVIEW PASSED: lazy/visible/streaming, source/copy, themes, phone fit/zoom, SVG isolation and PWA cache'
