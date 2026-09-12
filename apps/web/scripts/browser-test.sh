set -uo pipefail
# Gate entry (npm test): the browser smoke runs wherever agent-browser is
# installed and SKIPS with a visible note elsewhere, so hosts without it stay
# green without silently dropping the gate.
if ! command -v agent-browser >/dev/null 2>&1; then
  echo "SKIP: agent-browser not installed — browser smoke not run (install the agent_browser pack to enable)"
  exit 0
fi
cd "$(dirname "$0")/../../.."
PORT="${PORT:-8793}"
# Isolation: the gate builds its own copy of the app and serves THAT — the
# served apps/web/dist is never written by a test run, so a failing gate
# leaves the served build untouched (the same promise ui-build makes).
OUT="apps/web/dist.smoke"
rm -rf "$OUT"
if ! (cd apps/web && npm exec -- vite build --outDir dist.smoke --emptyOutDir >/tmp/dextui-bt-build.log 2>&1); then
  echo "FAIL: smoke build"
  tail -40 /tmp/dextui-bt-build.log
  exit 1
fi
node packages/mock-server/src/server.mjs --port=$PORT --token=browsertest --static="$OUT" >/tmp/dextui-bt-mock.log 2>&1 &
SRV=$!
cleanup() { agent-browser close --all >/dev/null 2>&1; kill $SRV 2>/dev/null; rm -rf "$OUT"; }
trap cleanup EXIT
sleep 1.2
B="http://127.0.0.1:$PORT"
FAIL=0
wait_js() { local js="$1" n=0; until agent-browser eval "$js" 2>/dev/null | grep -q 'true'; do n=$((n+1)); if [ $n -gt 80 ]; then echo "TIMEOUT: $js"; FAIL=1; return 1; fi; sleep 0.25; done; }
note() { echo "== $1"; }

agent-browser close --all >/dev/null 2>&1
agent-browser open "$B" >/dev/null
agent-browser wait '[data-agent-id="connect.token"]' >/dev/null
agent-browser fill '[data-agent-id="connect.token"]' browsertest >/dev/null
agent-browser click '[data-agent-id="connect.submit"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="session.sess_001.open"]`)' || exit 1
agent-browser click '[data-agent-id="session.sess_001.open"]' >/dev/null
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null
sleep 0.8

note "composer: soft-wrap grows, clear shrinks, hard lines cap at 8 rows"
WRAP=$(printf 'word%.0s ' $(seq 80))
agent-browser fill '[data-agent-id="composer.input"]' "$WRAP" >/dev/null
sleep 0.3
H1=$(agent-browser eval 'Math.round(parseFloat(document.querySelector(`[data-agent-id="composer.input"]`).style.height)||0)' | tr -dc '0-9')
agent-browser fill '[data-agent-id="composer.input"]' '' >/dev/null
sleep 0.2
H0=$(agent-browser eval 'Math.round(parseFloat(document.querySelector(`[data-agent-id="composer.input"]`).style.height)||0)' | tr -dc '0-9')
MULTI=$(printf 'line %.0s\n' $(seq 24))
agent-browser fill '[data-agent-id="composer.input"]' "$MULTI" >/dev/null
sleep 0.3
HC=$(agent-browser eval 'Math.round(parseFloat(document.querySelector(`[data-agent-id="composer.input"]`).style.height)||0)' | tr -dc '0-9')
OV=$(agent-browser eval 'document.querySelector(`[data-agent-id="composer.input"]`).style.overflowY')
echo "heights: wrapped=$H1 empty=$H0 capped=$HC overflow=$OV"
{ [ "$H1" -gt 28 ] && [ "$H1" -le 165 ] && [ "$H0" -gt 0 ] && [ "$H0" -le 30 ] && [ "$HC" -le 165 ]; } || { echo "FAIL: heights"; FAIL=1; }
echo "$OV" | grep -q auto || { echo "FAIL: overflow not auto at cap"; FAIL=1; }

note "composer: slash menu Escape keeps draft, Enter completes, Enter sends"
agent-browser fill '[data-agent-id="composer.input"]' '/h' >/dev/null
wait_js 'document.querySelectorAll(`[data-agent-id="composer.menu"] .c-menu-row`).length > 0' || FAIL=1
agent-browser press Escape >/dev/null
wait_js 'document.querySelectorAll(`[data-agent-id="composer.menu"]`).length === 0 && document.querySelector(`[data-agent-id="composer.input"]`).value === "/h"' || { echo "FAIL: escape/draft"; FAIL=1; }
agent-browser fill '[data-agent-id="composer.input"]' '/he' >/dev/null
wait_js 'document.querySelectorAll(`[data-agent-id="composer.menu"] .c-menu-row`).length > 0' || FAIL=1
agent-browser press Enter >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.input"]`).value.endsWith(" ")' || { echo "FAIL: enter-complete"; FAIL=1; }
agent-browser press Enter >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.input"]`).value === ""' || { echo "FAIL: send"; FAIL=1; }
H2=$(agent-browser eval 'Math.round(parseFloat(document.querySelector(`[data-agent-id="composer.input"]`).style.height)||0)' | tr -dc '0-9')
echo "height after send: $H2"
[ "$H2" -le 30 ] || { echo "FAIL: height reset after send"; FAIL=1; }

