import { Notice, Plugin } from "obsidian";

import { PluginSettings, DEFAULT_SETTINGS } from "./types";
import { WhatsAppSettingTab } from "./settings";
import { syncOnce } from "./sync";
import { setDebug, info, errorLog } from "./log";

export default class WhatsAppSyncPlugin extends Plugin {
	settings!: PluginSettings;

	private syncing = false;
	private cancelRequested = false;
	private statusBar: HTMLElement | null = null;
	private timer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyDebugLogging();

		this.statusBar = this.addStatusBarItem();
		this.setStatus(this.settings.lastSync ? `WhatsApp · ${this.shortWhen(this.settings.lastSync)}` : "WhatsApp · idle");

		this.addRibbonIcon("message-circle", "Sync WhatsApp", () => {
			void this.runSync();
		});

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				void this.runSync();
			},
		});

		this.addCommand({
			id: "stop-sync",
			name: "Stop sync",
			callback: () => this.requestStop(),
		});

		this.addSettingTab(new WhatsAppSettingTab(this.app, this));

		this.restartTimer();

		if (this.settings.syncOnStartup) {
			// Defer so startup isn't blocked by a large DB read.
			this.app.workspace.onLayoutReady(() => {
				void this.runSync();
			});
		}
	}

	onunload(): void {
		this.clearTimer();
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) as Partial<PluginSettings> | null) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Guard against a persisted null for the state maps.
		if (!this.settings.chats) this.settings.chats = {};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	applyDebugLogging(): void {
		setDebug(this.settings.debugLogging);
	}

	requestStop(): void {
		if (this.syncing) {
			this.cancelRequested = true;
			new Notice("WhatsApp Local Sync: stopping after the current chat…");
		}
	}

	restartTimer(): void {
		this.clearTimer();
		const minutes = this.settings.syncIntervalMinutes;
		if (minutes > 0) {
			this.timer = window.setInterval(() => {
				void this.runSync();
			}, minutes * 60_000);
			this.registerInterval(this.timer);
		}
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Run one sync. Guarded so only one runs at a time; flag cleared in finally. */
	async runSync(): Promise<void> {
		if (this.syncing) {
			new Notice("WhatsApp Local Sync: a sync is already running.");
			return;
		}
		this.syncing = true;
		this.cancelRequested = false;
		this.setStatus("WhatsApp · syncing…");

		try {
			const summary = await syncOnce(this.app.vault, this.settings, {
				shouldCancel: () => this.cancelRequested,
				onProgress: (done, total) => this.setStatus(`WhatsApp · ${done}/${total}`),
			});

			this.settings.lastSync = new Date().toISOString();
			await this.saveSettings();

			this.setStatus(`WhatsApp · ${this.shortWhen(this.settings.lastSync)}`);
			new Notice(
				`WhatsApp Local Sync: +${summary.messagesWritten} message(s) in ${summary.chatsTouched} chat(s)` +
					(summary.errors ? `, ${summary.errors} error(s)` : "") +
					".",
			);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			errorLog("sync failed", err);
			this.setStatus("WhatsApp · error");
			new Notice(`WhatsApp Local Sync: ${err.message}`);
		} finally {
			this.syncing = false;
			this.cancelRequested = false;
		}
	}

	private setStatus(text: string): void {
		if (this.statusBar) this.statusBar.setText(text);
	}

	private shortWhen(iso: string): string {
		try {
			return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		} catch {
			info(`could not format timestamp ${iso}`);
			return "synced";
		}
	}
}
