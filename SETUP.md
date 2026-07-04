# WhatsApp Local Sync — Setup Guide

This plugin reads your **local WhatsApp Desktop database** and mirrors chats into
your vault. There is no account, no QR pairing, no API key — it just reads a file
on your own machine. Setup is mostly about (1) making sure WhatsApp Desktop has
the database, and (2) on macOS, giving Obsidian permission to read it.

---

## 0. Before you start

| You need | Notes |
|---|---|
| **WhatsApp Desktop** (the native app, not WhatsApp Web) | It must have opened and synced at least once, so `ChatStorage.sqlite` exists. |
| Obsidian **1.7.2+ desktop** | The plugin is **desktop-only** (it reads a local file via Node). |
| On macOS: **Full Disk Access** for Obsidian | The WhatsApp DB lives in a protected container; see step 2. |

---

## 1. Find your WhatsApp database

The plugin auto-detects these default locations:

| OS | Default path |
|---|---|
| **macOS** | `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite` |
| **Windows** | `%USERPROFILE%\AppData\Roaming\WhatsApp\Databases\ChatStorage.sqlite` |
| **Linux** | `~/.local/share/whatsapp/ChatStorage.sqlite` |

Open **Settings → WhatsApp Local Sync** — the **Database status** row tells you
whether it was found. If your install keeps the file elsewhere, paste the full
path into **Database path override**.

> The macOS path is by far the most reliable — the native macOS WhatsApp app
> uses the Core Data store above. On Windows, the store location has varied
> across app versions; if auto-detect fails, search your user folder for
> `ChatStorage.sqlite` and set the override.

---

## 2. macOS: grant Full Disk Access (usually required)

The WhatsApp container is sandboxed, so a normal app can't read it until you
allow it:

1. **System Settings → Privacy & Security → Full Disk Access**.
2. Click **+**, add **Obsidian** (from `/Applications`), and toggle it **on**.
3. **Quit and reopen Obsidian** so the new permission takes effect.

Without this, **Database status** will say the file exists but is not readable,
or not found at all.

---

## 3. Configure the plugin

Open **Settings → WhatsApp Local Sync**:

- **Sync group chats / Sync personal chats** — pick what to mirror.
- **Target folder** — vault root for all notes (default `11-Whatsapp`), with
  `Groups/` and `Personal/` subfolders.
- **Sync messages from the last N days** — default `30`. `0` = all history
  (heavier first sync).
- **Sync since (YYYY-MM-DD)** — optional hard floor date.
- **Your name** — the label for messages you sent (WhatsApp stores no name for
  "me"), e.g. your first name.
- **Auto-sync interval** / **Sync on startup** — optional automation.

---

## 4. First sync & what to expect

- Click the **ribbon icon**, or run **WhatsApp Local Sync: Sync now**, or use
  **Settings → Maintenance → Sync now**.
- Progress shows in the **status bar** (`WhatsApp · 45/1200`) and in the
  developer console (`Ctrl/Cmd+Shift+I`) under the `[whatsapp]` prefix.
- The **first** sync writes the full window; later syncs append only new
  messages (fast).
- **Stop** anytime via Settings → Maintenance → Stop. Written notes are kept and
  the next sync resumes from each chat's cursor.

---

## 5. How incremental sync works

- Each chat stores the highest message **row id** (`Z_PK`) it has written.
- The next sync reads messages inside the window, then appends only rows with a
  higher id than the stored cursor — exact dedup, even for same-second messages.
- **Reset sync state** (Maintenance) clears those cursors. Because syncs
  *append*, resetting then re-syncing can duplicate recent messages — delete the
  affected notes first if you want a clean rebuild.

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Database status: "Not found" | WhatsApp Desktop hasn't created the DB, or it's in a custom location. Open WhatsApp once; set **Database path override** if needed. |
| Status: "exists but not readable" (macOS) | Grant Obsidian **Full Disk Access** (step 2) and restart Obsidian. |
| Newest messages missing | WhatsApp buffers recent messages in a `-wal` file. Quit WhatsApp to flush it, or wait — the next sync catches them once WhatsApp checkpoints. No duplicates result. |
| "Running but nothing in logs" | Baseline `[whatsapp]` progress prints regardless of the Debug toggle. A large DB read can take a few seconds before the per-chat lines start. |
| Sync is slow / huge first run | Lower **Sync messages from the last N days** (e.g. 30 → 7) and **Reset sync state**. |
| Duplicated recent messages after a reset | Expected if you reset cursors without clearing notes (append-based). Delete the affected transcript notes, then sync. |

Toggle **Debug logging** (Settings → Sync) for verbose per-chat / per-row output.

---

## Privacy

Everything is local. No network calls, no accounts, no keys. The plugin reads
temporary **copies** of `ChatStorage.sqlite` (messages) and, when present,
`ContactsV2.sqlite` (saved contact names, used to label group senders), deletes
the copies afterwards, and never modifies WhatsApp's databases. Both files live
in the same container, so the one-time Full Disk Access grant covers both. Your
transcripts are plain Markdown in your vault — keep it private and don't sync the
WhatsApp folder to untrusted locations.

**Group sender names.** Modern WhatsApp uses privacy "LID" identifiers instead of
phone numbers. Names are resolved as: your **saved contact name** →
the sender's **WhatsApp profile name** → their **phone number** → a stable
`Member-<id>` placeholder (same person, same label every sync) when nothing else
is known. 1:1 chats always use the saved/partner name.