note "composer: selected session + unsent draft survive a page reload"
agent-browser click '[data-agent-id="session.sess_002.open"]' >/dev/null
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null
agent-browser fill '[data-agent-id="composer.input"]' 'unsent reload draft' >/dev/null
sleep 0.6 # let the 250 ms debounce persist it
agent-browser open "$B" >/dev/null
sleep 1
# The pairing token may or may not be restored — reconnect if the login screen shows.
agent-browser eval '(()=>{const t=document.querySelector(`[data-agent-id="connect.token"]`);if(!t)return false;t.value="browsertest";document.querySelector(`[data-agent-id="connect.submit"]`).click();return true})()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="session.sess_001.open"]`)' || { echo "FAIL: reload session list"; FAIL=1; }
wait_js 'document.querySelector(`[data-agent-id="session.sess_002.open"]`)?.dataset.state === "active" && localStorage.getItem("dextui.activeSession") === "sess_002"' || { echo "FAIL: selected session not restored after reload"; FAIL=1; }
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.input"]`).value === "unsent reload draft"' || { echo "FAIL: draft lost on reload"; FAIL=1; }
agent-browser fill '[data-agent-id="composer.input"]' '' >/dev/null

note "active thinking survives page reload and preview stays capped at four lines"
# Use a fresh live echo session, not a seeded replay fixture. Retry through the
# known new-session/persona teardown race until the transcript is truly empty.
for i in $(seq 1 12); do
  agent-browser eval 'document.querySelector(`[data-agent-id="persona.skip"]`)?.click();document.querySelector(`[data-agent-id="session.new"]`)?.click();true' >/dev/null 2>&1
  sleep 0.35
  agent-browser eval '!!document.querySelector(`[data-agent-id="transcript.empty"]`)' 2>/dev/null | grep -q true && break
done
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null
agent-browser fill '[data-agent-id="composer.input"]' 'thinking preview demo' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.send"]`)?.dataset.state === "ready"' || { echo "FAIL: thinking session composer not ready"; FAIL=1; }
agent-browser click '[data-agent-id="composer.send"]' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="block.thinking"][data-state="thinking"] .think-p.stream`)?.textContent.includes("reasoning-120")' || { echo "FAIL: active thinking preview did not appear"; FAIL=1; }
wait_js '(()=>{const p=document.querySelector(`[data-agent-id="block.thinking"][data-state="thinking"] .think-p.stream`);if(!p)return false;const s=getComputedStyle(p);const lines=parseFloat(s.maxHeight)/parseFloat(s.lineHeight);return lines>=3.9&&lines<=4.1&&p.scrollHeight>p.clientHeight})()' || { echo "FAIL: active thinking preview is not capped at four lines"; FAIL=1; }
agent-browser open "$B" >/dev/null
sleep 0.4
agent-browser eval '(()=>{const t=document.querySelector(`[data-agent-id="connect.token"]`);if(!t)return false;t.value="browsertest";document.querySelector(`[data-agent-id="connect.submit"]`).click();return true})()' >/dev/null
wait_js '(()=>{const id=localStorage.getItem("dextui.activeSession");return !!id&&document.querySelector(`[data-agent-id="session.${id}.open"]`)?.dataset.state==="active"})()' || { echo "FAIL: working session not restored after reload"; FAIL=1; }
wait_js '[...document.querySelectorAll(`[data-agent-id="block.text"]`)].some(x=>x.textContent.includes("Thinking preview complete")) && !document.querySelector(`[data-agent-id="composer.stop"]`)' || { echo "FAIL: active turn did not survive reload"; FAIL=1; }
# Continue fixture-specific checks in the seeded text session.
agent-browser click '[data-agent-id="session.sess_001.open"]' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.input"]`)?.dataset.session === "sess_001"' || { echo "FAIL: seeded session not selected after reload test"; FAIL=1; }
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null

