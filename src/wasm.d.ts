// esbuild's "binary" loader turns a `.wasm` import into a Uint8Array of the
// file's bytes, inlined into the bundle. This declaration lets TypeScript
// type that import.
declare module "*.wasm" {
	const bytes: Uint8Array;
	export default bytes;
}
