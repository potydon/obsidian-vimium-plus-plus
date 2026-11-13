# Vimium++

A Vimium-FF–style keyboard layer for Obsidian. It gives you two modes:

- **Reading mode** (the Vimium layer — the default): every note opens in Reading view. Scroll with `j`/`k`, jump around with `f` click-hints, and never touch the mouse.
- **Editing mode**: press `i` to drop into the editor, where Obsidian's built-in **Vim** key bindings take over. `Escape` first returns Vim to normal mode (from insert/visual/replace); `Escape` in normal mode comes back to Reading mode.

![Click hints shown over links, tabs, and the file tree after pressing `f`](assets/hints.png)

> Not affiliated with the [Vimium](https://github.com/philc/vimium) browser extension or the existing Vimium community plugin — this is an independent reimplementation of the Vimium idea for Obsidian.

## Keybindings (Reading mode)

| Key | Action |
| --- | --- |
| `f` | Show click hints; type the letters to click that element (links, buttons, tabs, ribbon, file tree, checkboxes…). |
| `Shift`+`F` | Same hints, but open the chosen link in a **new tab**. |
| `j` / `k` | Scroll down / up. |
| `d` / `u` | Scroll a half-page down / up. |
| `g g` / `Shift`+`G` | Jump to top / bottom. |
| `Shift`+`J` / `Shift`+`K` | Switch to the next / previous tab. |
| `b` / `Shift`+`B` | Fuzzy-search your bookmarks; open the pick in the current / a new tab. |
| `Shift`+`O` | Omnibar: open a bookmark, recent file, or typed URL in a new tab. |
| `Shift`+`H` / `Shift`+`L` | Go back / forward in history. |
| `/` | Search the current file. |
| `t` | Open a new tab. |
| `x` / `Shift`+`X` | Close the current tab / restore closed tabs. |
| `e` | Toggle the file explorer (focus it, revealing the active note). |
| `i` | Enter editing mode (focus the editor; native Vim active). |
| `Esc` | (In editing mode) leave Vim insert/visual/replace for normal mode; in normal mode, return to Reading mode. |

Any key — or a multi-key sequence like `gT` — can be bound to any command-palette command under **Settings → Vimium++ → Custom key bindings**. Type the keys as plain text; each character is one keypress. Two bindings ship by default: `o` (quick switcher) and `p` (command palette) — remap or remove them as you like. Custom bindings take priority over the built-in keys above; the settings dialog asks for confirmation before you shadow a built-in (or start a sequence with one, which delays it by the chord timeout).

While hints are showing: type the label to activate, `Backspace` to correct, `Esc` to cancel. Holding `Shift` on the **last** letter of a label opens that target in a new tab (even if you started with plain `f`).

## Saving and closing (`:w` / `:q`)

A default `:` binding opens Obsidian's command palette, which makes a Vim-style workflow possible. Two commands are registered without the usual `Vimium++:` prefix so their names really start with the letter, and typing that letter in the palette selects them first:

| Command | Action |
| --- | --- |
| `w: Save note` | Save the active note the same way `Ctrl`/`Cmd`+`S` does. In Reading view there is usually nothing pending, so it acts as a no-op rather than doing something unexpected. |
| `q: Close current tab` | Close the active tab (same as `workspace:close`). |

So `:` then `w` then `Enter` saves, and `:` then `q` then `Enter` closes the tab — the Vim `:w` / `:q` muscle memory, without a modal command line.

## File explorer

The built-in file explorer gets a neo-tree-style key layer while it has focus. Press `e` in Reading mode (or run **Toggle file explorer** from the command palette) to focus it, then:

| Key | Action |
| --- | --- |
| `j` / `k` | Move down / up. |
| `h` / `l` | Collapse the folder / open the file or expand the folder. |
| `Enter` | Open the file. On a folder it opens the folder note (when enabled), expands it, or toggles it, depending on the settings below. |
| `Ctrl`/`Cmd`+`Enter`, `Shift`+`Enter` | Always open the focused folder's folder note. |
| `gg` / `Shift`+`G` | Jump to the first / last item. |
| `z` | Collapse all folders. |
| `a` / `Shift`+`A` | Create a file / folder (end a file name with `/` to create a folder). |
| `d` / `r` / `m` | Delete / rename / move. |
| `c` | Copy to a path. |
| `x` / `y` / `p` | Cut / copy / paste. |
| `u` | Undo the last file operation. |
| `s` / `Shift`+`S` / `t` | Open in a vertical split / horizontal split / new tab. |
| `q` / `Esc` | Close the explorer / focus the editor again. |

File operations use Obsidian's own vault and file-manager APIs, so links are updated on rename/move and deletes follow your trash settings. Deletes can be undone from the plugin's in-memory snapshot (up to 50 operations / 50 MB).

If you use the **Folder Notes** plugin, folder-note files that it hides from the explorer are skipped by `j`/`k`, `gg`/`G`, and folder expansion, so navigation only lands on rows you can actually see. Folder notes you have chosen to show in the explorer still work normally. For the same reason, files whose type Obsidian does not support (for example `.txt`, `.yml`, `.js`) are skipped while **Show unsupported files** is off in Obsidian's settings.

Two settings control folder notes on `Enter`: **Open folder note on Enter** (on by default) makes plain `Enter` open a folder's note; turn it off to require `Ctrl`/`Cmd`+`Enter` or `Shift`+`Enter`. **Expand folder on Enter** makes `Enter` expand a folder instead of toggling it, and expands the folder before opening its note.

## Web viewer tabs

The vim keys also work inside pages opened with Obsidian's core **Web viewer** plugin. Web pages render in a separate Electron webview that the plugin can't reach directly, so a small self-contained script is injected into each page instead (toggleable in settings as **Web viewer integration**).

Inside a page: `j`/`k`/`d`/`u`/`gg`/`G` scroll, `f`/`F` show hints over the page's links and controls (`F` opens the link in a new Web viewer tab), `H`/`L` go back/forward in the page's history, and `J`/`K`/`t`/`x` switch/open/close Obsidian tabs. Typing in a page's text field passes keys through as usual; `Esc` blurs the field, and `Esc` again hands focus back to Obsidian.

Limitations: custom key bindings and terminal commands don't fire while the page itself has focus (the page-to-Obsidian channel is intentionally restricted to a small fixed set of actions, since a malicious page could forge it) — press `Esc` first, then they work as normal. Hints cover the page's top frame only, and some pages (PDFs, error pages) refuse script injection entirely.

## How the modes map to Obsidian

The plugin ties "command mode" to Obsidian's **Reading view** rather than a fragile focus heuristic. It forces every note to open in Reading view (toggleable in settings) and turns on Obsidian's native Vim key bindings, so `i` lands you in a real Vim editor. Both overridden settings are restored when you disable the plugin.

Escape is mode-aware: in Vim insert, visual, or replace mode it is left for Vim to return to normal; in Vim normal mode `Esc` flips the note back to Reading view. That normal-mode exit can be turned off with the **Escape returns to Reading mode** setting, leaving `Esc` entirely to the editor.

## Settings

Hint characters, hint font size, scroll step, force-Reading-view toggle, Escape-returns-to-Reading toggle, native-Vim toggle, mode-indicator toggle, Web viewer integration toggle, file-explorer keys, Enter/folder-note behavior, delete confirmation, and the list of CSS selectors that become hint targets.

## Build

Requires Node.js (18+).

```bash
npm install
npm run dev      # esbuild watch → main.js
npm run build    # type-check + production bundle
```

## Install into a vault

Copy (or symlink) `manifest.json`, `main.js`, and `styles.css` into:

```
<your-vault>/.obsidian/plugins/vimium-plus-plus/
```

Then enable **Vimium++** under Settings → Community plugins (turn on community plugins first if needed).

For active development, symlink the repo so each rebuild is picked up:

```bash
ln -s "$(pwd)" "<your-vault>/.obsidian/plugins/vimium-plus-plus"
```

…and reload Obsidian (or use the Hot-Reload plugin) after each build.

## Verify it works

1. Open any note → it appears in **Reading view**.
2. `j`/`k` scroll; `d`/`u` half-page; `gg`/`G` top/bottom; `Shift`+`J`/`Shift`+`K` switch tabs.
3. Press `f` → hint letters appear over links/buttons (in the note **and** on tabs/ribbon/file tree); type a label to click it; `Esc` cancels. `Shift`+`F` opens the link in a new tab.
4. Press `i` → the note switches to the editor, focused, with native Vim (`h j k l`, `i` to insert).
5. `Esc` in normal mode → back to Reading mode; in insert/visual mode it returns Vim to normal first.
6. Typing in the search box is **not** hijacked by `j`/`k`/`f`.
