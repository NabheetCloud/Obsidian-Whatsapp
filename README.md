# WhatsApp Local Sync

Mirror your **WhatsApp Desktop** chats into your Obsidian vault — one transcript
note per conversation — by reading the app's **local SQLite database**. Fully
local: no network, no cloud, no QR pairing, no API keys. Read-only.

> 📖 **Setting up?** See **[SETUP.md](SETUP.md)** for exact database locations,
> permission notes (macOS full-disk access), and troubleshooting.

> Desktop-only (it reads a local database file via Node). Not for Obsidian
> mobile.

---

## How it works

WhatsApp Desktop keeps every message in a local SQLite file, `ChatStorage.sqlite`.
This plugin reads that file directly (via a WebAssembly build of SQLite bundled
into the plugin — nothing to install), groups messages by chat, and writes them
into your vault:

```
11-Whatsapp/
  _Conversation Index.md
  Personal/
    Alice Smith 8x1k2p.md
  Groups/
    Project Falcon 3ff0az.md
```

- **One transcript note per chat.** New messages are **appended** on each sync,
  under `## YYYY-MM-DD` day headers.
- **Incremental.** Each chat stores the highest message row id it has written;
  the next sync appends only rows newer than that — exact dedup, even for
  messages sent in the same second.
- **Windowed.** *Sync messages from the last N days* (default 30) bounds how far
  back a sync reads; `0` = all history (heavier first sync).
- **Read-only.** The database is copied to a temp file and read there; the
  plugin never writes to, modifies, or deletes anything in WhatsApp.

Each note carries YAML frontmatter (`source`, `chat_id`, `chat_name`, `kind`)
plus a `# Chat name` heading, followed by the running transcript.

### What it reads

On macOS the plugin reads two files from WhatsApp's shared container
(`~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/`):

- **`ChatStorage.sqlite`** — your messages.
- **`ContactsV2.sqlite`** — saved contact names, used to label senders.

Both are read from **temporary copies**; neither is modified. On macOS this
container is protected, so Obsidian needs **Full Disk Access** — see
[SETUP.md](SETUP.md).

---

## Install

**From source:**

```bash
npm install
npm run build          # produces main.js
VAULT="/path/to/your/vault" npm run install:vault
```

That copies `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/whatsapp-local-sync/`. Then in Obsidian: **Settings →
Community plugins → Installed plugins** → enable **WhatsApp Local Sync**.

---

## Configure & sync

Open **Settings → WhatsApp Local Sync**:

1. **Database status** confirms whether `ChatStorage.sqlite` was found. If not,
   set **Database path override** (see [SETUP.md](SETUP.md) for locations).
2. Pick **Sync group chats** / **Sync personal chats**.
3. Set **Sync messages from the last N days** and, optionally, a **Sync since**
   floor date.
4. Set **Your name** — the label used for messages you sent (WhatsApp stores no
   name for "me").
5. Set **Auto-sync interval** and **Sync on startup** as you like.

Sync anytime via the **ribbon icon** or the **"WhatsApp Local Sync: Sync now"**
command. **Stop** mid-run from settings or the *Stop sync* command; already-written
notes are kept, and the next sync resumes from each chat's cursor.

**Reset sync state** (Maintenance) clears the per-chat cursors so the next sync
re-reads the whole window. Existing notes are left in place (it appends, so this
can duplicate recent messages — clear the notes first if you want a clean rebuild).

---

## Freshness note (WAL)

WhatsApp writes recent messages to a write-ahead log (`ChatStorage.sqlite-wal`)
before checkpointing them into the main file. The plugin reads the main file, so
the newest messages may lag by up to a checkpoint interval. Fully quitting
WhatsApp Desktop flushes the WAL; otherwise the next sync picks them up once
WhatsApp checkpoints. There are no duplicates either way (dedup is by row id).

---

## Observability

- **Status bar:** `WhatsApp · <last sync time>` / `WhatsApp · 45/1200` / `error`.
- **Notices** on completion (message + chat counts) and on errors.
- **Debug logging** toggle → verbose `[whatsapp]` console output
  (open devtools with `Ctrl/Cmd+Shift+I`). Baseline progress prints regardless.

---

## Security & privacy notes

- Everything is **local**. The plugin makes **no network requests** and needs no
  accounts or keys.
- It reads a **copy** of `ChatStorage.sqlite` from a temp directory and deletes
  the copy afterwards. It never modifies the WhatsApp database.
- Your message transcripts are written as **plain Markdown** inside your vault.
  Keep the vault private; don't sync `11-Whatsapp` to untrusted locations.
- On macOS the WhatsApp database lives in a protected container — Obsidian may
  need **Full Disk Access** to read it (see [SETUP.md](SETUP.md)).

---

## Development

```bash
npm install
npm run dev        # esbuild watch, rebuilds main.js on change
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + minified production bundle
```

Source layout:
- `src/main.ts` — plugin lifecycle, ribbon, status bar, commands, timer.
- `src/db.ts` — sql.js loader, DB path detection, windowed query.
- `src/sync.ts` — grouping, incremental append, index regeneration.
- `src/notes.ts` — filename hashing, sanitizing, race-tolerant writes.
- `src/mactime.ts` — Mac absolute-time conversion.
- `src/settings.ts` — settings UI.
- `src/types.ts` — shared types + defaults.

---

## License

Released under the [MIT License](LICENSE) © 2026 Nabheet Madan.

This project is an independent, community-built plugin. It is not affiliated
with, endorsed by, or sponsored by WhatsApp or Meta. "WhatsApp" is a trademark
of WhatsApp LLC / Meta Platforms, Inc.
