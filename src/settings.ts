import {
	App,
	Command,
	FuzzySuggestModal,
	Modal,
	Notice,
	PluginSettingTab,
	Setting,
	TextComponent,
} from "obsidian";
import type VimiumPlugin from "./main";
import { normalizeLeaderKey } from "./leader/keys";

/** Built-in reading-mode keys and what they do; used to warn before a custom binding shadows one. */
export const BUILTIN_KEYS: Record<string, string> = {
	f: "show click hints",
	F: "show click hints in a new tab",
	j: "scroll down",
	k: "scroll up",
	J: "next tab",
	K: "previous tab",
	d: "half-page down",
	u: "half-page up",
	g: "jump to top (gg)",
	G: "jump to bottom",
	i: "enter editing mode",
	b: "bookmark search",
	B: "bookmark search in a new tab",
	O: "omnibar in a new tab",
	H: "go back in history",
	L: "go forward in history",
	"/": "search current file",
	t: "new tab",
	x: "close tab",
	X: "restore closed tab",
	e: "toggle file explorer",
};

/** What a reading-mode binding does: run a command, or spawn a shell command. */
export type ReadingBindingKind = "command" | "terminal";

/** A user-defined key that runs a command or shell command in reading mode. */
export interface ReadingBinding {
	/** KeyboardEvent.key value, e.g. "x", "X", "ArrowDown". Empty = unset. */
	key: string;
	kind: ReadingBindingKind;
	/** Command id, e.g. "editor:toggle-bold". Used when kind is "command". */
	commandId: string;
	/** Command display name, kept so the row stays readable if the command's plugin is disabled. */
	commandName: string;
	/** Shell command template; {{path}}, {{folder}}, {{vault}} are substituted. */
	terminalCommand: string;
}

/** What a leader binding does: run a command, or open a note. */
export type LeaderActionKind = "command" | "file";

/** A key sequence typed after the leader key, e.g. `<Space>ff`. */
export interface LeaderBinding {
	/** Keys after the leader. Vim notation: "ff", "gT", "<C-s>". Empty = unset. */
	keys: string;
	/** Label shown in the which-key popup. Falls back to the command or file name. */
	description: string;
	kind: LeaderActionKind;
	/** Command id, e.g. "switcher:open". Empty = unset. */
	commandId: string;
	/** Command display name, kept so the row stays readable if the plugin is disabled. */
	commandName: string;
	/** Vault path or note name, used when kind is "file". */
	filePath: string;
}

/** A named prefix in the leader keymap, shown as "+name" in the which-key popup. */
export interface LeaderGroup {
	/** Key prefix after the leader, e.g. "f". Empty = unset. */
	prefix: string;
	/** Group name, e.g. "find". Empty = unset. */
	name: string;
}

export interface VimiumSettings {
	/** Characters used to build hint labels (in priority order). */
	hintChars: string;
	/** CSS selectors whose matching, visible elements become hint targets. */
	selectors: string[];
	/** Font size (px) of hint markers. */
	hintFontSize: number;
	/** Pixels scrolled per j/k press. */
	scrollStep: number;
	/** Force every opened note into Reading view (the Vimium layer). */
	forceReadingView: boolean;
	/** Escape in the editor (normal Vim mode) returns to Reading view. */
	escapeReturnsToReading: boolean;
	/** Turn on Obsidian's native Vim key bindings on load. */
	enableNativeVim: boolean;
	/** Show a small mode indicator pill. */
	showModeIndicator: boolean;
	/** Mirror Vim's unnamed register to the system clipboard. */
	registerSystemClipboard: boolean;
	/** Lines of context to keep around the cursor while scrolling. */
	scrolloff: number;
	/** Mod-D selects the word under the cursor and adds next-match cursors. */
	modD: boolean;
	/** Install native Vim j/k mappings to the table-aware gj/gk motion. */
	jkAsGjGk: boolean;
	/** Modal cell navigation for Obsidian's native Live Preview tables. */
	tableNavigation: boolean;
	/** Inject vim keys and hints into Web viewer tabs (Electron webviews). */
	enableWebviewIntegration: boolean;
	/** Neo-tree-style keys while the built-in file explorer is focused. */
	explorerKeys: boolean;
	/** Plain Enter on a folder opens its Folder Notes note instead of toggling. */
	enterOpensFolderNote: boolean;
	/** Plain Enter on a folder expands it instead of toggling it. */
	expandFolderOnEnter: boolean;
	/** Ask before `d` deletes a file or folder in the explorer. */
	confirmDelete: boolean;
	/** Custom reading-mode key bindings: commands and shell commands. */
	keyBindings: ReadingBinding[];
	/** Key that starts a leader sequence. Vim notation, e.g. "<Space>". */
	leaderKey: string;
	/** Where the leader key starts a sequence: only the usual panes, any
	 *  non-text focus, or Markdown views only. */
	activateOnLeaderKey: "disabled" | "enabled" | "markdown_only";
	/** Key sequences typed after the leader key. */
	leaderBindings: LeaderBinding[];
	/** Names for leader prefixes, shown as "+name" in the which-key popup. */
	leaderGroups: LeaderGroup[];
	/** Show the which-key popup while a leader sequence is pending. */
	whichKey: boolean;
	/** Milliseconds to wait before showing the which-key popup. */
	whichKeyDelay: number;
	/** Milliseconds before an unfinished leader sequence is dropped. 0 = never. */
	leaderTimeout: number;
}

