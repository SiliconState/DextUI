#!/bin/sh
# GIT_ASKPASS helper for agentlinkd connectors. git calls this once for the
# username and once for the password; the token travels in the environment of
# the git child only — never on argv, never into .git/config or a remote URL.
case "$1" in
  *sername*) printf '%s\n' "${DEXTUI_GIT_USER:-x-access-token}" ;;
  *) printf '%s\n' "${DEXTUI_GIT_TOKEN:-}" ;;
esac
