#!/usr/bin/env bash
#
# Install the built Custom Relay plugin into an Obsidian vault.
#
#   Usage: ./install.sh /path/to/obsidian/vault [more/vaults ...]
#
# Copies dist/{main.js,manifest.json,styles.css} into
#   <vault>/.obsidian/plugins/relay-custom/
# creating the folder if needed. Build first with:
#   docker compose run --rm --build build
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$(cd "$SCRIPT_DIR/../dist" 2>/dev/null && pwd || true)"
PLUGIN_ID="relay-custom"
FILES=(main.js manifest.json styles.css)

if [ "$#" -lt 1 ]; then
	echo "Usage: $0 /path/to/obsidian/vault [more/vaults ...]" >&2
	exit 1
fi

if [ -z "$DIST" ] || [ ! -f "$DIST/main.js" ]; then
	echo "No build found at ../dist. Build first:" >&2
	echo "    cd \"$SCRIPT_DIR\" && docker compose run --rm --build build" >&2
	exit 1
fi

for VAULT in "$@"; do
	if [ ! -d "$VAULT/.obsidian" ]; then
		echo "Skipping (not an Obsidian vault, no .obsidian/): $VAULT" >&2
		continue
	fi
	DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"
	mkdir -p "$DEST"
	for f in "${FILES[@]}"; do
		cp -f "$DIST/$f" "$DEST/$f"
	done
	echo "Installed Custom Relay -> $DEST"
done

echo
echo "Done. In Obsidian: Settings -> Community plugins -> enable \"Custom Relay\","
echo "then set your name, color, and control-plane URL in its settings."
