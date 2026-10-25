#!/bin/sh
# Boot the pinned dsh web with the probe plugin and the scripted fake model.
# Usage: ./run.sh  (logs to .dsh-home/web.log and .dsh-home/fake-llm.log)
set -eu
cd "$(dirname "$0")"
export DSH_HOME="$PWD/.dsh-home" DSH_TELEMETRY_DISABLED=1 FAKE_LLM_KEY=probe
mkdir -p "$DSH_HOME"
node ../../packages/dsh-plugin/test/integration/fake-llm.mjs 4398 > "$DSH_HOME/fake-llm.log" 2>&1 &
FAKE_PID=$!
trap 'kill $FAKE_PID 2>/dev/null' EXIT INT TERM
node node_modules/@deepseek-ai/dsh/lib/bin.js web --patch "$PWD/fake-model.patch.yml" \
  --host 127.0.0.1 --port 3091 --no-open > "$DSH_HOME/web.log" 2>&1
