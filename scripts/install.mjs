// Copies the built plugin artifacts into a vault's plugin folder.
// Usage: VAULT="/path/to/vault" npm run install:vault
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const vault = process.env.VAULT;
if (!vault) {
	console.error('Set VAULT to your vault path, e.g. VAULT="/path/to/vault" npm run install:vault');
	process.exit(1);
}

const pluginDir = join(vault, ".obsidian", "plugins", "whatsapp-local-sync");
mkdirSync(pluginDir, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
	if (!existsSync(file)) {
		console.error(`Missing ${file} — run "npm run build" first.`);
		process.exit(1);
	}
	copyFileSync(file, join(pluginDir, file));
	console.log(`Copied ${file} → ${pluginDir}`);
}

console.log("Done. Reload plugins in Obsidian, then enable WhatsApp Local Sync.");
