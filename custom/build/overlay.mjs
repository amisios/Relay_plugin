// Custom Relay build identity.
//
// Upstream's manifest.json stays verbatim in the repo; everything that makes
// this build "Custom Relay" comes from custom/manifest.overlay.json:
//
//   id, name, author, authorUrl   copied over the upstream manifest
//   fundingUrl: null              keys set to null are removed
//   repository                    GitHub "owner/name" the in-plugin updater uses
//   revision                      fork-only revision: "" ships the upstream
//                                 version as-is, "1" ships "<upstream>-1"
//
// The version is therefore always "<upstream x.y.z>[-<revision>]". Merging a
// new upstream release bumps x.y.z by itself; reset "revision" to "" then.

import fs from "fs";

export const UPSTREAM_ID = "system3-relay";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export const upstreamManifest = readJson("manifest.json");
export const overlay = readJson("custom/manifest.overlay.json");

if (!/^[\w.-]+\/[\w.-]+$/.test(overlay.repository ?? "")) {
	throw new Error(`custom/manifest.overlay.json: "repository" must be "owner/name"`);
}
if (overlay.revision && !/^\d+$/.test(String(overlay.revision))) {
	throw new Error(`custom/manifest.overlay.json: "revision" must be "" or a number`);
}

export const customVersion = overlay.revision
	? `${upstreamManifest.version}-${overlay.revision}`
	: upstreamManifest.version;

const BUILD_ONLY_KEYS = ["repository", "revision"];

export function customManifest() {
	const manifest = { ...upstreamManifest, version: customVersion };
	for (const [key, value] of Object.entries(overlay)) {
		if (BUILD_ONLY_KEYS.includes(key)) continue;
		if (value === null) delete manifest[key];
		else manifest[key] = value;
	}
	return manifest;
}
