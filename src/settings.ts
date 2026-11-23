import {
	App,
	Command,
	FuzzySuggestModal,
	Modal,
	Notice,
	PluginSettingTab,
	Setting,
	TextComponent,
	type SettingDefinition,
	type SettingDefinitionItem,
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

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;

		const general: SettingDefinitionItem[] = [
			{
				name: "Hint characters",
				desc: "Characters used to generate hint labels, in priority order.",
				control: {
					type: "text",
					key: "hintChars",
					defaultValue: DEFAULT_SETTINGS.hintChars,
				},
			},
			{
				name: "Hint font size",
				desc: "Font size of the hint markers, in pixels.",
				control: {
					type: "slider",
					key: "hintFontSize",
					min: 8,
					max: 24,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.hintFontSize,
				},
			},
			{
				name: "Scroll step",
				desc: "Pixels scrolled per j / k press.",
				control: {
					type: "slider",
					key: "scrollStep",
					min: 20,
					max: 300,
					step: 10,
					defaultValue: DEFAULT_SETTINGS.scrollStep,
				},
			},
			{
				name: "Force Reading view",
				desc: "Open every note in Reading view so the Vimium layer is always active by default. Changes the editor's global default view mode; the previous value is restored when this is turned off or the plugin is disabled.",
				control: {
					type: "toggle",
					key: "forceReadingView",
					defaultValue: DEFAULT_SETTINGS.forceReadingView,
				},
			},
			{
				name: "Escape returns to Reading mode",
				desc: "While editing a note, press Escape in normal Vim mode to leave the editor and go back to Reading view. Turn this off to keep Escape inside the editor.",
				control: {
					type: "toggle",
					key: "escapeReturnsToReading",
					defaultValue: DEFAULT_SETTINGS.escapeReturnsToReading,
				},
			},
			{
				name: "Enable native Vim",
				desc: "Turn on Obsidian's built-in Vim key bindings so 'i' drops you into a Vim editor. Changes the editor's global Vim setting; the previous value is restored when this is turned off or the plugin is disabled.",
				control: {
					type: "toggle",
					key: "enableNativeVim",
					defaultValue: DEFAULT_SETTINGS.enableNativeVim,
				},
			},
			{
				name: "Show mode indicator",
				desc: "Show a small pill indicating the current mode.",
				control: {
					type: "toggle",
					key: "showModeIndicator",
					defaultValue: DEFAULT_SETTINGS.showModeIndicator,
				},
			},
			{
				name: "Web viewer integration",
				desc: "Inject the vim keys (scrolling, hints, tab switching) into Web viewer pages. Custom reading-mode bindings still require focus to be outside the page.",
				control: {
					type: "toggle",
					key: "enableWebviewIntegration",
					defaultValue: DEFAULT_SETTINGS.enableWebviewIntegration,
				},
			},
			{
				name: "Enable file explorer keys",
				desc: "Neo-tree-style keys while the built-in file explorer has focus. Press e in Reading mode (or run the Toggle file explorer command) to focus the explorer.",
				control: {
					type: "toggle",
					key: "explorerKeys",
					defaultValue: DEFAULT_SETTINGS.explorerKeys,
				},
			},
			{
				name: "Open folder note on Enter",
				desc: "While the file explorer has focus, Enter on a folder opens its Folder Notes note. Turn this off to open folder notes with Ctrl+Enter or Shift+Enter instead.",
				control: {
					type: "toggle",
					key: "enterOpensFolderNote",
					defaultValue: DEFAULT_SETTINGS.enterOpensFolderNote,
				},
			},
			{
				name: "Expand folder on Enter",
				desc: "Enter on a folder expands it instead of toggling it. When Enter also opens a folder note, the folder is expanded first.",
				control: {
					type: "toggle",
					key: "expandFolderOnEnter",
					defaultValue: DEFAULT_SETTINGS.expandFolderOnEnter,
				},
			},
			{
				name: "Confirm before deleting in the explorer",
				desc: "Ask before d deletes a file or folder while the file explorer has focus.",
				control: {
					type: "toggle",
					key: "confirmDelete",
					defaultValue: DEFAULT_SETTINGS.confirmDelete,
				},
			},
			{
				name: "Hint target selectors",
				desc: "One CSS selector per line. Visible elements matching any selector become hint targets.",
				control: {
					type: "textarea",
					key: "selectors",
				},
			},
		];

		const vimItems: SettingDefinition[] = [
			{
				name: "Register system clipboard",
				desc: "Mirror Vim's unnamed register to the system clipboard. Yanks and deletes go to the OS clipboard, and p reads from it. Named registers are unchanged.",
				control: {
					type: "toggle",
					key: "registerSystemClipboard",
					defaultValue: DEFAULT_SETTINGS.registerSystemClipboard,
				},
			},
			{
				name: "Scrolloff",
				desc: "Keep this many lines of context above and below the cursor while moving in the editor. Set to 0 to disable.",
				control: {
					type: "number",
					key: "scrolloff",
					min: 0,
					defaultValue: DEFAULT_SETTINGS.scrolloff,
				},
			},
			{
				name: "Select word under cursor (Mod-D)",
				desc: "Mod-D selects the word under the cursor (viw); press it again to add a cursor at the next match. Disable Obsidian's own Mod-D hotkey first.",
				control: {
					type: "toggle",
					key: "modD",
					defaultValue: DEFAULT_SETTINGS.modD,
				},
			},
			{
				name: "Use gj/gk for j/k",
				desc: "Install native Vim normal-mode mappings j to gj and k to gk, the same way vimrc-support does. Counts and pending prefixes stay with Vim. Inside Markdown tables the display-line motion keeps the cell column and skips the separator row.",
				control: {
					type: "toggle",
					key: "jkAsGjGk",
					defaultValue: DEFAULT_SETTINGS.jkAsGjGk,
				},
			},
			{
				name: "Table navigation",
				desc: "In a native Live Preview table cell, use h/j/k/l to move between cells, i/a/c/s or Enter to edit the cell, and Escape to return to cell navigation. Tab moves to the next cell.",
				control: {
					type: "toggle",
					key: "tableNavigation",
					defaultValue: DEFAULT_SETTINGS.tableNavigation,
				},
			},
			{
				name: "Included Vim enhancements",
				desc: "Also enabled: vim surround (ys, ds, cs, visual S), per-cursor motions with multiple cursors (h/j/k/l/w/W/b/B/e/E/$, ^), Mod-Alt-Up/Down vertical cursors, gd/gx link actions, and list-aware o.",
				searchable: false,
			},
		];

		const explorerItems: SettingDefinition[] = [
			{
				name: "File explorer key reference",
				desc: "While the file explorer is focused: j/k move · h/l collapse or expand · Enter opens a file, opens the folder note, expands, or toggles a folder (see the two Enter settings above); Ctrl/Cmd+Enter or Shift+Enter always opens the folder note · gg/G first or last · z collapse all · a/A new file or folder · d delete · r rename · m move · c copy to path · x/y cut/copy · p paste · u undo · s/S/t split or tab · q close · Esc back to the editor.",
				searchable: false,
			},
		];

		const leaderItems: SettingDefinition[] = [
			{
				name: "About leader keys",
				desc: "Press the leader key, then a sequence. A which-key popup lists what can follow. Leader bindings work in Reading mode, in the editor's Vim normal mode, and while the file explorer is focused; with Activate on leader key they also work in any pane where you are not typing. They never interfere with typing in insert or visual mode, or a Web viewer page.",
				searchable: false,
			},
			{
				name: "Leader key",
				desc: "One key, in Vim notation: <Space>, <C-Space>, or a plain character. Pressing it starts a sequence.",
				control: {
					type: "text",
					key: "leaderKey",
					defaultValue: DEFAULT_SETTINGS.leaderKey,
					validate: (value) =>
						normalizeLeaderKey(value) === null
							? "The leader key must be exactly one key."
							: undefined,
				},
			},
			{
				name: "Activate on leader key",
				desc: "Start the leader sequence from any pane where you are not typing, not just Reading mode and the file explorer. Web viewer, Canvas, and the bookmarks, outline, and tag sidebars are left alone. Markdown only restricts this to Markdown views. Disabled keeps the leader to the usual panes.",
				control: {
					type: "dropdown",
					key: "activateOnLeaderKey",
					options: {
						disabled: "Disabled",
						enabled: "Enabled",
						markdown_only: "Markdown only",
					},
					defaultValue: DEFAULT_SETTINGS.activateOnLeaderKey,
				},
			},
			{
				name: "Show which-key popup",
				desc: "List the keys that can follow the current prefix while a leader sequence is pending.",
				control: {
					type: "toggle",
					key: "whichKey",
					defaultValue: DEFAULT_SETTINGS.whichKey,
				},
			},
			{
				name: "Which-key delay",
				desc: "Milliseconds to wait before showing the popup. 0 shows it immediately.",
				control: {
					type: "slider",
					key: "whichKeyDelay",
					min: 0,
					max: 1000,
					step: 50,
					defaultValue: DEFAULT_SETTINGS.whichKeyDelay,
				},
			},
			{
				name: "Pending sequence timeout",
				desc: "Milliseconds before an unfinished leader sequence is cancelled. 0 keeps it open until Esc.",
				control: {
					type: "slider",
					key: "leaderTimeout",
					min: 0,
					max: 5000,
					step: 250,
					defaultValue: DEFAULT_SETTINGS.leaderTimeout,
				},
			},
		];

		const leaderKeyItems: SettingDefinition[] = [
			{
				name: "About leader key entries",
				desc: "Keys typed after the leader. Use Vim notation for special keys: <Space>, <CR>, <Esc>, <BS>, <Tab>, <C-x>. Groups name a prefix so the which-key popup shows it as +name. Bindings run a command from the command palette or open a note by name or vault path. Drag the handle to reorder groups or bindings.",
				searchable: false,
			},
			...s.leaderGroups.map(
				(group, index): SettingDefinition => ({
					name: `Leader group ${index + 1}`,
					desc: `${group.prefix || "no prefix"} — ${group.name || "unnamed"}`,
					render: (setting, groupEl) =>
						this.renderLeaderGroup(setting, index, groupEl.listEl),
				})
			),
			{
				name: "Add group",
				action: () => {
					void this.addLeaderGroup();
				},
			},
			...s.leaderBindings.map(
				(binding, index): SettingDefinition => ({
					name: `Leader binding ${index + 1}`,
					desc: `${binding.keys || "unset"} — ${binding.description || binding.commandName || binding.filePath || "no action"}`,
					render: (setting, groupEl) =>
						this.renderLeaderBinding(setting, index, groupEl.listEl),
				})
			),
			{
				name: "Add binding",
				action: () => {
					void this.addLeaderBinding();
				},
			},
		];

		const bindingItems: SettingDefinition[] = [
			{
				name: "About Reading Mode Bindings",
				desc: "Bind a key — or a sequence like gT — to a command-palette command or a shell command. Active in reading mode. Bindings override the built-in keys (you'll be asked to confirm). For shell commands, {{path}} (active note), {{folder}} (the note's folder), and {{vault}} (vault root) are replaced with quoted absolute paths, and the command runs from the note's folder. Example: kitty --directory {{folder}}",
				searchable: false,
			},
			...s.keyBindings.map(
				(binding, index): SettingDefinition => ({
					name: `Reading Mode Binding ${index + 1}`,
					desc: `${binding.key || "unset"} — ${binding.kind === "terminal" ? binding.terminalCommand || "no command" : binding.commandName || "no command"}`,
					render: (setting, groupEl) =>
						this.renderReadingBinding(setting, index, groupEl.listEl),
				})
			),
			{
				name: "Add new binding",
				action: () => {
					void this.addReadingBinding();
				},
			},
		];

		return [
			...general,
			{ type: "group", heading: "Vim enhancements", items: vimItems },
			{ type: "group", heading: "File explorer keys", items: explorerItems },
			{ type: "group", heading: "Leader", items: leaderItems },
			{ type: "group", heading: "Leader keys", items: leaderKeyItems },
			{
				type: "group",
				heading: "Reading Mode Bindings",
				items: bindingItems,
			},
		];
	}

	/** Re-render from definitions while keeping the settings scroll position. */
	update(): void {
		const scroller =
			this.containerEl?.closest<HTMLElement>(".vertical-tab-content") ??
			this.containerEl;
		const scrollTop = scroller?.scrollTop ?? 0;
		super.update();
		if (scroller) scroller.scrollTop = scrollTop;
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		switch (key) {
			case "hintChars":
				return s.hintChars;
			case "hintFontSize":
				return s.hintFontSize;
			case "scrollStep":
				return s.scrollStep;
			case "forceReadingView":
				return s.forceReadingView;
			case "escapeReturnsToReading":
				return s.escapeReturnsToReading;
			case "enableNativeVim":
				return s.enableNativeVim;
			case "showModeIndicator":
				return s.showModeIndicator;
			case "registerSystemClipboard":
				return s.registerSystemClipboard;
			case "scrolloff":
				return s.scrolloff;
			case "modD":
				return s.modD;
			case "jkAsGjGk":
				return s.jkAsGjGk;
			case "tableNavigation":
				return s.tableNavigation;
			case "enableWebviewIntegration":
				return s.enableWebviewIntegration;
			case "explorerKeys":
				return s.explorerKeys;
			case "enterOpensFolderNote":
				return s.enterOpensFolderNote;
			case "expandFolderOnEnter":
				return s.expandFolderOnEnter;
			case "confirmDelete":
				return s.confirmDelete;
			case "selectors":
				return s.selectors.join("\n");
			case "leaderKey":
				return s.leaderKey;
			case "activateOnLeaderKey":
				return s.activateOnLeaderKey;
			case "whichKey":
				return s.whichKey;
			case "whichKeyDelay":
				return s.whichKeyDelay;
			case "leaderTimeout":
				return s.leaderTimeout;
			default:
				return super.getControlValue(key);
		}
	}

	setControlValue(key: string, value: unknown): void | Promise<void> {
		const s = this.plugin.settings;
		switch (key) {
			case "hintChars": {
				const cleaned = [
					...new Set(String(value).toLowerCase().replace(/[^a-z]/g, "")),
				].join("");
				s.hintChars = cleaned || DEFAULT_SETTINGS.hintChars;
				break;
			}
			case "hintFontSize":
				s.hintFontSize = Number(value);
				break;
			case "scrollStep":
				s.scrollStep = Number(value);
				break;
			case "forceReadingView":
				s.forceReadingView = Boolean(value);
				this.plugin.applyForceReadingView(s.forceReadingView);
				break;
			case "escapeReturnsToReading":
				s.escapeReturnsToReading = Boolean(value);
				break;
			case "enableNativeVim":
				s.enableNativeVim = Boolean(value);
				this.plugin.applyNativeVim(s.enableNativeVim);
				break;
			case "showModeIndicator":
				s.showModeIndicator = Boolean(value);
				this.plugin.refreshModeIndicator();
				break;
			case "registerSystemClipboard":
				s.registerSystemClipboard = Boolean(value);
				break;
			case "scrolloff":
				s.scrolloff = Math.max(0, Number(value) || 0);
				break;
			case "modD":
				s.modD = Boolean(value);
				break;
			case "jkAsGjGk":
				s.jkAsGjGk = Boolean(value);
				break;
			case "tableNavigation":
				s.tableNavigation = Boolean(value);
				break;
			case "enableWebviewIntegration":
				s.enableWebviewIntegration = Boolean(value);
				this.plugin.applyWebviewIntegration(s.enableWebviewIntegration);
				break;
			case "explorerKeys":
				s.explorerKeys = Boolean(value);
				this.plugin.refreshModeIndicator();
				break;
			case "enterOpensFolderNote":
				s.enterOpensFolderNote = Boolean(value);
				break;
			case "expandFolderOnEnter":
				s.expandFolderOnEnter = Boolean(value);
				break;
			case "confirmDelete":
				s.confirmDelete = Boolean(value);
				break;
			case "selectors":
				s.selectors = String(value)
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0);
				break;
			case "leaderKey": {
				const normalized = normalizeLeaderKey(String(value));
				if (normalized === null) return;
				s.leaderKey = normalized;
				break;
			}
			case "activateOnLeaderKey":
				s.activateOnLeaderKey = value as VimiumSettings["activateOnLeaderKey"];
				break;
			case "whichKey":
				s.whichKey = Boolean(value);
				break;
			case "whichKeyDelay":
				s.whichKeyDelay = Number(value);
				break;
			case "leaderTimeout":
				s.leaderTimeout = Number(value);
				break;
			default:
				return super.setControlValue(key, value);
		}
		return this.plugin.saveSettings();
	}

	private async addLeaderGroup(): Promise<void> {
		this.plugin.settings.leaderGroups.push({ prefix: "", name: "" });
		await this.plugin.saveSettings();
		this.update();
	}

	private async addLeaderBinding(): Promise<void> {
		this.plugin.settings.leaderBindings.push({
			keys: "",
			description: "",
			kind: "command",
			commandId: "",
			commandName: "",
			filePath: "",
		});
		await this.plugin.saveSettings();
		this.update();
	}

	private async addReadingBinding(): Promise<void> {
		this.plugin.settings.keyBindings.push({
			key: "",
			kind: "command",
			commandId: "",
			commandName: "",
			terminalCommand: "",
		});
		await this.plugin.saveSettings();
		this.update();
	}

	private renderLeaderGroup(
		setting: Setting,
		index: number,
		containerEl: HTMLElement
	): void {
		const group = this.plugin.settings.leaderGroups[index];
		setting.settingEl.addClass("vimium-leader-group-row");
		this.attachRowDrag(setting, "group", index, containerEl);

		setting.addText((text) => {
			text.setPlaceholder("Prefix").setValue(group.prefix);
			text.inputEl.addClass("vimium-keybinding-key");
			void text.onChange(async (value) => {
				group.prefix = value.trim();
				await this.plugin.saveSettings();
			});
		});

		setting.addText((text) => {
			text.setPlaceholder("Group name").setValue(group.name);
			text.inputEl.addClass("vimium-leader-group-name");
			void text.onChange(async (value) => {
				group.name = value.trim();
				await this.plugin.saveSettings();
			});
		});

		setting.addExtraButton((button) => {
			button
				.setIcon("trash")
				.setTooltip("Remove group")
				.onClick(() => {
					void this.removeLeaderGroup(index);
				});
		});
	}

	private async removeLeaderGroup(index: number): Promise<void> {
		this.plugin.settings.leaderGroups.splice(index, 1);
		await this.plugin.saveSettings();
		this.update();
	}

	private renderLeaderBinding(
		setting: Setting,
		index: number,
		containerEl: HTMLElement
	): void {
		const binding = this.plugin.settings.leaderBindings[index];
		setting.settingEl.addClass("vimium-leader-row");
		this.attachRowDrag(setting, "leaderBinding", index, containerEl);

		setting.addText((text) => {
			text.setPlaceholder("Key(s)").setValue(binding.keys);
			text.inputEl.addClass("vimium-keybinding-key");
			void text.onChange(async (value) => {
				binding.keys = value.trim();
				await this.plugin.saveSettings();
			});
		});

		setting.addText((text) => {
			text.setPlaceholder("Description").setValue(binding.description);
			text.inputEl.addClass("vimium-leader-desc");
			void text.onChange(async (value) => {
				binding.description = value;
				await this.plugin.saveSettings();
			});
		});

		setting.addDropdown((dropdown) => {
			dropdown.addOption("command", "Command");
			dropdown.addOption("file", "File");
			dropdown.setValue(binding.kind);
			void dropdown.onChange(async (value) => {
				binding.kind = value === "file" ? "file" : "command";
				await this.plugin.saveSettings();
				this.update();
			});
		});

		if (binding.kind === "file") {
			setting.addText((text) => {
				text.setPlaceholder("Note name or path").setValue(binding.filePath);
				text.inputEl.addClass("vimium-leader-file");
				void text.onChange(async (value) => {
					binding.filePath = value.trim();
					await this.plugin.saveSettings();
				});
			});
		} else {
			setting.addButton((button) => {
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

		setting.addExtraButton((button) => {
			button
				.setIcon("trash")
				.setTooltip("Remove binding")
				.onClick(() => {
					void this.removeLeaderBinding(index);
				});
		});
	}

	private async removeLeaderBinding(index: number): Promise<void> {
		this.plugin.settings.leaderBindings.splice(index, 1);
		await this.plugin.saveSettings();
		this.update();
	}

	private renderReadingBinding(
		setting: Setting,
		index: number,
		containerEl: HTMLElement
	): void {
		const binding = this.plugin.settings.keyBindings[index];
		setting.settingEl.addClass("vimium-keybinding-row");
		this.attachRowDrag(setting, "binding", index, containerEl);

		setting.addText((text) => {
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

		setting.addDropdown((dropdown) => {
			dropdown.addOption("command", "Command");
			dropdown.addOption("terminal", "Terminal");
			dropdown.setValue(binding.kind);
			dropdown.selectEl.addClass("vimium-binding-kind");
			void dropdown.onChange(async (value) => {
				binding.kind = value === "terminal" ? "terminal" : "command";
				await this.plugin.saveSettings();
				this.update();
			});
		});

		if (binding.kind === "terminal") {
			setting.addText((text) => {
				text.setPlaceholder("Shell command…").setValue(binding.terminalCommand);
				text.inputEl.addClass("vimium-terminal-command");
				void text.onChange(async (value) => {
					binding.terminalCommand = value.trim();
					await this.plugin.saveSettings();
				});
			});
		} else {
			setting.addButton((button) => {
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

		setting.addExtraButton((button) => {
			button
				.setIcon("trash")
				.setTooltip("Remove binding")
				.onClick(() => {
					void this.removeReadingBinding(index);
				});
		});
	}

	private async removeReadingBinding(index: number): Promise<void> {
		this.plugin.settings.keyBindings.splice(index, 1);
		await this.plugin.saveSettings();
		this.update();
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
		this.update();
	}

	/** Move one item and report whether the list changed. */
	private reorderItems<T>(list: T[], from: number, to: number): boolean {
		if (from === to || from < 0 || from >= list.length) return false;
		const [item] = list.splice(from, 1);
		list.splice(Math.max(0, Math.min(to, list.length)), 0, item);
		return true;
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
