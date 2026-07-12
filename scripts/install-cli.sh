#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
installation_root=$(cd -- "$script_directory/.." && pwd -P)
bin_directory=${PLUS_ONE_BIN_DIR:-"${HOME}/.local/bin"}
target="$installation_root/bin/plus-one.mjs"
link="$bin_directory/plus-one"

if [[ ! -f "$target" ]]; then
  printf 'Plus One launcher not found: %s\n' "$target" >&2
  exit 1
fi

mkdir -p -- "$bin_directory"
if [[ -e "$link" && ! -L "$link" ]]; then
  printf 'Refusing to replace non-symlink: %s\n' "$link" >&2
  exit 1
fi

if [[ -L "$link" ]]; then
  rm -- "$link"
fi
ln -s -- "$target" "$link"
printf 'Installed plus-one -> %s\n' "$target"
