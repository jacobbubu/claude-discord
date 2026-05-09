#!/usr/bin/env bash
# perf-sample.sh — sample daemon + plugin CPU%/RSS over time.
#
# NFR-1（性能）的轻量观察工具。把 daemon 启动后挂着不管，跑这个脚本
# 收集 idle 期 CPU / 内存。SC-1 的 7 天 soak 也用得上。
#
# Usage:
#   scripts/perf-sample.sh                     # default: every 60s for 1h
#   scripts/perf-sample.sh 30 7200             # every 30s for 2h
#   scripts/perf-sample.sh 300 604800 ~/soak.csv  # every 5min for 7d → ~/soak.csv
#
# Output:
#   CSV with header: timestamp,role,pid,cpu_pct,rss_kb,workspace_count
#   role ∈ {daemon, plugin}
#   workspace_count is the number of registered plugin processes at that sample
#
# At end prints summary: max / avg CPU and RSS for daemon, plugin count over time.

set -euo pipefail

INTERVAL=${1:-60}
DURATION=${2:-3600}
OUTFILE=${3:-perf-sample-$(date +%Y%m%d-%H%M%S).csv}

DAEMON_RE="src/cli/index.ts start"
PLUGIN_RE="src/plugin/index.ts"

echo "timestamp,role,pid,cpu_pct,rss_kb,workspace_count" > "$OUTFILE"

START=$(date +%s)
END=$((START + DURATION))
SAMPLES=0

echo "perf-sample: interval=${INTERVAL}s duration=${DURATION}s out=$OUTFILE"
echo "perf-sample: target patterns: daemon='$DAEMON_RE' plugin='$PLUGIN_RE'"

while [[ $(date +%s) -lt $END ]]; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Daemon: pid + cpu + rss. ps -o without TTY filter.
  DAEMON_LINE=$(ps -axo pid,pcpu,rss,command | grep -v grep | grep -E "$DAEMON_RE" | head -1 || true)
  PLUGINS_LINES=$(ps -axo pid,pcpu,rss,command | grep -v grep | grep -E "$PLUGIN_RE" || true)
  PLUGIN_COUNT=$(echo "$PLUGINS_LINES" | grep -c . || true)

  if [[ -n "$DAEMON_LINE" ]]; then
    DAEMON_PID=$(echo "$DAEMON_LINE" | awk '{print $1}')
    DAEMON_CPU=$(echo "$DAEMON_LINE" | awk '{print $2}')
    DAEMON_RSS=$(echo "$DAEMON_LINE" | awk '{print $3}')
    echo "$TS,daemon,$DAEMON_PID,$DAEMON_CPU,$DAEMON_RSS,$PLUGIN_COUNT" >> "$OUTFILE"
  fi

  if [[ -n "$PLUGINS_LINES" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      PID=$(echo "$line" | awk '{print $1}')
      CPU=$(echo "$line" | awk '{print $2}')
      RSS=$(echo "$line" | awk '{print $3}')
      echo "$TS,plugin,$PID,$CPU,$RSS,$PLUGIN_COUNT" >> "$OUTFILE"
    done <<< "$PLUGINS_LINES"
  fi

  SAMPLES=$((SAMPLES + 1))
  sleep "$INTERVAL"
done

echo
echo "=== summary ==="
echo "samples: $SAMPLES"
echo
echo "daemon (max/avg cpu%, max/avg rss MB):"
awk -F, '$2=="daemon" { c+=$4; r+=$5; n++; if ($4>maxc) maxc=$4; if ($5>maxr) maxr=$5 }
         END { if (n>0) printf "  cpu max=%.1f avg=%.2f  rss max=%.1fMB avg=%.1fMB  (n=%d)\n",
                            maxc, c/n, maxr/1024, r/n/1024, n }' "$OUTFILE"
echo
echo "plugin (max count, max single rss MB):"
awk -F, '$2=="plugin" { if ($5>maxr) maxr=$5; if ($6>maxc) maxc=$6 }
         END { printf "  workspaces max=%d  per-plugin rss max=%.1fMB\n", maxc, maxr/1024 }' "$OUTFILE"
echo
echo "raw csv: $OUTFILE"
