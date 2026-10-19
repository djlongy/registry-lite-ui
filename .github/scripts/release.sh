#!/usr/bin/env bash
# VERSION handling shared by the workflows and tests/release.sh.
#   release.sh check <version>               exit 1 unless <version> is valid semver 2.0
#   release.sh decide <version> <tag-exists> print release=true only for X.Y.Z with no existing tag
set -euo pipefail
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
release='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
case "${1:-}" in
  check) [[ ${2:-} =~ $semver ]] || { echo "VERSION '${2:-}' is not valid semver" >&2; exit 1; } ;;
  decide) if [[ ${2:-} =~ $release && ${3:-} != true ]]; then echo release=true; else echo release=false; fi ;;
  *) sed -n 2,4p "$0" >&2; exit 2 ;;
esac