note "native slash compaction updates CTX and keeps summary collapsed"
agent-browser fill '[data-agent-id="composer.input"]' '/compact' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.send"]`)?.dataset.state === "ready"' || { echo "FAIL: compaction session composer not ready"; FAIL=1; }
agent-browser press Enter >/dev/null
wait_js 'document.querySelector(`[data-agent-id="block.compact"]`)?.dataset.state === "running" && !!document.querySelector(`[data-agent-id="status.compacting"]`) && document.querySelector(`[data-agent-id="composer.input"]`)?.dataset.state === "compacting"' || { echo "FAIL: compaction progress state"; FAIL=1; }
wait_js '(()=>{const b=document.querySelector(`[data-agent-id="block.compact"]`);const c=document.querySelector(`[data-agent-id="status.ctx"]`);return b?.dataset.state==="complete"&&!b.open&&!b.querySelector(`[data-agent-id="block.compact.summary"]`)&&b.textContent.includes("48 → 11 messages")&&b.textContent.includes("1.2k context")&&c?.dataset.source==="history"&&c.textContent.includes("compacted")&&c.title.includes("Context after compaction: 1.2k")&&!document.querySelector(`[data-agent-id="status.compacting"]`)})()' || { echo "FAIL: compact history/CTX projection"; FAIL=1; }
agent-browser click '[data-agent-id="block.compact"] summary' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="block.compact.summary"]`)?.textContent.includes("current objective")' || { echo "FAIL: compact summary details"; FAIL=1; }

note "attachments route native images through read_image consent and preserve document handoff"
agent-browser eval '(()=>{const i=document.querySelector(`[data-agent-id="composer.attach.input"]`);const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(`iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=`),c=>c.charCodeAt(0))],`screen sample.png`,{type:`image/png`}));i.files=d.files;i.dispatchEvent(new Event(`change`,{bubbles:true}));return true})()' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.attachment"]`)?.dataset.state === "done" && !!document.querySelector(`[data-agent-id="composer.attachment.vision"]`)' || { echo "FAIL: native vision attachment state"; FAIL=1; }
agent-browser fill '[data-agent-id="composer.input"]' 'inspect image' >/dev/null
agent-browser press Enter >/dev/null
wait_js '[...document.querySelectorAll(`[data-agent-id="block.user"]`)].at(-1)?.textContent.includes("call read_image(path)") && [...document.querySelectorAll(`[data-agent-id="block.user"]`)].at(-1)?.textContent.includes("request approval before sanitized pixels are sent")' || { echo "FAIL: read_image attachment handoff"; FAIL=1; }
wait_js '(()=>{const card=document.querySelector(`[data-agent-id^="approval.req_"][data-state="awaiting_approval"]`);const row=document.querySelector(`[data-agent-id^="queue."][data-state="awaiting_approval"]`);return !!card && card.textContent.includes("Share image pixels") && card.textContent.includes("Risk: sensitive read") && card.textContent.includes("uploads/screen sample.png") && card.textContent.includes("Share once") && card.textContent.includes("Always share") && card.querySelector(`[data-agent-id$=".disclosure"]`)?.textContent.includes("send its pixels to the active model provider") && !!row?.querySelector(`[data-agent-id$=".review"]`) && !row.querySelector(`[data-agent-id$=".once"]`)})()' || { echo "FAIL: image disclosure approval/review gate"; FAIL=1; }
agent-browser eval 'document.querySelector(`[data-agent-id^="approval.req_"] [data-agent-id$=".once"]`)?.click()' >/dev/null
wait_js '(()=>{const g=[...document.querySelectorAll(`.activity[data-state="complete"]`)].find(x=>x.textContent.includes("screen sample.png"));return !!g&&g.textContent.includes("Viewed image")&&!g.textContent.includes("Inspected")&&g.textContent.includes("image → context")&&!document.querySelector(`[data-agent-id="tool.vision_1"]`)})()' || { echo "FAIL: compact image outcome summary"; FAIL=1; }
agent-browser eval '(()=>{const g=[...document.querySelectorAll(`.activity[data-state="complete"]`)].find(x=>x.textContent.includes("screen sample.png"));g?.querySelector(`:scope > button`)?.click();return !!g})()' >/dev/null
agent-browser eval 'document.querySelector(`[data-agent-id$=".tool.vision_1"] > .activity-tool-head > button`)?.click()' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="tool.vision_1.status"]`)?.textContent.includes("image → context") && !!document.querySelector(`[data-agent-id$=".tool.vision_1.inspect"]`)' || { echo "FAIL: image detail/Raw drill-down"; FAIL=1; }
agent-browser eval 'document.querySelector(`[data-agent-id$=".tool.vision_1"]`)?.closest(`.activity`)?.querySelector(`:scope > button`)?.click();true' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="tool.vision_1"]`)' || { echo "FAIL: image group did not close lazily"; FAIL=1; }
wait_js '!document.querySelector(`[data-agent-id="composer.stop"]`)' || { echo "FAIL: image attachment turn did not finish"; FAIL=1; }

