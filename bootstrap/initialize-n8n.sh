#!/bin/sh
set -eu

timeout_seconds=90
n8n start >/tmp/n8n-initialize.log 2>&1 &
n8n_pid=$!

cleanup() {
  rm -f /tmp/local-credentials.json
  kill -TERM "$n8n_pid" 2>/dev/null || true
  wait "$n8n_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

deadline=$(( $(date +%s) + timeout_seconds ))
until wget -q -O /dev/null http://127.0.0.1:5678/healthz/readiness; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    cat /tmp/n8n-initialize.log >&2 || true
    echo 'Timed out waiting for n8n readiness during initialization.' >&2
    exit 1
  fi
  sleep 1
done

kill -TERM "$n8n_pid"
set +e
wait "$n8n_pid"
n8n_exit_code=$?
set -e
if [ "$n8n_exit_code" -ne 0 ] && [ "$n8n_exit_code" -ne 143 ]; then
  echo "Temporary n8n exited unexpectedly with status $n8n_exit_code." >&2
  exit "$n8n_exit_code"
fi

node /bootstrap/render-local-credentials.mjs /bootstrap/credentials/local-credentials.json /tmp/local-credentials.json
n8n import:credentials --input=/tmp/local-credentials.json
rm -f /tmp/local-credentials.json
for workflow in /workflows/*.json; do
  [ -e "$workflow" ] || continue
  n8n import:workflow --input="$workflow"
done
node /bootstrap/list-workflow-ids.mjs /workflows | while IFS= read -r workflow_id; do
  [ -n "$workflow_id" ] && n8n publish:workflow --id="$workflow_id"
done
