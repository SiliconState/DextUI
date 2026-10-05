#!/usr/bin/env bash
# Isolated file-based docs regression gate; no host or external service needed.
set -euo pipefail
cd "$(dirname "$0")/../.."
if ! command -v agent-browser >/dev/null 2>&1; then
  echo 'SKIP: agent-browser unavailable; documentation browser checks not run'
  exit 0
fi
B=(agent-browser --session dext-spec-test)
trap '"${B[@]}" close >/dev/null 2>&1 || true' EXIT
check() {
  local expression="$1"
  local output
  output=$("${B[@]}" eval "$expression")
  if [[ "$output" != true ]]; then printf 'FAIL: %s\n%s\n' "$expression" "$output"; exit 1; fi
}
"${B[@]}" set viewport 1440 1000 >/dev/null
"${B[@]}" open "file://$PWD/docs/DextUISpec.html" >/dev/null
check 'document.querySelectorAll("section[data-title]").length===19 && document.querySelectorAll(".diagram svg").length===6'
check '[...document.querySelectorAll("a[href^=\"#\"]")].every(a=>!!document.querySelector(a.getAttribute("href")))'
check '[...document.querySelectorAll(".diagram svg")].every(svg=>[...svg.querySelectorAll("text")].every(t=>{const b=t.getBBox(),v=svg.viewBox.baseVal;return b.x>=0&&b.y>=0&&b.x+b.width<=v.width&&b.y+b.height<=v.height}))'
"${B[@]}" click '#search-open' >/dev/null
"${B[@]}" fill '#search-input' 'nonce' >/dev/null
check 'document.getElementById("search-dialog").open && document.querySelector("#search-results a").hash==="#delivery"'
"${B[@]}" press Escape >/dev/null
check '!document.getElementById("search-dialog").open && document.activeElement.id==="search-open"'
"${B[@]}" click '#search-open' >/dev/null
"${B[@]}" fill '#search-input' 'zzzz-no-such-chapter' >/dev/null
check 'document.querySelectorAll("#search-results a").length===0 && document.getElementById("search-status").textContent.includes("No matching")'
"${B[@]}" fill '#search-input' 'backup' >/dev/null
"${B[@]}" press Enter >/dev/null
check '!document.getElementById("search-dialog").open && location.hash==="#recovery"'
"${B[@]}" click '#theme-toggle' >/dev/null
check 'document.documentElement.dataset.theme==="dark"'
"${B[@]}" click '#theme-toggle' >/dev/null
check 'document.documentElement.dataset.theme==="light"'
"${B[@]}" eval '(()=>{document.querySelector(".copy").click();return true})()' >/dev/null
check 'getSelection().toString().length>0 || [...document.querySelectorAll(".copy")].some(b=>b.textContent==="Copied")'
for width in 320 390 768 1024 1440 1920; do
 "${B[@]}" set viewport "$width" 900 >/dev/null
 check 'document.documentElement.scrollWidth<=innerWidth'
 if [ "$width" -le 800 ]; then
  check 'document.getElementById("sidebar").inert'
  "${B[@]}" click '#nav-toggle' >/dev/null
  check 'document.querySelector("main").inert && document.getElementById("sidebar").contains(document.activeElement)'
  "${B[@]}" press Shift+Tab >/dev/null
  check 'document.getElementById("sidebar").contains(document.activeElement)'
  "${B[@]}" press Escape >/dev/null
  check '!document.querySelector("main").inert && document.getElementById("sidebar").inert && document.activeElement.id==="nav-toggle"'
 else
  check '!document.getElementById("sidebar").inert && !document.querySelector("main").inert'
 fi
done
"${B[@]}" eval '(()=>{document.querySelector("details summary").click();return true})()' >/dev/null
check 'document.querySelector("details").open'
"${B[@]}" eval '(()=>{dispatchEvent(new Event("beforeprint"));return true})()' >/dev/null
check '[...document.querySelectorAll("details")].every(d=>d.open)'
"${B[@]}" eval '(()=>{dispatchEvent(new Event("afterprint"));return true})()' >/dev/null
check 'document.querySelector("details").open && !document.querySelectorAll("details")[1].open'
printf 'PASS: documentation structure, links, SVG bounds, search, Escape/Enter, theme, copy, incident disclosure, and six responsive widths.\n'
