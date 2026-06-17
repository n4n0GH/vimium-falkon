#!/usr/bin/env bash
# Install the Vimium plugin into Falkon's per-user Python plugins directory.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/Vimium"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/falkon/plugins"

mkdir -p "$DEST"
rm -rf "$DEST/Vimium"
cp -r "$SRC" "$DEST/Vimium"

echo "Installed Vimium to $DEST/Vimium"
echo "Now open Falkon -> Preferences -> Extensions and enable 'Vimium'."
echo "(Python plugin support must be available: package 'falkon' built with PySide6.)"