export const DEFAULT_SELECTORS = [
	// App chrome
	".workspace-tab-header",
	".workspace-tab-header-inner",
	".side-dock-ribbon-action",
	".clickable-icon",
	".nav-file-title",
	".nav-folder-title",
	".tree-item-self",
	".menu-item",
	// Rendered note content (Reading view)
	".markdown-preview-view a",
	".markdown-preview-view .internal-link",
	".markdown-preview-view .external-link",
	".markdown-preview-view .tag",
	".markdown-preview-view .task-list-item-checkbox",
	".markdown-preview-view button",
	".markdown-embed-link",
];

export const DEFAULT_SETTINGS: VimiumSettings = {
	// Home-row-first alphabet, like Vimium.
	hintChars: "sadfjklewcmpgh",
	selectors: DEFAULT_SELECTORS,
	hintFontSize: 11,
	scrollStep: 70,
	forceReadingView: true,
	escapeReturnsToReading: true,
	enableNativeVim: true,
	showModeIndicator: true,
	registerSystemClipboard: true,
	scrolloff: 4,
	modD: true,
	jkAsGjGk: false,
	tableNavigation: true,
	enableWebviewIntegration: true,
	explorerKeys: true,
	enterOpensFolderNote: true,
	expandFolderOnEnter: false,
	confirmDelete: true,
	keyBindings: [
		{
			key: "p",
			kind: "command",
			commandId: "command-palette:open",
			commandName: "Command palette: Open command palette",
			terminalCommand: "",
		},
		{
			key: "o",
			kind: "command",
			commandId: "switcher:open",
			commandName: "Quick switcher: Open quick switcher",
			terminalCommand: "",
		},
	],
	leaderKey: "<Space>",
	activateOnLeaderKey: "disabled",
	leaderBindings: [
		{
			keys: "ff",
			description: "Quick switcher",
			kind: "command",
			commandId: "switcher:open",
			commandName: "Quick switcher: Open quick switcher",
			filePath: "",
		},
		{
			keys: "fp",
			description: "Command palette",
			kind: "command",
			commandId: "command-palette:open",
			commandName: "Command palette: Open command palette",
			filePath: "",
		},
		{
			keys: "fs",
			description: "Search in vault",
			kind: "command",
			commandId: "global-search:open",
			commandName: "Search: Search in all files",
			filePath: "",
		},
		{
			keys: "fb",
			description: "Bookmarks",
			kind: "command",
			commandId: "bookmarks:open",
			commandName: "Bookmarks: Show bookmarks",
			filePath: "",
		},
		{
			keys: "qq",
			description: "Close tab",
			kind: "command",
			commandId: "workspace:close",
			commandName: "Close current tab",
			filePath: "",
		},
		{
			keys: "qn",
			description: "New tab",
			kind: "command",
			commandId: "workspace:new-tab",
			commandName: "New tab",
			filePath: "",
		},
		{
			keys: "qs",
			description: "Save note",
			kind: "command",
			commandId: "editor:save-file",
			commandName: "Save current file",
			filePath: "",
		},
		{
			keys: "wv",
			description: "Split right",
			kind: "command",
			commandId: "workspace:split-vertical",
			commandName: "Split right",
			filePath: "",
		},
		{
			keys: "wh",
			description: "Split down",
			kind: "command",
			commandId: "workspace:split-horizontal",
			commandName: "Split down",
			filePath: "",
		},
	],
	leaderGroups: [
		{ prefix: "f", name: "find" },
		{ prefix: "q", name: "quit" },
		{ prefix: "w", name: "workspace" },
	],
	whichKey: true,
	whichKeyDelay: 200,
	leaderTimeout: 0,
};

