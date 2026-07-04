import esbuild from "esbuild";
import process from "process";
import { builtinModules as builtins } from "module";

const banner = `/*
Plugin: obsidian-whatsapp-local-sync
This is a generated bundle. To edit, see the source at the plugin repository.
*/`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ["src/main.ts"],
	bundle: true,
	// obsidian + electron are provided by the host; Node built-ins stay external
	// (available at runtime because the plugin is desktop-only).
	external: ["obsidian", "electron", ...builtins],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	// The sql.js WebAssembly binary is inlined into main.js as a byte array,
	// so there is no external .wasm asset to ship or fetch (CSP-safe, offline).
	loader: { ".wasm": "binary" },
});

if (prod) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
