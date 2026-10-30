# dsh-local-library

[中文](README.md) · English

A **local library** plugin for DSH Desktop: one file cabinet, shared by every conversation.

- **A new section in the Settings sidebar** — drag-and-drop upload (folders too), search, filter by type, download, batch download as zip, edit tags, delete, rebuild index.
- **Every new conversation knows it is there.** The plugin adds a section to the system prompt and registers four tools (`library_list` / `library_search` / `library_read` / `library_save`). You no longer have to announce "I have a document" — the model checks the library on its own.
- **Duplicate detection.** Uploading identical bytes again asks *Replace / Keep both / Skip* instead of silently storing two copies.
- **Files never leave the machine.** They live in `$DSH_HOME\local-library` (default `%APPDATA%\dsh-desktop\harness\local-library`). Nothing is uploaded anywhere.
- **Searchable contents.** `.md/.txt/.csv/.json/…`, `.docx`, `.xlsx`, `.pptx` and `.pdf` are extracted to plain text. PDFs use the bundled PyMuPDF when available (which handles CJK), then fall back to a zero-dependency stream-level extractor. With a vision model configured, images are described in text and become searchable too.

## What it looks like

Settings (the gear in the bottom-left corner) → **本地资料库** in the left sidebar:

- top: drop zone — drag files or folders, with upload progress;
- middle: search box plus type chips (All / PDF / Word / Sheet / PPT / Image / Text). The query language understands `kind:`, `tag:`, `after:` and `before:`;
- each row: checkbox (multi-select → *Download as zip*), name and metadata, tags (click **Tags** to edit inline, comma separated), match snippet, **Download**, **Delete** (click twice);
- bottom: file count, disk usage, indexed count, **Rebuild index**, and the storage path (copyable).

In a conversation just say "look in my library for X" and the model calls `library_search` itself.

## Install

**Requirements**: Windows (a directory junction is used so the package name resolves — no admin rights needed), DSH Desktop, PowerShell 7.

Clone and run one command:

```powershell
git clone https://github.com/Fucaplos/dsh-local-library.git
cd dsh-local-library
pwsh -File install.ps1
```

Then **restart DSH Desktop** (the host half loads at startup) and **reload the page** (F5 — the client half is served from the startup manifest). Settings → left sidebar should now show 本地资料库.

The script is **idempotent**: if the plugin is already installed it only runs the self-check. Before touching your config it backs the file up to `cordis.patch.yml.bak-dsh-local-library-<timestamp>`.

If your DSH profile is not in the default location (custom `DSH_HOME`, several profiles), pass the path explicitly:

```powershell
pwsh -File install.ps1 -ProfileRoot 'D:\my-dsh\harness\profiles\web'
```

Uninstall (data is kept by default; add `-PurgeData` to delete the files too):

```powershell
pwsh -File uninstall.ps1
```

What the installer does — and why it has to do it this way:

1. Creates a **junction** at `profiles\<name>\node_modules\dsh-local-library` pointing at this directory. DSH resolves plugins by package name; the junction makes the name resolve while the code stays in your workspace, so an edit plus a restart is all it takes.
2. Appends two lines to the existing `- insert:` list in `profiles\<name>\cordis.patch.yml`:
   ```yaml
   - id: dsh-local-library
     name: dsh-local-library
   ```
   `id` must be globally unique and equal to the package name, and nothing may follow `id: value` on the same line (the market pre-check rejects it).
3. Leaves `package.json`, `pnpm-lock.yaml` and the generation projection untouched. Going through pnpm interferes with `.desktop-bin\pnpm.cmd`'s pnpm-runner, which likes to restore the projection to an older state.
4. Finally verifies package resolution: both `dsh-local-library` and `dsh-local-library/client` must resolve, otherwise one half of the plugin is silently missing.

## Layout

| File | Purpose |
| --- | --- |
| `lib/index.js` | Host half: HTTP routes, the four tools, the system-prompt section, the indexing pipeline |
| `lib/client.js` | Client half: the Settings section UI (React, loaded through `window.__ModuleLoader__`) |
| `lib/store.js` | Storage and index: atomic `index.json` writes, CJK bigram scoring, LRU body cache, sha256 dedupe, paged reads |
| `lib/extract.js` | Zero-dependency text extraction: docx/xlsx/pptx via a hand-written ZIP reader, PDF via FlateDecode |
| `lib/pdftext.js` | Optional: pull PDF text through the local PyMuPDF (better for CJK), skipped when not found |
| `lib/vision.js` | Optional: describe images as text (OpenAI-compatible `chat/completions`, Zhipu `glm-4v-flash` by default) |
| `lib/zip.js` | Streaming ZIP writer for batch download (stored, UTF-8 names) |
| `cordis.patch.yml` | Bundle manifest (the `insert` section) |
| `install.ps1` / `uninstall.ps1` | Install into / remove from a DSH profile (junction + patch entry) |
| `test/*.mjs` | Six self-check suites, see below |
| `LICENSE` | MIT |

## HTTP API (same origin, callable from the browser)

