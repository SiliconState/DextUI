#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
source apps/web/scripts/dxb-test.sh
PORT=${PORT:-8799}
OUT=$(mktemp -d apps/web/dist.staging.artifact-theme.XXXXXX)
TMP=$(mktemp -d)
SRV=''
cleanup() {
  "${B[@]}" close >/dev/null 2>&1 || true
  if [ -n "$SRV" ]; then kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; fi
  rm -rf "$TMP" "$OUT"
}
trap cleanup EXIT
(cd apps/web && npm exec -- vite build --config scripts/header-review.vite.ts --outDir "${OUT#apps/web/}" >"$TMP/build.log" 2>&1) || { cat "$TMP/build.log"; exit 1; }
node packages/mock-server/src/server.mjs --port="$PORT" --static="$OUT" >"$TMP/server.log" 2>&1 &
SRV=$!
sleep 1
"${B[@]}" open "http://127.0.0.1:$PORT" >/dev/null
"${B[@]}" wait --fn '!!window.__headerReview' >/dev/null
for width in 390 1280; do
  "${B[@]}" set viewport "$width" 844 >/dev/null
  "${B[@]}" eval '(()=>{window.__probe=null;if(window.__probeListener)window.removeEventListener("message",window.__probeListener);window.__probeListener=e=>{if(e.source===document.querySelector(`[data-agent-id="artifact.frame"]`)?.contentWindow&&e.data?.probe)window.__probe=e.data};window.addEventListener("message",window.__probeListener);window.__probeHTML=`<html><body><input value="original"><script>const boot=Math.random(),initialTheme=document.documentElement.dataset.theme;addEventListener("message",e=>{if(e.source!==parent)return;if(e.data?.edit)document.querySelector("input").value=e.data.edit;if(e.data?.probe)parent.postMessage({probe:true,boot,initialTheme,value:document.querySelector("input").value,theme:document.documentElement.dataset.theme},"*")})</script></body></html>`;window.__headerReview.shareReport(window.__probeHTML);return true})()' >/dev/null
  "${B[@]}" wait '[data-agent-id="artifact.frame"]' >/dev/null
  "${B[@]}" wait 300 >/dev/null
  "${B[@]}" eval '(()=>{window.__frame=document.querySelector(`[data-agent-id="artifact.frame"]`);window.__doc=window.__frame.srcdoc;window.__frame.contentWindow.postMessage({edit:"unsaved",probe:true},"*");return true})()' >/dev/null
  "${B[@]}" wait --fn 'window.__probe?.value==="unsaved"' >/dev/null
  "${B[@]}" eval 'window.__boot=window.__probe.boot' >/dev/null
  for theme in light dark dim; do
    "${B[@]}" eval "window.__headerReview.theme('$theme')" >/dev/null
    "${B[@]}" wait 150 >/dev/null
    "${B[@]}" eval 'window.__probe=null;window.__frame.contentWindow.postMessage({probe:true},"*")' >/dev/null
    "${B[@]}" wait --fn "window.__probe?.theme==='$theme' && window.__probe?.value==='unsaved' && window.__probe.boot===window.__boot && window.__frame===document.querySelector('[data-agent-id=\"artifact.frame\"]') && window.__frame.srcdoc===window.__doc" >/dev/null
  done
  "${B[@]}" press Escape >/dev/null
  "${B[@]}" wait --fn '!document.querySelector(`[data-agent-id="artifact.frame"]`)' >/dev/null
  # Same HTML, new report revision: authored startup code must see the new
  # initial theme, not only receive a corrective postMessage after boot.
  "${B[@]}" eval '(()=>{window.__headerReview.theme("light");window.__probe=null;window.__headerReview.shareReport(window.__probeHTML);return true})()' >/dev/null
  "${B[@]}" wait '[data-agent-id="artifact.frame"]' >/dev/null
  "${B[@]}" wait 200 >/dev/null
  "${B[@]}" eval 'document.querySelector(`[data-agent-id="artifact.frame"]`).contentWindow.postMessage({probe:true},"*")' >/dev/null
  "${B[@]}" wait --fn 'window.__probe?.initialTheme==="light" && window.__probe?.value==="original" && window.__probe.boot!==window.__boot' >/dev/null
  "${B[@]}" press Escape >/dev/null
  "${B[@]}" wait --fn '!document.querySelector(`[data-agent-id="artifact.frame"]`)' >/dev/null
  echo "PASS: $width px iframe retains state across themes and reopens with a fresh initial theme"
done
