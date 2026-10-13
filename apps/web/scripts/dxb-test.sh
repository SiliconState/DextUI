#!/usr/bin/env bash
# Source from a gate; each backend owns an isolated browser and cleans it up.
# Prefer installed dxb; retain the installed agent-browser backend on hosts that
# do not have that user-global pack. Neither backend is downloaded or skipped.
DXB_TEST_DRIVER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dxb-test.mjs"
DXB_TEST_PACK="${DEXT_PACK_DXB_DIR:-$HOME/.dext/shelves/automation/packs/dxb}"
if [ ! -f "$DXB_TEST_PACK/src/session.mjs" ] || [ ! -f "$DXB_TEST_PACK/src/commands.mjs" ]; then
  if ! command -v agent-browser >/dev/null 2>&1; then
    echo 'FAIL: installed dxb or agent-browser required; browser gates never skip or download an engine' >&2
    exit 1
  fi
  DXB_TEST_SESSION="dextui-gate-$$-$RANDOM"
  dxb_test_cleanup() { agent-browser --session "$DXB_TEST_SESSION" close >/dev/null 2>&1 || true; }
  dxb_test() {
    if [ "${1:-}" = reset ] || [ "${1:-}" = close ]; then
      dxb_test_cleanup
      # Closing the old daemon is asynchronous; a new fixture session avoids
      # reconnecting to its disappearing socket during the next open.
      if [ "${1:-}" = reset ]; then DXB_TEST_SESSION="dextui-gate-$$-$RANDOM"; fi
      return 0
    fi
    agent-browser --session "$DXB_TEST_SESSION" "$@"
  }
  trap dxb_test_cleanup EXIT
  B=(dxb_test)
  return 0
fi
DXB_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dt.XXXXXX")
export DXB_TEST_SOCKET="$DXB_TEST_DIR/b.sock"
node "$DXB_TEST_DRIVER" --server >"$DXB_TEST_DIR/driver.log" 2>&1 &
DXB_TEST_PID=$!
dxb_test_cleanup() {
  if kill -0 "$DXB_TEST_PID" 2>/dev/null; then
    kill "$DXB_TEST_PID" 2>/dev/null || true
    wait "$DXB_TEST_PID" 2>/dev/null || true
  fi
  rm -rf "$DXB_TEST_DIR"
}
# Register before any build or fixture startup can fail. Gates may replace the
# trap, but their close command still uses this same cleanup path.
trap dxb_test_cleanup EXIT
for _ in $(seq 1 100); do
  [ ! -S "$DXB_TEST_SOCKET" ] || break
  if ! kill -0 "$DXB_TEST_PID" 2>/dev/null; then cat "$DXB_TEST_DIR/driver.log" >&2; exit 1; fi
  sleep 0.05
done
if [ ! -S "$DXB_TEST_SOCKET" ]; then
  cat "$DXB_TEST_DIR/driver.log" >&2
  kill "$DXB_TEST_PID" 2>/dev/null || true
  wait "$DXB_TEST_PID" 2>/dev/null || true
  rm -rf "$DXB_TEST_DIR"
  echo 'FAIL: dxb fixture driver did not start' >&2
  exit 1
fi
dxb_test() {
  if [ "${1:-}" = close ]; then
    local code=0
    node "$DXB_TEST_DRIVER" close || code=$?
    dxb_test_cleanup
    return "$code"
  fi
  node "$DXB_TEST_DRIVER" "$@"
}
B=(dxb_test)
