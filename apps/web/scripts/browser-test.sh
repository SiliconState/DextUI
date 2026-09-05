set -uo pipefail
cd "$(dirname "$0")/../../.."
PORT="${PORT:-8793}"
node packages/mock-server/src/server.mjs --port=$PORT --token=browsertest >/tmp/dextui-bt-mock.log 2>&1 &
SRV=$!
cleanup() { agent-browser close --all >/dev/null 2>&1; kill $SRV 2>/dev/null; }
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

note "charts render and follow theme (echo session — fixture sessions replay canned text)"
agent-browser click '[data-agent-id="session.new"]' >/dev/null
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null
sleep 0.8
agent-browser fill '[data-agent-id="composer.input"]' 'markdown demo' >/dev/null
agent-browser press Enter >/dev/null
wait_js 'document.querySelectorAll(`.chart-wrap`).length >= 3' || { echo "FAIL: charts"; FAIL=1; }
sleep 1.5
T0=$(agent-browser eval 'document.documentElement.dataset.theme')
C0=$(agent-browser eval 'getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim()')
B0=$(agent-browser eval 'getComputedStyle(document.documentElement).getPropertyValue("--bg3").trim() + "|" + getComputedStyle(document.documentElement).getPropertyValue("--chart-grid").trim()')
F0=$(agent-browser eval 'getComputedStyle(document.querySelector(`.chart-wrap svg rect`)).fill')
agent-browser click '[data-agent-id="theme.toggle"]' >/dev/null
sleep 0.3
T1=$(agent-browser eval 'document.documentElement.dataset.theme')
C1=$(agent-browser eval 'getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim()')
B1=$(agent-browser eval 'getComputedStyle(document.documentElement).getPropertyValue("--bg3").trim() + "|" + getComputedStyle(document.documentElement).getPropertyValue("--chart-grid").trim()')
F1=$(agent-browser eval 'getComputedStyle(document.querySelector(`.chart-wrap svg rect`)).fill')
agent-browser click '[data-agent-id="theme.toggle"]' >/dev/null
sleep 0.3
T2=$(agent-browser eval 'document.documentElement.dataset.theme')
echo "themes: $T0 -> $T1 -> $T2; chart-1: $C0 -> $C1"
echo "tip surface + grid: $B0 -> $B1; bar fill: $F0 -> $F1"
[ "$T0" != "$T1" ] && [ "$T1" != "$T2" ] || { echo "FAIL: theme cycle"; FAIL=1; }
[ "$C0" != "$C1" ] || { echo "FAIL: --chart-1 unchanged"; FAIL=1; }
[ "$B0" != "$B1" ] || { echo "FAIL: tooltip surface/grid vars unchanged"; FAIL=1; }
[ "$F0" != "$F1" ] || { echo "FAIL: bar fill unchanged across theme"; FAIL=1; }

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
agent-browser click '[data-agent-id="session.new"]' >/dev/null
agent-browser wait '[data-agent-id="composer.input"]' >/dev/null
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
