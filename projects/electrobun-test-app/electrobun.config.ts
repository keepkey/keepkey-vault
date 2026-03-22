import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "electrobun-test",
		identifier: "com.keepkey.electrobun-test",
		version: "0.0.1",
	},
	build: {
		buildFolder: "_build",
		bun: {
			external: [],
		},
		copy: [
			{
				src: "src/mainview",
				dest: "views/mainview",
			},
		],
	},
	views: {
		mainview: {
			src: "views/mainview/index.html",
		},
	},
} satisfies ElectrobunConfig;
