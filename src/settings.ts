import { App, PluginSettingTab, Setting, Notice } from "obsidian";

import type WhatsAppSyncPlugin from "./main";
import { defaultDbPaths, resolveDbPath, probeDatabase } from "./db";

export class WhatsAppSettingTab extends PluginSettingTab {
	private plugin: WhatsAppSyncPlugin;

	constructor(app: App, plugin: WhatsAppSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private async runProbe(): Promise<void> {
		const path = resolveDbPath(this.plugin.settings.dbPathOverride);
		if (!path) {
			new Notice("WhatsApp Local Sync: database not found. Set the path override first.");
			return;
		}
		new Notice("WhatsApp Local Sync: testing…");
		try {
			const r = await probeDatabase(path);
			const lines = [
				`OK — ${r.total} text message(s).`,
				`Names: ${r.contacts} saved contact(s), ${r.pushNames} profile name(s)`,
				`Contacts DB: ${r.hasContactsDb ? "found" : "not found (names limited to push-names + phone)"}`,
				...r.samples,
				"(full details in the developer console under [whatsapp])",
			];
			new Notice(`WhatsApp Local Sync: ${lines.join("\n")}`, 20000);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`WhatsApp Local Sync: query failed — ${msg}`, 10000);
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// --- Database ---
		new Setting(containerEl).setName("WhatsApp database").setHeading();

		const detected = resolveDbPath(s.dbPathOverride);
		new Setting(containerEl)
			.setName("Database status")
			.setDesc(
				detected
					? `Found: ${detected}`
					: `Not found. Checked: ${defaultDbPaths().join(", ") || "(no default for this OS)"}`,
			);

		new Setting(containerEl)
			.setName("Database path override")
			.setDesc("Absolute path to ChatStorage.sqlite. Leave empty to auto-detect the platform default.")
			.addText((t) =>
				t
					.setPlaceholder(defaultDbPaths()[0] ?? "/path/to/ChatStorage.sqlite")
					.setValue(s.dbPathOverride)
					.onChange(async (v) => {
						s.dbPathOverride = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Test database connection")
			.setDesc("Runs the read query (no writes) and reports total messages + a few recent samples.")
			.addButton((b) =>
				b.setButtonText("Test").onClick(() => {
					void this.runProbe();
				}),
			);

		// --- Vault layout ---
		new Setting(containerEl).setName("Vault layout").setHeading();

		new Setting(containerEl)
			.setName("Target folder")
			.setDesc("Root vault folder for all WhatsApp notes.")
			.addText((t) =>
				t.setValue(s.targetFolder).onChange(async (v) => {
					s.targetFolder = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Groups subfolder")
			.addText((t) =>
				t.setValue(s.groupsSubfolder).onChange(async (v) => {
					s.groupsSubfolder = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Personal subfolder")
			.addText((t) =>
				t.setValue(s.personalSubfolder).onChange(async (v) => {
					s.personalSubfolder = v;
					await this.plugin.saveSettings();
				}),
			);

		// --- Sync ---
		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Sync group chats")
			.addToggle((t) =>
				t.setValue(s.syncGroups).onChange(async (v) => {
					s.syncGroups = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Sync personal chats")
			.addToggle((t) =>
				t.setValue(s.syncPersonal).onChange(async (v) => {
					s.syncPersonal = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Sync messages from the last N days")
			.setDesc("Bounds how far back a sync reads. 0 = all history (heavier first sync).")
			.addText((t) =>
				t.setValue(String(s.maxDaysBack)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					s.maxDaysBack = Number.isFinite(n) && n >= 0 ? n : 0;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Sync since (YYYY-MM-DD)")
			.setDesc("Hard floor date. Leave empty for no floor.")
			.addText((t) =>
				t.setPlaceholder("2025-01-01").setValue(s.syncSince).onChange(async (v) => {
					s.syncSince = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Your name (label for "me")')
			.setDesc("WhatsApp stores no name for messages you sent; this label is used instead.")
			.addText((t) =>
				t.setValue(s.ownName).onChange(async (v) => {
					s.ownName = v.trim() || "Me";
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.setDesc("0 disables the timer.")
			.addText((t) =>
				t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					s.syncIntervalMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
					await this.plugin.saveSettings();
					this.plugin.restartTimer();
				}),
			);

		new Setting(containerEl)
			.setName("Sync on startup")
			.addToggle((t) =>
				t.setValue(s.syncOnStartup).onChange(async (v) => {
					s.syncOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Verbose [whatsapp] output in the developer console.")
			.addToggle((t) =>
				t.setValue(s.debugLogging).onChange(async (v) => {
					s.debugLogging = v;
					this.plugin.applyDebugLogging();
					await this.plugin.saveSettings();
				}),
			);

		// --- Maintenance ---
		new Setting(containerEl).setName("Maintenance").setHeading();

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc(s.lastSync ? `Last sync: ${new Date(s.lastSync).toLocaleString()}` : "Never synced.")
			.addButton((b) =>
				b
					.setButtonText("Sync now")
					.setCta()
					.onClick(() => {
						void this.plugin.runSync().finally(() => this.display());
					}),
			);

		new Setting(containerEl)
			.setName("Stop sync")
			.addButton((b) =>
				b.setButtonText("Stop").onClick(() => {
					this.plugin.requestStop();
				}),
			);

		new Setting(containerEl)
			.setName("Reset sync state")
			.setDesc("Clears per-chat cursors so the next sync re-reads the whole window. Existing notes are left in place.")
			.addButton((b) =>
				b
					.setWarning()
					.setButtonText("Reset")
					.onClick(async () => {
						s.chats = {};
						s.lastSync = null;
						await this.plugin.saveSettings();
						new Notice("WhatsApp Local Sync: sync state cleared.");
						this.display();
					}),
			);
	}
}
