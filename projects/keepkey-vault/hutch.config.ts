// @hutch cli=0.29.0 cottontail=0.7.3
// Electrobun comes from our fork (keepkey/electrobun, branch keepkey/2.x), built as a
// local devkit and selected with HUTCH_ELECTROBUN_DEVKIT_ROOT (see the root Makefile).
// The fork's devkit carries its own version, so Hutch can never silently fall back
// to upstream's 2.0.6 devkit: without the variable this pin fails to resolve.
export default {
	packageManager: "bun",
	electrobun: {
		version: "2.0.6-keepkey.1",
	},
};
