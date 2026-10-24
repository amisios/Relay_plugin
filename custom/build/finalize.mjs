// Turns an upstream build in <outdir> into the Custom Relay release:
// writes the overlay manifest and checks the bundle carries no upstream id.
//
//   node custom/build/finalize.mjs dist

import fs from "fs";
import path from "path";
import { UPSTREAM_ID, customManifest } from "./overlay.mjs";

const out = process.argv[2];
if (!out || out === ".") {
	console.error("usage: node custom/build/finalize.mjs <outdir>  (not the repo root)");
	process.exit(2);
}

const bundlePath = path.join(out, "main.js");
const bundle = fs.readFileSync(bundlePath, "utf8");

// The only id left untouched is a provider cache key inside a Svelte component
// (esbuild-plugin.mjs rewrites .ts only); sharing it with upstream is harmless.
const allowed = `${UPSTREAM_ID}-auth-providers-`;
const stray = countOf(bundle, UPSTREAM_ID) - countOf(bundle, allowed);
if (stray !== 0) {
	console.error(`finalize: ${bundlePath} still contains "${UPSTREAM_ID}" ${stray}×`);
	process.exit(1);
}

const manifest = customManifest();
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
fs.writeFileSync(path.join(out, ".gitignore"), "*\n");
console.log(`finalize: ${out}/manifest.json → ${manifest.id} ${manifest.version}`);

function countOf(source, needle) {
	return source.split(needle).length - 1;
}