note "attachments accept Office documents and preserve a format-aware handoff"
agent-browser eval '(()=>{const i=document.querySelector(`[data-agent-id="composer.attach.input"]`);const d=new DataTransfer();d.items.add(new File([`mock-docx`],`brief.DOCX`,{type:`application/vnd.openxmlformats-officedocument.wordprocessingml.document`}));i.files=d.files;i.dispatchEvent(new Event(`change`,{bubbles:true}));return true})()' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.attachment"]`)?.dataset.state === "done" && document.querySelector(`[data-agent-id="composer.attachment"]`)?.textContent.includes("brief.DOCX")' || { echo "FAIL: Office attachment upload"; FAIL=1; }
agent-browser fill '[data-agent-id="composer.input"]' 'inspect attachment' >/dev/null
agent-browser press Enter >/dev/null
wait_js '[...document.querySelectorAll(`[data-agent-id="block.user"]`)].at(-1)?.textContent.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document") && [...document.querySelectorAll(`[data-agent-id="block.user"]`)].at(-1)?.textContent.includes("format-aware tools") && !document.querySelector(`[data-agent-id="composer.attachment"]`)' || { echo "FAIL: format-aware attachment handoff"; FAIL=1; }
wait_js '!document.querySelector(`[data-agent-id="composer.stop"]`)' || { echo "FAIL: attachment turn did not finish"; FAIL=1; }

note "session controls are scoped, compact, and mutually exclusive with settings"
agent-browser click '[data-agent-id="status.controls"]' >/dev/null
agent-browser wait '[data-agent-id="session.controls.overlay"]' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="session.controls.overlay"]`)?.textContent.includes("This session") && document.querySelector(`[data-agent-id="session.controls.overlay"]`)?.textContent.includes("Thinking") && document.querySelector(`[data-agent-id="session.controls.overlay"]`)?.textContent.includes("Permissions")' || { echo "FAIL: session controls labels"; FAIL=1; }
agent-browser click '[data-agent-id="session.controls.scrim"]' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="session.controls.overlay"]`)' || { echo "FAIL: session controls stayed open"; FAIL=1; }
agent-browser click '[data-agent-id="settings.open"]' >/dev/null
agent-browser wait '[data-agent-id="settings.overlay"]' >/dev/null
agent-browser eval 'document.querySelector(`[data-agent-id="status.controls"]`)?.click()' >/dev/null
agent-browser wait '[data-agent-id="session.controls.overlay"]' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="settings.overlay"]`)' || { echo "FAIL: status popovers overlap"; FAIL=1; }
agent-browser click '[data-agent-id="session.controls.scrim"]' >/dev/null

note "charts render and follow theme via settings menu (echo session — fixture sessions replay canned text)"
agent-browser click '[data-agent-id="session.new"]' >/dev/null
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null
sleep 0.8
agent-browser fill '[data-agent-id="composer.input"]' 'markdown demo' >/dev/null
agent-browser press Enter >/dev/null
wait_js 'document.querySelectorAll(`.chart-wrap`).length >= 3' || { echo "FAIL: charts"; FAIL=1; }
wait_js '!!document.querySelector(`[data-agent-id="markdown.artifact.open"]`)' || { echo "FAIL: artifact launcher"; FAIL=1; }
agent-browser click '[data-agent-id="markdown.artifact.open"]' >/dev/null
agent-browser wait '[data-agent-id="artifact.overlay"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="artifact.frame"]`) && document.querySelectorAll(`[data-agent-id="markdown.artifact"] iframe`).length === 0' || { echo "FAIL: artifact should render only in inspector"; FAIL=1; }
agent-browser click '[data-agent-id="artifact.code"]' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="artifact.source"]`)?.textContent.includes("Interactive report demo")' || { echo "FAIL: artifact source view"; FAIL=1; }
agent-browser click '[data-agent-id="artifact.report"]' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="artifact.frame"]`)' || { echo "FAIL: artifact report view"; FAIL=1; }
agent-browser press Escape >/dev/null
wait_js '!document.querySelector(`[data-agent-id="artifact.overlay"]`) && !!document.querySelector(`[data-agent-id="markdown.artifact.open"]`)' || { echo "FAIL: artifact history link/close"; FAIL=1; }