/** Asks the user to confirm a binding that shadows or delays a built-in key. */
class ConfirmKeyModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private heading: string,
		private message: string,
		private confirmLabel: string,
		private onResult: (confirmed: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText(this.confirmLabel)
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.confirmed = true;
						this.close();
					})
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onResult(this.confirmed);
	}
}

/** Fuzzy picker over every command in the command palette. */
class CommandSuggestModal extends FuzzySuggestModal<Command> {
	constructor(app: App, private onChoose: (command: Command) => void) {
		super(app);
		this.setPlaceholder("Pick a command…");
	}

	getItems(): Command[] {
		return this.app.commands.listCommands();
	}

	getItemText(command: Command): string {
		return command.name;
	}

	onChooseItem(command: Command): void {
		this.onChoose(command);
	}
}

export class VimiumSettingTab extends PluginSettingTab {
	plugin: VimiumPlugin;
	/** Sortable settings row being dragged, while a drag is in progress. */
	private rowDrag: { kind: "group" | "leaderBinding" | "binding"; index: number } | null = null;

	constructor(app: App, plugin: VimiumPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		// Rebuilding the tab (after adding, removing, or reordering rows) should
		// keep the reader where they were instead of jumping back to the top.
		const scroller =
			containerEl.closest<HTMLElement>(".vertical-tab-content") ?? containerEl;
		const scrollTop = scroller.scrollTop;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Hint characters")
			.setDesc("Characters used to generate hint labels, in priority order.")
			.addText((text) => {
				text
					.setValue(this.plugin.settings.hintChars)
					.onChange(async (value) => {
						const cleaned = [
							...new Set(value.toLowerCase().replace(/[^a-z]/g, "")),
						].join("");
						this.plugin.settings.hintChars = cleaned || DEFAULT_SETTINGS.hintChars;
						await this.plugin.saveSettings();
					});
				// Show what was actually saved (deduped/lowercased, or the
				// default if the field was emptied).
				text.inputEl.addEventListener("blur", () => {
					text.setValue(this.plugin.settings.hintChars);
				});
			});

		new Setting(containerEl)
			.setName("Hint font size")
			.setDesc("Font size of the hint markers, in pixels.")
			.addSlider((slider) =>
				slider
					.setLimits(8, 24, 1)
					.setValue(this.plugin.settings.hintFontSize)
					.onChange(async (value) => {
						this.plugin.settings.hintFontSize = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Scroll step")
			.setDesc("Pixels scrolled per j / k press.")
			.addSlider((slider) =>
				slider
					.setLimits(20, 300, 10)
					.setValue(this.plugin.settings.scrollStep)
					.onChange(async (value) => {
						this.plugin.settings.scrollStep = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Force Reading view")
			.setDesc("Open every note in Reading view so the Vimium layer is always active by default. Changes the editor's global default view mode; the previous value is restored when this is turned off or the plugin is disabled.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.forceReadingView)
					.onChange(async (value) => {
						this.plugin.settings.forceReadingView = value;
						await this.plugin.saveSettings();
						this.plugin.applyForceReadingView(value);
					})
			);

		new Setting(containerEl)
			.setName("Escape returns to Reading mode")
			.setDesc("While editing a note, press Escape in normal Vim mode to leave the editor and go back to Reading view. Turn this off to keep Escape inside the editor.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.escapeReturnsToReading)
					.onChange(async (value) => {
						this.plugin.settings.escapeReturnsToReading = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable native Vim")
			.setDesc("Turn on Obsidian's built-in Vim key bindings so 'i' drops you into a Vim editor. Changes the editor's global Vim setting; the previous value is restored when this is turned off or the plugin is disabled.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableNativeVim)
					.onChange(async (value) => {
						this.plugin.settings.enableNativeVim = value;
						await this.plugin.saveSettings();
						this.plugin.applyNativeVim(value);
					})
			);

		new Setting(containerEl)
			.setName("Show mode indicator")
			.setDesc("Show a small pill indicating the current mode.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showModeIndicator)
					.onChange(async (value) => {
						this.plugin.settings.showModeIndicator = value;
						await this.plugin.saveSettings();
						this.plugin.refreshModeIndicator();
					})
			);

		new Setting(containerEl)
			.setName("Web viewer integration")
			.setDesc("Inject the vim keys (scrolling, hints, tab switching) into Web viewer pages. Custom reading-mode bindings still require focus to be outside the page.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableWebviewIntegration)
					.onChange(async (value) => {
						this.plugin.settings.enableWebviewIntegration = value;
						await this.plugin.saveSettings();
						this.plugin.applyWebviewIntegration(value);
					})
			);

		new Setting(containerEl)
			.setName("Enable file explorer keys")
			.setDesc("Neo-tree-style keys while the built-in file explorer has focus. Press e in Reading mode (or run the Toggle file explorer command) to focus the explorer.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.explorerKeys)
					.onChange(async (value) => {
						this.plugin.settings.explorerKeys = value;
						await this.plugin.saveSettings();
						this.plugin.refreshModeIndicator();
					})
			);

		new Setting(containerEl)
			.setName("Open folder note on Enter")
			.setDesc("While the file explorer has focus, Enter on a folder opens its Folder Notes note. Turn this off to open folder notes with Ctrl+Enter or Shift+Enter instead.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enterOpensFolderNote)
					.onChange(async (value) => {
						this.plugin.settings.enterOpensFolderNote = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Expand folder on Enter")
			.setDesc("Enter on a folder expands it instead of toggling it. When Enter also opens a folder note, the folder is expanded first.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.expandFolderOnEnter)
					.onChange(async (value) => {
						this.plugin.settings.expandFolderOnEnter = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Confirm before deleting in the explorer")
			.setDesc("Ask before d deletes a file or folder while the file explorer has focus.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.confirmDelete)
					.onChange(async (value) => {
						this.plugin.settings.confirmDelete = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Hint target selectors")
			.setDesc("One CSS selector per line. Visible elements matching any selector become hint targets.")
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.selectors.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.selectors = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 12;
				text.inputEl.addClass("vimium-selectors-input");
			});

		this.displayVimEnhancements(containerEl);
		this.displayExplorerKeys(containerEl);
		this.displayLeader(containerEl);
		this.displayLeaderKeys(containerEl);
		this.displayKeyBindings(containerEl);

		scroller.scrollTop = scrollTop;
	}

	private displayVimEnhancements(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Vim enhancements").setHeading();
		new Setting(containerEl)
			.setName("Register system clipboard")
			.setDesc(
				"Mirror Vim's unnamed register to the system clipboard. Yanks and deletes go to the OS clipboard, and p reads from it. Named registers are unchanged."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.registerSystemClipboard)
					.onChange(async (value) => {
						this.plugin.settings.registerSystemClipboard = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Scrolloff")
			.setDesc(
				"Keep this many lines of context above and below the cursor while moving in the editor. Set to 0 to disable."
			)
			.addText((text) => {
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.scrolloff))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.scrolloff = Number.isFinite(parsed)
							? Math.max(0, parsed)
							: 0;
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName("Select word under cursor (Mod-D)")
			.setDesc(
				"Mod-D selects the word under the cursor (viw); press it again to add a cursor at the next match. Disable Obsidian's own Mod-D hotkey first."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.modD)
					.onChange(async (value) => {
						this.plugin.settings.modD = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Use gj/gk for j/k")
			.setDesc(
				"Install native Vim normal-mode mappings j to gj and k to gk, the same way vimrc-support does. Counts and pending prefixes stay with Vim. Inside Markdown tables the display-line motion keeps the cell column and skips the separator row."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.jkAsGjGk)
					.onChange(async (value) => {
						this.plugin.settings.jkAsGjGk = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Table navigation")
			.setDesc(
				"In a native Live Preview table cell, use h/j/k/l to move between cells, i/a/c/s or Enter to edit the cell, and Escape to return to cell navigation. Tab moves to the next cell."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tableNavigation)
					.onChange(async (value) => {
						this.plugin.settings.tableNavigation = value;
						await this.plugin.saveSettings();
					})
			);
		containerEl.createEl("p", {
			text: "Also enabled: vim surround (ys, ds, cs, visual S), per-cursor motions with multiple cursors (h/j/k/l/w/W/b/B/e/E/$, ^), Mod-Alt-Up/Down vertical cursors, gd/gx link actions, and list-aware o.",
			cls: "setting-item-description",
		});
	}

	private displayExplorerKeys(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("File explorer keys").setHeading();
		containerEl.createEl("p", {
			text: "While the file explorer is focused: j/k move · h/l collapse or expand · Enter opens a file, opens the folder note, expands, or toggles a folder (see the two Enter settings above); Ctrl/Cmd+Enter or Shift+Enter always opens the folder note · gg/G first or last · z collapse all · a/A new file or folder · d delete · r rename · m move · c copy to path · x/y cut/copy · p paste · u undo · s/S/t split or tab · q close · Esc back to the editor.",
			cls: "setting-item-description",
		});
	}

	private displayLeader(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Leader").setHeading();
		containerEl.createEl("p", {
			text: "Press the leader key, then a sequence. A which-key popup lists what can follow. Leader bindings work in Reading mode, in the editor's Vim normal mode, and while the file explorer is focused; with Activate on leader key they also work in any pane where you are not typing. They never interfere with typing in insert or visual mode, or a Web viewer page.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Leader key")
			.setDesc("One key, in Vim notation: <Space>, <C-Space>, or a plain character. Pressing it starts a sequence.")
			.addText((text) => {
				text.setPlaceholder("<Space>").setValue(this.plugin.settings.leaderKey);
				text.inputEl.addClass("vimium-keybinding-key");

				const commit = (): void => {
					const normalized = normalizeLeaderKey(text.inputEl.value);
					if (normalized == null) {
						new Notice("The leader key must be exactly one key.");
						text.setValue(this.plugin.settings.leaderKey);
						return;
					}
					this.plugin.settings.leaderKey = normalized;
					text.setValue(normalized);
					void this.plugin.saveSettings();
				};
				text.inputEl.addEventListener("change", commit);
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") text.inputEl.blur();
				});
			});

		new Setting(containerEl)
			.setName("Activate on leader key")
			.setDesc(
				"Start the leader sequence from any pane where you are not typing, not just Reading mode and the file explorer. Web viewer, Canvas, and the bookmarks, outline, and tag sidebars are left alone. Markdown only restricts this to Markdown views. Disabled keeps the leader to the usual panes."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						disabled: "Disabled",
						enabled: "Enabled",
						markdown_only: "Markdown only",
					})
					.setValue(this.plugin.settings.activateOnLeaderKey)
					.onChange(async (value) => {
						this.plugin.settings.activateOnLeaderKey =
							value as VimiumSettings["activateOnLeaderKey"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show which-key popup")
			.setDesc("List the keys that can follow the current prefix while a leader sequence is pending.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.whichKey)
					.onChange(async (value) => {
						this.plugin.settings.whichKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Which-key delay")
			.setDesc("Milliseconds to wait before showing the popup. 0 shows it immediately.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 1000, 50)
					.setValue(this.plugin.settings.whichKeyDelay)
					.onChange(async (value) => {
						this.plugin.settings.whichKeyDelay = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Pending sequence timeout")
			.setDesc("Milliseconds before an unfinished leader sequence is cancelled. 0 keeps it open until Esc.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 5000, 250)
					.setValue(this.plugin.settings.leaderTimeout)
					.onChange(async (value) => {
						this.plugin.settings.leaderTimeout = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private displayLeaderKeys(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Leader keys").setHeading();
		containerEl.createEl("p", {
			text: "Keys typed after the leader. Use Vim notation for special keys: <Space>, <CR>, <Esc>, <BS>, <Tab>, <C-x>. Groups name a prefix so the which-key popup shows it as +name. Bindings run a command from the command palette or open a note by name or vault path. Drag the handle to reorder groups or bindings.",
			cls: "setting-item-description",
		});

		if (this.plugin.settings.leaderGroups.length > 0) {
			containerEl.createEl("p", {
				text: "Groups",
				cls: "setting-item-description vimium-leader-subheading",
			});
		}

		this.plugin.settings.leaderGroups.forEach((group, index) => {
			const row = new Setting(containerEl);
			row.settingEl.addClass("vimium-leader-group-row");
			this.attachRowDrag(row, "group", index, containerEl);

			row.addText((text) => {
				text.setPlaceholder("Prefix").setValue(group.prefix);
				text.inputEl.addClass("vimium-keybinding-key");
				text.onChange(async (value) => {
					group.prefix = value.trim();
					await this.plugin.saveSettings();
				});
			});

			row.addText((text) => {
				text.setPlaceholder("Group name").setValue(group.name);
				text.inputEl.addClass("vimium-leader-group-name");
				text.onChange(async (value) => {
					group.name = value.trim();
					await this.plugin.saveSettings();
				});
			});

			row.addExtraButton((button) => {
				button
					.setIcon("trash")
					.setTooltip("Remove group")
					.onClick(async () => {
						this.plugin.settings.leaderGroups.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					});
			});
		});

		const addGroup = new Setting(containerEl);
		addGroup.settingEl.addClass("vimium-leader-actions");
		addGroup.addButton((button) => {
			button.setButtonText("Add group").onClick(async () => {
				this.plugin.settings.leaderGroups.push({ prefix: "", name: "" });
				await this.plugin.saveSettings();
				this.display();
			});
		});

		if (this.plugin.settings.leaderBindings.length > 0) {
			containerEl.createEl("p", {
				text: "Bindings",
				cls: "setting-item-description vimium-leader-subheading",
			});
		}

		this.plugin.settings.leaderBindings.forEach((binding, index) => {
			const row = new Setting(containerEl);
			row.settingEl.addClass("vimium-leader-row");
			this.attachRowDrag(row, "leaderBinding", index, containerEl);

			row.addText((text) => {
				text.setPlaceholder("Key(s)").setValue(binding.keys);
				text.inputEl.addClass("vimium-keybinding-key");
				text.onChange(async (value) => {
					binding.keys = value.trim();
					await this.plugin.saveSettings();
				});
			});

			row.addText((text) => {
				text.setPlaceholder("Description").setValue(binding.description);
				text.inputEl.addClass("vimium-leader-desc");
				text.onChange(async (value) => {
					binding.description = value;
					await this.plugin.saveSettings();
				});
			});

			row.addDropdown((dropdown) => {
				dropdown.addOption("command", "Command");
				dropdown.addOption("file", "File");
				dropdown.setValue(binding.kind);
				dropdown.onChange(async (value) => {
					binding.kind = value === "file" ? "file" : "command";
					await this.plugin.saveSettings();
					this.display();
				});
			});

			if (binding.kind === "file") {
				row.addText((text) => {
					text.setPlaceholder("Note name or path").setValue(binding.filePath);
					text.inputEl.addClass("vimium-leader-file");
					text.onChange(async (value) => {
						binding.filePath = value.trim();
						await this.plugin.saveSettings();
					});
				});
			} else {
				row.addButton((button) => {
					button
						.setButtonText(binding.commandName || "Choose command…")
						.onClick(() => {
							new CommandSuggestModal(this.app, (command) => {
								binding.commandId = command.id;
								binding.commandName = command.name;
								if (!binding.description.trim()) {
									binding.description = command.name;
								}
								button.setButtonText(command.name);
								void this.plugin.saveSettings();
							}).open();
						});
				});
			}

			row.addExtraButton((button) => {
				button
					.setIcon("trash")
					.setTooltip("Remove binding")
					.onClick(async () => {
						this.plugin.settings.leaderBindings.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					});
			});
		});

		const addBinding = new Setting(containerEl);
		addBinding.settingEl.addClass("vimium-leader-actions");
		addBinding.addButton((button) => {
			button.setButtonText("Add binding").onClick(async () => {
				this.plugin.settings.leaderBindings.push({
					keys: "",
					description: "",
					kind: "command",
					commandId: "",
					commandName: "",
					filePath: "",
				});
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}

	/**
	 * Make a settings row reorderable by dragging its handle. Only the handle
	 * is draggable, so the row's text fields keep working normally.
	 */
	private attachRowDrag(
		row: Setting,
		kind: "group" | "leaderBinding" | "binding",
		index: number,
		containerEl: HTMLElement
	): void {
		const rowEl = row.settingEl;

		row.addExtraButton((button) => {
			button.setIcon("grip-vertical").setTooltip("Drag to reorder");
			const handle = button.extraSettingsEl;
			handle.addClass("vimium-drag-handle");
			handle.draggable = true;

			handle.addEventListener("dragstart", (event) => {
				this.rowDrag = { kind, index };
				rowEl.addClass("vimium-row-dragging");
				if (event.dataTransfer) {
					event.dataTransfer.effectAllowed = "move";
					event.dataTransfer.setData("text/plain", `${kind}:${index}`);
					event.dataTransfer.setDragImage(rowEl, 16, 16);
				}
			});

			handle.addEventListener("dragend", () => {
				this.rowDrag = null;
				rowEl.removeClass("vimium-row-dragging");
				containerEl
					.findAll(".vimium-row-drop-target")
					.forEach((el) => el.removeClass("vimium-row-drop-target"));
			});
		});

		rowEl.addEventListener("dragover", (event) => {
			const drag = this.rowDrag;
			if (!drag || drag.kind !== kind) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			rowEl.addClass("vimium-row-drop-target");
		});

		rowEl.addEventListener("dragleave", (event) => {
			const next = event.relatedTarget as Node | null;
			if (next && rowEl.contains(next)) return;
			rowEl.removeClass("vimium-row-drop-target");
		});

		rowEl.addEventListener("drop", (event) => {
			rowEl.removeClass("vimium-row-drop-target");
			const drag = this.rowDrag;
			if (!drag || drag.kind !== kind) return;
			event.preventDefault();
			void this.moveRowItem(kind, drag.index, index);
		});
	}

	private async moveRowItem(
		kind: "group" | "leaderBinding" | "binding",
		from: number,
		to: number
	): Promise<void> {
		let moved: boolean;
		if (kind === "group") {
			moved = this.reorderItems(this.plugin.settings.leaderGroups, from, to);
		} else if (kind === "leaderBinding") {
			moved = this.reorderItems(this.plugin.settings.leaderBindings, from, to);
		} else {
			moved = this.reorderItems(this.plugin.settings.keyBindings, from, to);
		}
		if (!moved) return;
		await this.plugin.saveSettings();
		this.display();
	}

	/** Move one item and report whether the list changed. */
	private reorderItems<T>(list: T[], from: number, to: number): boolean {
		if (from === to || from < 0 || from >= list.length) return false;
		const [item] = list.splice(from, 1);
		list.splice(Math.max(0, Math.min(to, list.length)), 0, item);
		return true;
	}

	private displayKeyBindings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Reading Mode Bindings").setHeading();
		containerEl.createEl("p", {
			text: "Bind a key — or a sequence like gT — to a command-palette command or a shell command. Active in reading mode. Bindings override the built-in keys (you'll be asked to confirm). For shell commands, {{path}} (active note), {{folder}} (the note's folder), and {{vault}} (vault root) are replaced with quoted absolute paths, and the command runs from the note's folder. Example: kitty --directory {{folder}}",
			cls: "setting-item-description",
		});

		this.plugin.settings.keyBindings.forEach((binding, index) => {
			const row = new Setting(containerEl);
			row.settingEl.addClass("vimium-keybinding-row");
			this.attachRowDrag(row, "binding", index, containerEl);

			row.addText((text) => {
				text.setPlaceholder("Key(s)").setValue(binding.key);
				text.inputEl.addClass("vimium-keybinding-key");
				this.attachKeySequenceField(
					text,
					() => binding.key,
					(key) => {
						binding.key = key;
					},
					(key) =>
						this.plugin.settings.keyBindings.some(
							(other) => other !== binding && other.key === key
						)
				);
			});

			row.addDropdown((dropdown) => {
				dropdown.addOption("command", "Command");
				dropdown.addOption("terminal", "Terminal");
				dropdown.setValue(binding.kind);
				dropdown.selectEl.addClass("vimium-binding-kind");
				dropdown.onChange(async (value) => {
					binding.kind = value === "terminal" ? "terminal" : "command";
					await this.plugin.saveSettings();
					this.display();
				});
			});

			if (binding.kind === "terminal") {
				row.addText((text) => {
					text.setPlaceholder("Shell command…").setValue(binding.terminalCommand);
					text.inputEl.addClass("vimium-terminal-command");
					text.onChange(async (value) => {
						binding.terminalCommand = value.trim();
						await this.plugin.saveSettings();
					});
				});
			} else {
				row.addButton((button) => {
					button
						.setButtonText(binding.commandName || "Choose command…")
						.onClick(() => {
							new CommandSuggestModal(this.app, (command) => {
								binding.commandId = command.id;
								binding.commandName = command.name;
								button.setButtonText(command.name);
								void this.plugin.saveSettings();
							}).open();
						});
				});
			}

			row.addExtraButton((button) => {
				button
					.setIcon("trash")
					.setTooltip("Remove binding")
					.onClick(async () => {
						this.plugin.settings.keyBindings.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					});
			});
		});

		const addBinding = new Setting(containerEl);
		addBinding.settingEl.addClass("vimium-binding-actions");
		addBinding.addButton((button) => {
			button.setButtonText("Add new binding").onClick(async () => {
				this.plugin.settings.keyBindings.push({
					key: "",
					kind: "command",
					commandId: "",
					commandName: "",
					terminalCommand: "",
				});
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}

	/**
	 * Wire a key-sequence text field. Committed on blur/Enter, not per
	 * keystroke, so a sequence like "gT" is validated as a whole. Rejects keys
	 * already bound elsewhere and asks for confirmation before shadowing or
	 * delaying a built-in key.
	 */
	private attachKeySequenceField(
		text: TextComponent,
		getKey: () => string,
		setKey: (key: string) => void,
		isDuplicate: (key: string) => boolean
	): void {
		const commit = (): void => {
			const newKey = text.inputEl.value.trim();
			if (newKey === getKey()) return;
			if (newKey && isDuplicate(newKey)) {
				new Notice(`"${newKey}" is already bound to another command.`);
				text.setValue(getKey());
				return;
			}
			const apply = (): void => {
				setKey(newKey);
				void this.plugin.saveSettings();
			};
			const done = (ok: boolean): void => {
				if (ok) apply();
				else text.setValue(getKey());
			};
			const first = newKey.charAt(0);
			if ((newKey.length === 1 && BUILTIN_KEYS[newKey]) || newKey === "gg") {
				const shadowed = newKey === "gg" ? "gg" : newKey;
				new ConfirmKeyModal(
					this.app,
					"Override built-in key?",
					`"${shadowed}" is a built-in key (${BUILTIN_KEYS[first]}). Binding a command to it will override the built-in action in reading mode.`,
					"Override",
					done
				).open();
			} else if (newKey.length > 1 && BUILTIN_KEYS[first]) {
				new ConfirmKeyModal(
					this.app,
					"Delay built-in key?",
					`This sequence starts with "${first}", a built-in key (${BUILTIN_KEYS[first]}). While the plugin waits for the rest of the sequence, the built-in action will only run after a short chord timeout.`,
					"Bind anyway",
					done
				).open();
			} else {
				apply();
			}
		};
		text.inputEl.addEventListener("change", commit);
		text.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") text.inputEl.blur();
		});
	}
}
