// Jest config for the fork's own tests (custom/tests). Upstream keeps
// __tests__/** git-crypt encrypted, including the setup files its config
// loads, so this reuses upstream's transforms without its setup or mocks.
//
//   npx jest -c custom/jest.config.mjs

import base from "../jest.config.mjs";

export default {
	...base,
	rootDir: "..",
	roots: ["<rootDir>/custom/tests"],
	setupFiles: [],
	moduleNameMapper: {
		...base.moduleNameMapper,
		"^obsidian$": "<rootDir>/custom/tests/stubs/obsidian.ts",
	},
	testPathIgnorePatterns: ["/stubs/"],
};
