// Custom Relay esbuild plugin: rebrands upstream sources at build time so the
// files themselves stay verbatim and upstream releases merge cleanly.
//
// - GIT_TAG / HEALTH_URL / REPOSITORY defines report the overlay version and
//   point the in-plugin updater at this fork, never at upstream releases.
// - Every upstream src/**/*.ts has the plugin id "system3-relay" rewritten to
//   the overlay id (settings tab, command ids, editor binding, storage keys,
//   public API events). Fork code under src/local/ is left alone.
// - A few exact rewrites (below) must each match a known number of times; if
//   upstream changes that code the build fails, so a merge can't silently
//   drop one.

import fs from "fs";
import path from "path";
import { UPSTREAM_ID, overlay, customVersion } from "./overlay.mjs";

const [repoOwner, repoName] = overlay.repository.split("/");

const EXACT_REWRITES = {
	"src/UpdateManager.ts": [
		['const repoOwner = "No-Instructions";', `const repoOwner = "${repoOwner}";`, 2],
		['const repoName = "Relay";', `const repoName = "${repoName}";`, 2],
	],
};

const countOf = (source, needle) => source.split(needle).length - 1;

export const customRelayPlugin = {
	name: "custom-relay",
	setup(build) {
		const define = build.initialOptions.define;
		define.GIT_TAG = JSON.stringify(customVersion);
		define.REPOSITORY = JSON.stringify(overlay.repository);
		define.HEALTH_URL = define.HEALTH_URL.replace(
			/version=[^"]*/,
			`version=${encodeURIComponent(customVersion)}`,
		);
		console.log(`custom relay: ${overlay.id} ${customVersion} (${overlay.repository})`);

		build.onLoad({ filter: /\.ts$/ }, async (args) => {
			const rel = path.relative(process.cwd(), args.path).split(path.sep).join("/");
			if (!rel.startsWith("src/") || rel.startsWith("src/local/")) return undefined;

			let source = await fs.promises.readFile(args.path, "utf8");
			for (const [from, to, expected] of EXACT_REWRITES[rel] ?? []) {
				const found = countOf(source, from);
				if (found !== expected) {
					throw new Error(
						`custom relay: expected ${expected}× ${JSON.stringify(from)} in ${rel}, found ${found}; ` +
							"upstream changed this code — update custom/build/esbuild-plugin.mjs",
					);
				}
				source = source.split(from).join(to);
			}
			if (!source.includes(UPSTREAM_ID) && !EXACT_REWRITES[rel]) return undefined;
			return {
				contents: source.split(UPSTREAM_ID).join(overlay.id),
				loader: "ts",
			};
		});
	},
};