Prefix `/dsh-local-library`, no authentication (it sits outside the auth layer):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/list?q=&limit=` | `{items, stats, pending}`; with `q` returns scored hits plus `snippet`; `limit` defaults to 200, max 1000 |
| GET | `/stats` | `{root, count, bytes, bytesText, indexed}` |
| POST | `/upload?name=&dup=&tags=` | raw bytes as body, streamed to disk; `dup` = `reject` (default) / `keep` / `replace`; identical content returns **409** with `duplicate` |
| PATCH | `/item?id=` | body `{name?, tags?}` — rename or retag |
| POST | `/bundle` | body `{ids:[]}` → zip (at most 300 entries) |
| GET | `/download?id=` | original bytes, `content-disposition` with an RFC 5987 filename |
| DELETE | `/item?id=` | remove the entry and the file |
| POST | `/reindex?all=1` | re-run indexing; without `all` only pending entries |

## Tools (in the system prompt, visible every turn)

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `library_list` | `limit?` | List everything |
| `library_search` | `query`, `limit?`, `kind?`, `tag?` | Score names, bodies and tags; returns snippets and `matchedBy`. `kind`/`tag` are shortcuts |
| `library_read` | `id` or `name`, `maxChars?`, `offset?` | Read the body; long documents can be read in pages (`nextOffset`) |
| `library_save` | `name`, `content`, `tags?` | Save a note or a conclusion into the library |

## Optional configuration

Add a `config` block to the entry in the profile's `cordis.patch.yml` (off when absent):

```yaml
- id: dsh-local-library
  name: dsh-local-library
  config:
    vision:
      enabled: true
      apiKey: <your key>
      model: glm-4v-flash          # default
      endpoint: https://open.bigmodel.cn/api/paas/v4/chat/completions  # default
```

With that enabled, uploaded images are described as text and stored in the index, so `library_search` can find them by content.

## Self-checks

```powershell
$env:ELECTRON_NO_ASAR='1'
$node = "$env:APPDATA\dsh-desktop\harness\.desktop-bin\node.cmd"
& $node test\client.smoke.mjs        # client: load, section registration, SSR render (list / multi-select / tags / duplicate prompt)
& $node test\plugin.smoke.mjs        # host: upload → search → paged read → tags → bundle → delete → tools → prompt section
& $node test\bugfix.test.mjs         # regressions: one assertion per audited bug (name with %, offset past the end, empty-file bundle…)
& $node test\navicon.test.mjs        # sidebar icon against a fake DOM (no lookup while the dialog is closed, debounce, disposer)
& $node test\cordis.integration.mjs  # load the plugin in a real Cordis container, assert what it registers
& $node test\extract.test.mjs        # 18 extractor cases
```

## Known limitations

- PDF extraction has two paths: PyMuPDF (accurate, handles CJK, needs the bundled python) → stream-level fallback (fine for ASCII/standard encodings; CJK subset-CID fonts may come out garbled). Scanned pages have no text layer.
- Image search depends on a vision model (`config.vision`); without one you can only find images by name or tag.
- The ZIP reader does not support ZIP64 or encrypted archives and does not verify CRC; both a single archive and one entry are capped at 128 MiB.
- Text-like files are indexed up to 4 MiB (beyond that they are truncated and flagged `truncated`).
- xlsx does not reconstruct date serials, formula results or merged cells.
- Search is **keyword scoring** (CJK bigrams plus Latin words, with names and tags weighted higher), not vector search.
- Folder drops are flattened (no subdirectories); the top-level folder name is recorded as a tag so you can filter by source.
- `tag:` filtering is **substring** matching: `tag:财务` also matches 「财务部」.
- ComfyUI workflow JSON (`.json`, >1.5KB) is reduced to model names, prompts, sampling parameters, canvas size, node titles and node types; node coordinates and widget values never reach the body text, so they are not searchable. Every other JSON file is indexed verbatim.
- This prefix route lives outside the DSH auth layer (the Settings page has to be able to `fetch` it directly), so **any local process that can reach 127.0.0.1:port can read and write the whole library**. Treat it as private local data and do not store secrets in it.

## Changelog

**0.3.1 — structured extraction and match provenance**

- New: ComfyUI workflow JSON is summarised into models / prompts / sampling / canvas / node titles and types. A measured 214 KB workflow went from 152,663 characters to 2,187 while model names and prompts stay searchable.
- New: `library_search` and `GET /list?q=` return `matchedBy` (`body` / `name` / `both`). A name-only or tag-only hit is now labelled “matched by file name or tag” in the tool output and in the Settings list, instead of looking like an empty result.

**0.3 — audit round**

- Fix: upload returned 500 for filenames containing `%` (`URLSearchParams` had already decoded, then `decodeURIComponent` ran again).
- Fix: `library_save` with a blank name silently stored it as 「未命名」.
- Fix: `GET /list` ignored `limit` and leaked the internal `sha256` to the client.
- Fix: `library_read` returned the out-of-range notice as if it were the body when `offset` was past the end.
- Fix: bundling a selection of only zero-byte files returned 404.
- Fix: `reindex` and bulk uploads ran without a concurrency cap (now a 2-lane queue).
- Fix: renaming did not update `ext`/`mime`, so downloads carried a stale Content-Type.
- Fix: paged reads and name truncation could split emoji surrogate pairs.
- Fix: a cancelled zip download could leave the writer waiting on `drain` forever.
- Fix: editing the tags of one row made the tags of every other row disappear.
- Fix: the "file too large, skipped" notice was overwritten by the "uploaded N" notice.
- Fix: selecting more than 300 files bundled fewer without saying so — it now says so.
- Fix: `installNavIcon`'s MutationObserver ran a global selector on every streamed token (now 250 ms debounce, scoped to the Settings dialog).

## License

[MIT](LICENSE) © 2026 Fucaplos

Use it, change it, sell it — just keep the copyright notice and the license text. The software is provided "as is", without warranty.