note "workspace HTML reports inline local images without exposing the access token"
agent-browser fill '[data-agent-id="composer.input"]' 'artifact file demo' >/dev/null
agent-browser press Enter >/dev/null
wait_js 'document.querySelectorAll(`[data-agent-id="markdown.artifact.open"]`).length >= 2' || { echo "FAIL: file artifact launcher"; FAIL=1; }
agent-browser eval '[...document.querySelectorAll(`[data-agent-id="markdown.artifact.open"]`)].at(-1)?.click()' >/dev/null
agent-browser wait '[data-agent-id="artifact.frame"]' >/dev/null
wait_js '(()=>{const f=document.querySelector(`[data-agent-id="artifact.frame"]`);const src=f?.srcdoc||"";return src.includes("data:image/png;base64,") && !src.includes("?t=")})()' || { echo "FAIL: file artifact image/token isolation"; FAIL=1; }
wait_js '!!document.querySelector(`[data-agent-id="markdown.document"]`) && document.querySelector(`[data-agent-id="markdown.document"] a`)?.hasAttribute("download")' || { echo "FAIL: office document download"; FAIL=1; }
agent-browser press Escape >/dev/null
sleep 1.5
# Theme is an explicit choice in the settings menu now, not a blind cycle.
CHART1='getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim()'
SURF='getComputedStyle(document.documentElement).getPropertyValue("--bg3").trim() + "|" + getComputedStyle(document.documentElement).getPropertyValue("--chart-grid").trim()'
BARFILL='getComputedStyle(document.querySelector(".chart-wrap svg rect")).fill'
pick_theme() { agent-browser click "[data-agent-id=\"theme.set.$1\"]" >/dev/null; sleep 0.35; }
agent-browser click '[data-agent-id="settings.open"]' >/dev/null
agent-browser wait '[data-agent-id="settings.overlay"]' >/dev/null
pick_theme light
CL=$(agent-browser eval "$CHART1"); FL=$(agent-browser eval "$BARFILL")
pick_theme dark
TD=$(agent-browser eval 'document.documentElement.dataset.theme' | tr -d '"')
CD=$(agent-browser eval "$CHART1"); FD=$(agent-browser eval "$BARFILL"); BD=$(agent-browser eval "$SURF")
pick_theme dim
TM=$(agent-browser eval 'document.documentElement.dataset.theme' | tr -d '"'); BM=$(agent-browser eval "$SURF")
agent-browser click '[data-agent-id="settings.scrim"]' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="settings.overlay"]`)' || { echo "FAIL: settings menu stayed open"; FAIL=1; }
echo "themes: light -> $TD -> $TM; chart-1 light/dark: $CL / $CD"
echo "surfaces dark/dim: $BD / $BM; bar fill light/dark: $FL / $FD"
{ [ "$TD" = "dark" ] && [ "$TM" = "dim" ]; } || { echo "FAIL: theme.set did not apply"; FAIL=1; }
[ "$CL" != "$CD" ] || { echo "FAIL: --chart-1 unchanged light→dark"; FAIL=1; }
[ "$FL" != "$FD" ] || { echo "FAIL: bar fill unchanged light→dark"; FAIL=1; }
[ "$BD" != "$BM" ] || { echo "FAIL: dim surfaces identical to dark (dim not a distinct theme)"; FAIL=1; }

note "interactive report receives the exact dim theme after startup scripts"
agent-browser eval 'window.__reportTheme=null;window.addEventListener("message",e=>{if(e.source===document.querySelector(`[data-agent-id="artifact.frame"]`)?.contentWindow&&e.data?.reportTheme)window.__reportTheme=e.data.reportTheme});document.querySelector(`[data-agent-id="markdown.artifact.open"]`)?.click()' >/dev/null
wait_js 'window.__reportTheme === "dim"' || { echo "FAIL: report startup overrode dim theme"; FAIL=1; }
agent-browser press Escape >/dev/null

note "tool activity: structural work folds, Bash stays rich, every edit remains inspectable"
agent-browser fill '[data-agent-id="composer.input"]' 'tool folding demo' >/dev/null
agent-browser press Enter >/dev/null
# Open the completed first group while Thinking is still active; neither
# thinking completion nor later tool/turn updates may close the user's choice.
wait_js '!!document.querySelector(`[data-agent-id="block.thinking"][data-state="thinking"]`) && !!document.querySelector(`.activity[data-state="complete"]`)' || { echo "FAIL: folding/thinking overlap fixture"; FAIL=1; }
agent-browser eval 'document.querySelector(`.activity[data-state="complete"] > button`)?.click()' >/dev/null
wait_js 'document.querySelector(`.activity[data-state="complete"] > button`)?.getAttribute("aria-expanded") === "true"' || { echo "FAIL: could not open work while thinking"; FAIL=1; }
wait_js '[...document.querySelectorAll(`[data-agent-id="block.text"]`)].at(-1)?.textContent.includes("Tool folding demo complete")' || { echo "FAIL: tool folding turn did not finish"; FAIL=1; }
wait_js 'document.querySelector(`.activity[data-state="complete"] > button`)?.getAttribute("aria-expanded") === "true"' || { echo "FAIL: thinking/turn completion auto-closed work"; FAIL=1; }
# Dext's conversational progress remains prominent; it is never consumed by a
# tool fold or replaced with a tiny technical summary.
wait_js '(()=>{const texts=[...document.querySelectorAll(`[data-agent-id="block.text"]`)];const p=texts.find(x=>x.textContent.includes("Inspecting the transcript renderer"));const w=texts.find(x=>x.textContent.includes("Writing the generated presentation fixture"));return !!p&&!p.closest(`.activity`)&&!!w&&!w.closest(`.activity`)})()' || { echo "FAIL: Dext progress prose was folded"; FAIL=1; }
# Close the user-opened first group explicitly so the compact/lazy defaults
# below can inspect the remaining completed groups without changing the rule.
agent-browser eval 'document.querySelector(`.activity[data-state="complete"] > button`)?.click()' >/dev/null
# Clean read/edit groups are pre-folded and lazy: their output DOM is absent,
# not merely hidden. The failed structural group opens itself.
wait_js '(()=>{const a=[...document.querySelectorAll(`.activity`)];const clean=a.filter(x=>x.dataset.state==="complete");const failed=a.find(x=>x.dataset.state==="failed");return clean.length>=6&&clean.every(x=>x.querySelector(`:scope > button`)?.getAttribute(`aria-expanded`)==="false"&&!x.querySelector(`[data-agent-id$=".details"]`))&&failed?.querySelector(`:scope > button`)?.getAttribute(`aria-expanded`)==="true"})()' || { echo "FAIL: activity fold defaults/lazy DOM"; FAIL=1; }
# Bash is deliberately outside structural folding and keeps its visible preview.
wait_js 'document.querySelector(`[data-agent-id="tool.fold-bash.tail"]`)?.textContent.includes("249 tests passed") && !document.querySelector(`[data-agent-id="tool.fold-bash"]`)?.closest(`.activity`)' || { echo "FAIL: Bash lost its rich standalone layer"; FAIL=1; }
# write_file, HTTP, read_image and commit get tasteful, distinct summaries
# without losing their exact detail/Raw path. Image keeps its meaningful outcome.
wait_js '(()=>{const a=[...document.querySelectorAll(`.activity[data-state="complete"]`)];const web=a.find(x=>x.textContent.includes("Browsed web"));const image=a.find(x=>x.textContent.includes("Viewed image"));const read=a.find(x=>x.textContent.includes("Inspected"));return a.some(x=>x.textContent.includes("Wrote")&&x.textContent.includes("generated.ts"))&&!!web&&!web.textContent.includes("Inspected")&&web.textContent.includes("GET https://example.test")&&web.textContent.includes("HTTP 200 OK")&&!!image&&!image.textContent.includes("Inspected")&&image.textContent.includes("review.png")&&image.textContent.includes("image → context")&&!!read&&!read.textContent.includes("Browsed web")&&!read.textContent.includes("Viewed image")&&a.some(x=>x.textContent.includes("Committed")&&x.textContent.includes("Fold tool activity")&&x.textContent.includes("commit abc1234"))})()' || { echo "FAIL: distinct special tool summaries"; FAIL=1; }
agent-browser eval '(()=>{for(const id of [`fold-write`,`fold-http`,`fold-image`,`fold-commit`]){const g=[...document.querySelectorAll(`.activity`)].find(x=>x.textContent.includes(id==="fold-write"?`generated.ts`:id==="fold-http"?`example.test`:id==="fold-image"?`review.png`:`Fold tool activity`));g?.querySelector(`:scope > button`)?.click();}return true})()' >/dev/null
wait_js '[`fold-write`,`fold-http`,`fold-image`,`fold-commit`].every(id=>!!document.querySelector(`[data-agent-id$=".tool.${id}"]`))' || { echo "FAIL: special tool rows not reachable"; FAIL=1; }
agent-browser eval '(()=>{for(const id of [`fold-write`,`fold-http`,`fold-image`,`fold-commit`])document.querySelector(`[data-agent-id$=".tool.${id}"] > .activity-tool-head > button`)?.click();return true})()' >/dev/null
wait_js '[`fold-write`,`fold-http`,`fold-image`,`fold-commit`].every(id=>!!document.querySelector(`[data-agent-id="tool.${id}"] .tool-full`)&&!!document.querySelector(`[data-agent-id$=".tool.${id}.inspect"]`))' || { echo "FAIL: special tool detail/Raw path"; FAIL=1; }
# Objective + all phase transitions coalesce to one quiet strip; latest phase is visible.
wait_js '(()=>{const m=[...document.querySelectorAll(`[data-agent-id^="activity.meta."]`)].filter(x=>!x.dataset.agentId.endsWith(`.details`));return m.length===1&&m[0].textContent.includes("objective")&&m[0].textContent.includes("verify")&&m[0].textContent.includes("4 updates")})()' || { echo "FAIL: objective/phase did not coalesce"; FAIL=1; }
# Read group → individual call → existing output disclosure: all details survive.
agent-browser eval '(()=>{const g=[...document.querySelectorAll(`.activity[data-state="complete"]`)].find(x=>x.textContent.includes(`Inspected`));g?.querySelector(`:scope > button`)?.click();return !!g})()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id$=".tool.fold-read"]`) && !document.querySelector(`[data-agent-id="tool.fold-read.content"]`)' || { echo "FAIL: read calls not reachable/lazy"; FAIL=1; }
agent-browser eval 'document.querySelector(`[data-agent-id$=".tool.fold-read"] > .activity-tool-head > button`)?.click()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="tool.fold-read"] .tool-full`)' || { echo "FAIL: original read tool card not mounted on demand"; FAIL=1; }
agent-browser click '[data-agent-id="tool.fold-read"] .tool-full > summary' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="tool.fold-read.content"]`)?.textContent.includes("transcript rendering")' || { echo "FAIL: read output lost behind folds"; FAIL=1; }
# Edit group preserves the same drill-down, including the exact multi-edit diff.
agent-browser eval '(()=>{const g=[...document.querySelectorAll(`.activity[data-state="complete"]`)].find(x=>x.textContent.includes(`Changed`));g?.querySelector(`:scope > button`)?.click();return !!g})()' >/dev/null
agent-browser eval 'document.querySelector(`[data-agent-id$=".tool.fold-multi"] > .activity-tool-head > button`)?.click()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="tool.fold-multi"] .tool-full`) && !!document.querySelector(`[data-agent-id$=".tool.fold-multi.inspect"]`)' || { echo "FAIL: original multi-edit tool card/Raw action not mounted on demand"; FAIL=1; }
agent-browser click '[data-agent-id="tool.fold-multi"] .tool-full > summary' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="tool.fold-multi"] .tool-full`)?.textContent.includes("Changed files")' || { echo "FAIL: multi-edit diff no longer inspectable"; FAIL=1; }
# Parent and nested disclosure choices survive switching away and back. Only a
# page refresh resets them.
agent-browser eval 'localStorage.setItem("dextui.foldTestSession",localStorage.getItem("dextui.activeSession")||"");document.querySelector(`[data-agent-id="session.sess_001.open"]`)?.click();true' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="session.sess_001.open"]`)?.dataset.state === "active"' || { echo "FAIL: fold persistence switch away"; FAIL=1; }
agent-browser eval '(()=>{const id=localStorage.getItem("dextui.foldTestSession");document.querySelector(`[data-agent-id="session.${id}.open"]`)?.click();return !!id})()' >/dev/null
wait_js '(()=>{const id=localStorage.getItem("dextui.foldTestSession");return document.querySelector(`[data-agent-id="session.${id}.open"]`)?.dataset.state==="active"&&!!document.querySelector(`[data-agent-id="tool.fold-read"] .tool-full`)&&!!document.querySelector(`[data-agent-id="tool.fold-multi"] .tool-full`)})()' || { echo "FAIL: fold/tool state lost across session switch"; FAIL=1; }
localStorageCleanup='localStorage.removeItem("dextui.foldTestSession")'
agent-browser eval "$localStorageCleanup" >/dev/null
# Device setting restores the fully verbose rendering, then compact mode folds it again.
agent-browser click '[data-agent-id="settings.open"]' >/dev/null
agent-browser click '[data-agent-id="tools.view.all"]' >/dev/null
wait_js '!document.querySelector(`.activity`) && !!document.querySelector(`[data-agent-id="tool.fold-read"]`) && !!document.querySelector(`[data-agent-id="tool.fold-multi"]`) && localStorage.getItem("dextui.compactTools") === "0"' || { echo "FAIL: Show all work details"; FAIL=1; }
agent-browser click '[data-agent-id="tools.view.compact"]' >/dev/null
wait_js 'document.querySelectorAll(`.activity`).length >= 3 && localStorage.getItem("dextui.compactTools") === "1"' || { echo "FAIL: restore compact work details"; FAIL=1; }
agent-browser click '[data-agent-id="settings.scrim"]' >/dev/null
# One contextual action refolds everything and unmounts all heavy detail DOM.
agent-browser eval 'document.querySelector(`.activity[data-state="failed"] > button`)?.click()' >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="transcript.collapse-work"]`)' || { echo "FAIL: collapse work action unavailable"; FAIL=1; }
agent-browser click '[data-agent-id="transcript.collapse-work"]' >/dev/null
wait_js '[...document.querySelectorAll(`.activity`)].every(x=>x.querySelector(`:scope > button`)?.getAttribute(`aria-expanded`)==="false")&&!document.querySelector(`[data-agent-id^="activity."][data-agent-id$=".details"]`)' || { echo "FAIL: collapse work details"; FAIL=1; }

note "session: draft saved on switch, rename, true delete purges local state"
agent-browser click '[data-agent-id="session.sess_002.open"]' >/dev/null
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null
sleep 0.6
agent-browser fill '[data-agent-id="composer.input"]' 'draft-for-delete' >/dev/null
agent-browser click '[data-agent-id="session.sess_001.open"]' >/dev/null
sleep 0.4
wait_js 'localStorage.getItem("dextui.draft.sess_002") === "draft-for-delete"' || { echo "FAIL: draft save"; FAIL=1; }
agent-browser click '[data-agent-id="session.sess_001.actions"]' >/dev/null
agent-browser click '[data-agent-id="session.sess_001.rename"]' >/dev/null
agent-browser wait '[data-agent-id="session.rename.input"]' >/dev/null
agent-browser fill '[data-agent-id="session.rename.input"]' 'renamed-one' >/dev/null
agent-browser click '[data-agent-id="session.action.confirm"]' >/dev/null
wait_js 'document.body.textContent.includes("renamed-one")' || { echo "FAIL: rename applied"; FAIL=1; }
wait_js '!document.querySelector(`[data-agent-id="session.action"]`)' || { echo "FAIL: dialog closed after ack"; FAIL=1; }
agent-browser click '[data-agent-id="session.sess_002.actions"]' >/dev/null
agent-browser click '[data-agent-id="session.sess_002.delete"]' >/dev/null
agent-browser wait '[data-agent-id="session.action.confirm"]' >/dev/null
agent-browser click '[data-agent-id="session.action.confirm"]' >/dev/null
wait_js '!document.querySelector(`[data-agent-id="session.sess_002.open"]`)' || { echo "FAIL: removal"; FAIL=1; }
wait_js 'localStorage.getItem("dextui.draft.sess_002") === null && localStorage.getItem("dextui.history.sess_002") === null && localStorage.getItem("dextui.generation.sess_002") === null' || { echo "FAIL: local purge"; FAIL=1; }

note "packs: gallery in hero, card prefills composer, run → badged turn + runtime_view footer, g overlay"
# session.new can race the delete-dialog teardown (the click lands but the
# view stays on the old session): retry until the transcript is actually empty.
n=0
until agent-browser eval '!!document.querySelector(`[data-agent-id="transcript.empty"]`)' 2>/dev/null | grep -q true; do
  n=$((n+1)); [ $n -gt 10 ] && break
  agent-browser click '[data-agent-id="session.new"]' >/dev/null 2>&1
  sleep 0.5
done
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null
# First run shows the persona picker (gallery state "persona"); skip it so the
# gallery reaches "ready". The choice persists in localStorage for this run.
# Retry until the picker is gone (a one-shot check raced the gallery mount).
for i in $(seq 1 20); do
  agent-browser eval 'document.querySelector(`[data-agent-id="persona.skip"]`)?.click()' >/dev/null 2>&1
  agent-browser eval '!document.querySelector(`[data-agent-id="persona.skip"]`)' 2>/dev/null | grep -q true && break
  sleep 0.25
done
sleep 0.6
wait_js '!!document.querySelector(`[data-agent-id="packs.gallery"][data-state="ready"]`)' || { echo "FAIL: gallery not rendered in empty session"; FAIL=1; }
wait_js 'document.querySelector(`[data-agent-id="packs.card.report"]`)?.dataset.state === "unmet"' || { echo "FAIL: report card should be greyed (needs auto-write)"; FAIL=1; }
agent-browser click '[data-agent-id="packs.card.hello-chart"]' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.input"]`).value.startsWith("/pack run hello-chart")' || { echo "FAIL: card did not prefill"; FAIL=1; }
agent-browser press Enter >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="block.user.pack"]`) && document.querySelector(`[data-agent-id="block.user.pack"]`).textContent.includes("hello-chart")' || { echo "FAIL: pack badge on user block"; FAIL=1; }
wait_js '!!document.querySelector(`[data-agent-id="view.hello-chart.rerun"]`)' || { echo "FAIL: runtime_view footer"; FAIL=1; }
wait_js 'document.querySelectorAll(`[data-agent-id="view.hello-chart"] .chart-wrap`).length === 1' || { echo "FAIL: chart inside view card"; FAIL=1; }
agent-browser click '[data-agent-id="view.hello-chart.rerun"]' >/dev/null
wait_js 'document.querySelector(`[data-agent-id="composer.input"]`).value === "/pack run hello-chart "' || { echo "FAIL: run again prefill"; FAIL=1; }
agent-browser fill '[data-agent-id="composer.input"]' '/pack run report x' >/dev/null
agent-browser press Enter >/dev/null
wait_js '!!document.querySelector(`[data-agent-id^="toast."][data-agent-id$=".action"]`)' || { echo "FAIL: pack_requires_profile toast action"; FAIL=1; }
agent-browser click '[data-agent-id^="toast."][data-agent-id$=".action"]' >/dev/null
wait_js 'document.body.textContent.includes("approval profile → auto-write")' || { echo "FAIL: one-click profile switch"; FAIL=1; }
agent-browser fill '[data-agent-id="composer.input"]' '/pack run report x' >/dev/null
agent-browser press Enter >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="view.report.rerun"]`)' || { echo "FAIL: report runs after switch"; FAIL=1; }
agent-browser fill '[data-agent-id="composer.input"]' '' >/dev/null
agent-browser eval 'document.activeElement.blur()' >/dev/null
agent-browser press g >/dev/null
wait_js '!!document.querySelector(`[data-agent-id="packs.overlay"]`)' || { echo "FAIL: g overlay"; FAIL=1; }
agent-browser press Escape >/dev/null
wait_js '!document.querySelector(`[data-agent-id="packs.overlay"]`)' || { echo "FAIL: overlay esc"; FAIL=1; }

if [ $FAIL -eq 0 ]; then echo "ALL BROWSER CHECKS PASSED"; else echo "BROWSER CHECKS FAILED"; exit 1; fi
