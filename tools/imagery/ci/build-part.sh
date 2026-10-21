#!/usr/bin/env bash
# A CI build job in parts, so a runner that dies loses only the part it was in (each part is followed by its own upload).
#
#   build-part.sh t1|t2 <part> <parts>   build until this part's share of the job's time is used, then move the finished
#                                         archives to parts/<part>/ for the upload step after it
#   build-part.sh t1|t2 pack <name>       move finished archives not uploaded yet to parts/<name>/ (the last step)
#
# Environment: SLICE (this job's share, 0…SLICES-1), SLICES (default 20), MINUTES (the job's building time, measured
# from its first part), LIMIT (optional: at most this many archives in the whole job), WORKERS (default 4), PAGES_URL
# (the live site: what it already lists is skipped), IMAGERY_OUT (default out).
#
# The build records (*.json) stay in IMAGERY_OUT, so a later part skips what an earlier one built; only archives that
# have their record are moved (an archive without one may be half written).
set -euo pipefail

tier=$1
out=${IMAGERY_OUT:-out}
if [ "$tier" = t1 ]; then
  root="$out/world/t1/shards"
  listing="$PAGES_URL/world/t1/manifest.json"
else
  root="$out/world/t2"
  listing="$PAGES_URL/world/t2/index.json"
fi

pack() {
  local dest="parts/$1" n=0
  mkdir -p "$dest"
  if [ -d "$root" ]; then
    while IFS= read -r -d '' rec; do
      local rel=${rec#"$root"/}
      local bin="${rec%.json}.bin"
      [ -f "$bin" ] || continue
      mkdir -p "$dest/$(dirname "$rel")"
      mv "$bin" "$dest/${rel%.json}.bin"
      n=$((n + 1))
    done < <(find "$root" -name '*.json' -print0)
  fi
  echo "part $1: $n archives to upload ($(du -sh "$dest" | cut -f1)); disk: $(df -h / | tail -1 | tr -s ' ')"
}

if [ "$2" = pack ]; then
  pack "$3"
  exit 0
fi

part=$2
parts=$3
# Archives a part before this one finished but could not move (its step was stopped) go up with this part.
pack "$part"
[ -f .job-start ] || date +%s > .job-start
end=$(($(cat .job-start) + part * MINUTES * 60 / parts))
left=$(((end - $(date +%s)) / 60))
if [ "$left" -lt 1 ]; then
  echo "part $part of $parts: this part's time is used up"
  exit 0
fi
limit=()
if [ -n "${LIMIT:-}" ]; then
  built=0
  [ -d "$root" ] && built=$(find "$root" -name '*.json' | wc -l | tr -d ' ')
  if [ "$built" -ge "$LIMIT" ]; then
    echo "part $part of $parts: the job's limit of $LIMIT is reached"
    exit 0
  fi
  limit=(--limit $((LIMIT - built)))
fi
echo "part $part of $parts: $left minutes; memory: $(free -g 2>/dev/null | awk '/^Mem:/ {print $7 " GB available of " $2}')"
status=0
npx tsx tools/imagery/world.ts run --tier "$tier" --all --workers "${WORKERS:-4}" \
  --slice "$SLICE/${SLICES:-20}" \
  --published "$listing" \
  --deadline-minutes "$left" \
  ${limit[@]+"${limit[@]}"} || status=$?
pack "$part"
exit "$status"
