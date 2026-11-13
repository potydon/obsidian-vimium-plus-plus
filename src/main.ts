import { MarkdownView, Notice, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VimiumSettings,
	VimiumSettingTab,
} from "./settings";
import { ModeManager } from "./mode";
import { Explorer } from "./explorer";
import { HintEngine } from "./hints/hint-engine";
import { Scroller } from "./scroll";
import { WebviewBridge } from "./webview";
import {
	OmniOpenModal,
	collectBookmarkItems,
	collectRecentFileItems,
} from "./omnibar";
import { runTerminalCommand } from "./exec";

export default class VimiumPlugin extends Plugin {
	settings!: VimiumSettings;

	private modeManager!: ModeManager;
	private explorer!: Explorer;
	private hintEngine!: HintEngine;
	private scroller!: Scroller;
	private webviewBridge!: WebviewBridge;

	private indicatorEl: HTMLElement | null = null;
	// The native Vim layer's current mode: "normal", "insert", "visual",
	// "replace", etc. Escape is only ours to consume in normal mode.
	private vimMode = "normal";
	// Editors whose vim adapter we subscribed to, so we can unsubscribe on unload.
	private vimBoundCms = new Set<VimAwareCm>();
	// Keys buffered while they are still a prefix of some key sequence.
	private pendingKeys = "";
	private pendingTimer: number | null = null;

	// Editor config we override and must restore on unload. Tracked with
	// explicit "did we change it" flags: the previous value may legitimately be
	// undefined (config key never set), so it can't double as the flag.
	private vimModeChanged = false;
	private prevVimMode: unknown = false;
	private viewModeChanged = false;
	private prevDefaultViewMode: unknown = "source";

	async onload(): Promise<void> {
		await this.loadSettings();

		this.modeManager = new ModeManager(this.app, this.settings, () =>
			this.refreshModeIndicator()
		);
		this.hintEngine = new HintEngine(this.app, this.settings, () =>
			this.refreshModeIndicator()
		);
		this.explorer = new Explorer(this.app, this.settings);
		this.scroller = new Scroller(this.app);
		this.webviewBridge = new WebviewBridge(
			this.app,
			() => this.settings,
			() => this.refreshModeIndicator()
		);

		this.applyEditorConfig();

		this.addSettingTab(new VimiumSettingTab(this.app, this));

		// Capture-phase so we intercept before CodeMirror / Obsidian handlers.
		// Bound per window so pop-out windows work too.
		this.bindWindow(activeDocument);
		this.registerEvent(
			this.app.workspace.on("window-open", (win) => this.bindWindow(win.doc))
		);

		// Keep newly-activated notes in Reading view while in reading mode.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.watchVimMode();
				this.webviewBridge.ensureAll();
				this.syncExplorerKeys();
				// syncFromView no-ops on non-markdown views, so webview leaves
				// need the indicator refreshed here.
				this.refreshModeIndicator();
				void this.modeManager
					.forceReading(leaf)
					.then(() => this.modeManager.syncFromView());
			})
		);
		// External view-mode toggles (pencil icon, Ctrl+E) must not leave the
		// mode state stale.
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.watchVimMode();
				this.webviewBridge.ensureAll();
				this.syncExplorerKeys();
				this.modeManager.syncFromView();
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				void this.modeManager.forceReading(
					this.app.workspace.getMostRecentLeaf()
				);
			})
		);

		this.registerCommands();

		this.app.workspace.onLayoutReady(() => {
			this.watchVimMode();
			this.webviewBridge.ensureAll();
			this.syncExplorerKeys();
			this.refreshModeIndicator();
		});
	}

	onunload(): void {
		this.webviewBridge?.destroy();
		this.hintEngine?.hide();
		this.explorer?.restoreNativeKeys();
		this.indicatorEl?.remove();
		this.indicatorEl = null;
		for (const cm of this.vimBoundCms) {
			cm.off("vim-mode-change", this.onVimModeChange);
		}
		this.vimBoundCms.clear();
		this.clearPending();
		this.restoreEditorConfig();
	}

	// ---- settings -----------------------------------------------------------

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<VimiumSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Keep live webview guests in sync with hint/scroll settings.
		this.webviewBridge?.reinjectAll();
		this.syncExplorerKeys();
		this.clearPending();
	}

	/** Remove or restore the explorer's own Enter handler as the setting changes. */
	private syncExplorerKeys(): void {
		this.explorer?.syncNativeKeys({
			space: false,
			enter: this.settings.explorerKeys,
		});
	}

	private applyEditorConfig(): void {
		if (this.settings.enableNativeVim) this.applyNativeVim(true);
		if (this.settings.forceReadingView) this.applyForceReadingView(true);
	}

	private restoreEditorConfig(): void {
		this.applyNativeVim(false);
		this.applyForceReadingView(false);
	}

	/** Turn the editor's global Vim setting on, or restore what it was. */
	applyNativeVim(enabled: boolean): void {
		const vault = this.app.vault;
		if (enabled) {
			if (this.vimModeChanged) return;
			this.prevVimMode = vault.getConfig("vimMode") ?? false;
			this.vimModeChanged = true;
			vault.setConfig("vimMode", true);
		} else if (this.vimModeChanged) {
			this.vimModeChanged = false;
			vault.setConfig("vimMode", this.prevVimMode);
		}
	}

	/** Set the default view mode to Reading view, or restore what it was. */
	applyForceReadingView(enabled: boolean): void {
		const vault = this.app.vault;
		if (enabled) {
			if (this.viewModeChanged) return;
			this.prevDefaultViewMode =
				vault.getConfig("defaultViewMode") ?? "source";
			this.viewModeChanged = true;
			vault.setConfig("defaultViewMode", "preview");
		} else if (this.viewModeChanged) {
			this.viewModeChanged = false;
			vault.setConfig("defaultViewMode", this.prevDefaultViewMode);
		}
	}

	/** Turn the Web viewer (webview) integration on or off at runtime. */
	applyWebviewIntegration(enabled: boolean): void {
		this.webviewBridge?.setEnabled(enabled);
		this.refreshModeIndicator();
	}

	private bindWindow(doc: Document): void {
		this.registerDomEvent(doc, "keydown", (e) => this.onKeyDown(e), {
			capture: true,
		});
	}

	// ---- commands -----------------------------------------------------------

	private registerCommands(): void {
		this.addCommand({
			id: "show-hints",
			name: "Show click hints",
			callback: () => this.showHints(false),
		});
		this.addCommand({
			id: "show-hints-new-tab",
			name: "Show click hints (open in new tab)",
			callback: () => this.showHints(true),
		});
		this.addCommand({
			id: "enter-editing",
			name: "Enter editing mode",
			callback: () => this.enterEditing(),
		});
		this.addCommand({
			id: "return-to-reading",
			name: "Return to reading mode",
			callback: () => this.exitToReading(),
		});
		this.addCommand({
			id: "toggle-file-explorer",
			name: "Toggle file explorer",
			callback: () => this.explorer.toggle(),
		});

		// Vim-style `:w` / `:q`: open the command palette with `:` and type
		// `w` or `q`. Registered on the internal command registry rather than
		// with `this.addCommand`, which would prefix the plugin name and push
		// the leading letter too far down the palette's fuzzy ranking.
		this.registerPaletteCommand("save-note", "w: Save note", "save", () =>
			void this.saveActiveNote()
		);
		this.registerPaletteCommand(
			"close-tab",
			"q: Close current tab",
			"x",
			() => this.app.commands.executeCommandById("workspace:close")
		);
	}

	/** Registers a palette command without the plugin-name prefix, and removes it on unload. */
	private registerPaletteCommand(
		id: string,
		name: string,
		icon: string,
		callback: () => void
	): void {
		const fullId = `${this.manifest.id}:${id}`;
		this.app.commands.addCommand({ id: fullId, name, icon, callback });
		this.register(() => this.app.commands.removeCommand(fullId));
	}

	/**
	 * Save the active note the same way Ctrl+S does: `MarkdownView.save`
	 * writes only when the view data differs from the last saved version. In
	 * Reading view there is usually nothing pending, so it acts as a no-op
	 * rather than doing something unexpected.
	 */
	private async saveActiveNote(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view == null) {
			new Notice("There is no note open to save.");
			return;
		}
		await view.save();
	}

	/** Enter editing with a clean Vim mode; a fresh editor starts in normal. */
	private enterEditing(): void {
		this.vimMode = "normal";
		void this.modeManager.enterEditing();
	}

	private exitToReading(): void {
		this.vimMode = "normal";
		void this.modeManager.exitToReading();
	}

	// ---- key routing --------------------------------------------------------

	private onKeyDown(e: KeyboardEvent): void {
		// Hint capture takes priority over everything else.
		if (this.hintEngine.active) {
			if (this.hintEngine.handleKey(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}

		// Letters for a guest (webview) hint session started from host focus
		// are relayed into the page, since focus() after a keyboard tab-switch
		// is not reliable.
		if (this.webviewBridge.hintRelayActive) {
			if (this.webviewBridge.relayHintKey(e.key)) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}

		// Obsidian's own overlays (modals, menus, suggestions) take the keyboard;
		// vim keys must not fire behind a delete/rename confirmation.
		if (isOverlayOpen()) return;

		// The file explorer has its own neo-tree-style key set. This must run
		// before the editing guard: clicking the explorer while a note was in
		// editing mode leaves modeManager.mode as "editing".
		if (this.settings.explorerKeys && this.explorer.isActive()) {
			if (isEditableTarget()) return;
			// Ctrl/Cmd+Enter and Shift+Enter always open the focused folder's
			// folder note, even when plain Enter is configured not to.
			if (this.explorer.handleModifiedEnter(e)) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			if (this.handleExplorerKey(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}

		// A webview leaf is never a markdown editor, but the mode state can be
		// stale "editing" there (syncFromView no-ops without a MarkdownView),
		// so the editing branch must not swallow keys on webview leaves.
		const webviewActive = this.webviewBridge.activeWebview() !== null;
		if (!webviewActive && this.modeManager.mode === "editing") {
			if (e.key === "Escape" && !hasModifier(e)) {
				if (this.modeManager.handleEditingEscape(this.vimMode)) {
					this.vimMode = "normal";
					e.preventDefault();
					e.stopPropagation();
				}
			}
			return;
		}

		// --- reading mode ---
		if (isEditableTarget()) return;
		// Leave OS/Obsidian shortcuts (Ctrl/Cmd/Alt) untouched. Shift is ours.
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		if (this.handleReadingKey(e)) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	private handleReadingKey(e: KeyboardEvent): boolean {
		// Pure modifier presses must not pollute the sequence buffer.
		if (e.key === "Shift") return false;
		return this.feedKey(e.key);
	}

	private handleExplorerKey(e: KeyboardEvent): boolean {
		if (e.key === "Shift") return false;
		return this.feedKey(e.key);
	}

	/**
	 * Advance the key-sequence state machine with one key. Custom bindings
	 * (which may be multi-key sequences like "gT") and the built-in `gg` chord
	 * are matched longest-first; while the typed keys are still a prefix of
	 * some sequence they are buffered until the chord timeout resolves the
	 * ambiguity. Custom bindings win over built-ins on an equal match.
	 */
	private feedKey(key: string): boolean {
		const explorer = this.isExplorerContext();
		const hadPending = this.pendingKeys.length > 0;
		const candidate = this.pendingKeys + key;
		const targets = explorer ? this.explorerTargets() : this.sequenceTargets();
		const exact = targets.find((t) => t.seq === candidate);
		const extendable = targets.some(
			(t) => t.seq.length > candidate.length && t.seq.startsWith(candidate)
		);

		if (extendable) {
			this.setPending(candidate, exact, explorer);
			return true;
		}
		this.clearPending();
		if (exact) {
			exact.run();
			return true;
		}
		if (hadPending) {
			// Dead-end chord: drop the buffered prefix, give this key a fresh start.
			return this.feedKey(key);
		}
		return this.runFallbackKey(key, explorer);
	}

	private runFallbackKey(key: string, explorer: boolean): boolean {
		if (explorer && this.runExplorerKey(key)) {
			return true;
		}
		// Reading-mode built-ins still work for keys the explorer doesn't use
		// (f hints, b/O searches, J/K tabs, ...).
		return this.runBuiltinKey(key);
	}

	private isExplorerContext(): boolean {
		return this.settings.explorerKeys && this.explorer.isActive();
	}

	/** Custom command and terminal bindings, usable from any key context. */
	private customTargets(): { seq: string; run: () => void }[] {
		const targets: { seq: string; run: () => void }[] = this.settings.keyBindings
			.filter((b) => b.key.length > 0 && b.commandId)
			.map((b) => ({
				seq: b.key,
				run: () => void this.app.commands.executeCommandById(b.commandId),
			}));
		for (const cmd of this.settings.terminalCommands) {
			if (cmd.key.length > 0 && cmd.command) {
				targets.push({
					seq: cmd.key,
					run: () => runTerminalCommand(this.app, cmd.command),
				});
			}
		}
		return targets;
	}

	/** Reading-mode targets: custom bindings first, then the built-in `gg`. */
	private sequenceTargets(): { seq: string; run: () => void }[] {
		const targets = this.customTargets();
		targets.push({
			seq: "gg",
			run: () => {
				const webview = this.webviewBridge.activeWebview();
				if (webview) this.webviewBridge.run(webview, "top");
				else this.scroller.toTop();
			},
		});
		return targets;
	}

	/** Explorer keys first so custom bindings cannot shadow the focused explorer's actions. */
	private explorerTargets(): { seq: string; run: () => void }[] {
		return [
			...this.explorer.bindings().map((binding) => ({
				seq: binding.keys,
				run: () => void binding.run(),
			})),
			...this.customTargets(),
		];
	}

	private runExplorerKey(key: string): boolean {
		const binding = this.explorer.bindings().find((b) => b.keys === key);
		if (binding == null) {
			return false;
		}
		void binding.run();
		return true;
	}

	private setPending(
		candidate: string,
		exact?: { run: () => void },
		explorer = false
	): void {
		this.clearPending();
		this.pendingKeys = candidate;
		this.pendingTimer = window.setTimeout(() => {
			this.pendingKeys = "";
			this.pendingTimer = null;
			// The sequence was never completed: fall back to what the buffered
			// keys meant on their own (a shorter custom binding, or a built-in).
			if (exact) {
				exact.run();
			} else if (candidate.length === 1) {
				this.runFallbackKey(candidate, explorer);
			}
		}, VimiumPlugin.CHORD_TIMEOUT_MS);
	}

	private clearPending(): void {
		this.pendingKeys = "";
		if (this.pendingTimer !== null) {
			window.clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
	}

	private static readonly CHORD_TIMEOUT_MS = 600;

	private runBuiltinKey(key: string): boolean {
		// On a webview (Web viewer) leaf with host focus, scroll/hint/history
		// keys are forwarded into the guest page; everything else keeps its
		// normal Obsidian behavior.
		const webview = this.webviewBridge.activeWebview();
		switch (key) {
			case "f":
				this.showHints(false);
				return true;
			case "F":
				this.showHints(true);
				return true;
			case "j":
				if (webview) this.webviewBridge.run(webview, "scrollDown");
				else this.scroller.lineDown(this.settings.scrollStep);
				return true;
			case "k":
				if (webview) this.webviewBridge.run(webview, "scrollUp");
				else this.scroller.lineUp(this.settings.scrollStep);
				return true;
			case "J":
				this.app.commands.executeCommandById("workspace:next-tab");
				return true;
			case "K":
				this.app.commands.executeCommandById("workspace:previous-tab");
				return true;
			case "d":
				if (webview) this.webviewBridge.run(webview, "halfDown");
				else this.scroller.halfPageDown();
				return true;
			case "u":
				if (webview) this.webviewBridge.run(webview, "halfUp");
				else this.scroller.halfPageUp();
				return true;
			case "G":
				if (webview) this.webviewBridge.run(webview, "bottom");
				else this.scroller.toBottom();
				return true;
			case "i":
				this.enterEditing();
				return true;
			case "e":
				if (!this.settings.explorerKeys) return false;
				this.explorer.toggle();
				return true;
			case "b":
				this.openBookmarkSearch(false);
				return true;
			case "B":
				this.openBookmarkSearch(true);
				return true;
			case "O":
				this.openOmnibar();
				return true;
			case "/":
				this.app.commands.executeCommandById("editor:open-search");
				return true;
			case "t":
				this.app.commands.executeCommandById("workspace:new-tab");
				return true;
			case "x":
				this.app.commands.executeCommandById("workspace:close");
				return true;
			case "X":
				this.app.commands.executeCommandById("workspace:undo-close-pane");
				return true;
			case "H":
				// Page history on a web tab; Obsidian leaf history elsewhere.
				if (webview) this.webviewBridge.run(webview, "historyBack");
				else this.app.commands.executeCommandById("app:go-back");
				return true;
			case "L":
				if (webview) this.webviewBridge.run(webview, "historyForward");
				else this.app.commands.executeCommandById("app:go-forward");
				return true;
		}

		return false;
	}

	/** Hints on the active surface: the webview guest if present, else the host. */
	private showHints(newTab: boolean): void {
		const webview = this.webviewBridge.activeWebview();
		if (webview) this.webviewBridge.startHints(webview, newTab);
		else this.hintEngine.show(newTab);
	}

	private openBookmarkSearch(newTab: boolean): void {
		new OmniOpenModal(
			this.app,
			collectBookmarkItems(this.app),
			newTab,
			false
		).open();
	}

	/** `O`: bookmarks + recent files + raw URLs, opening in a new tab. */
	private openOmnibar(): void {
		const items = collectBookmarkItems(this.app);
		const seen = new Set(items.map((i) => i.detail));
		for (const item of collectRecentFileItems(this.app)) {
			if (!seen.has(item.detail)) items.push(item);
		}
		new OmniOpenModal(this.app, items, true, true).open();
	}

	// ---- mode indicator -----------------------------------------------------

	refreshModeIndicator(): void {
		if (!this.settings.showModeIndicator) {
			this.indicatorEl?.remove();
			this.indicatorEl = null;
			return;
		}
		if (!this.indicatorEl) {
			this.indicatorEl = this.addStatusBarItem();
			this.indicatorEl.addClass("vimium-mode-indicator");
		}
		if (this.webviewBridge?.activeWebview()) {
			this.indicatorEl.setText("WEB");
			this.indicatorEl.toggleClass("mod-normal", false);
			this.indicatorEl.toggleClass("mod-insert", false);
			return;
		}
		if (this.settings.explorerKeys && this.explorer?.isActive()) {
			this.indicatorEl.setText("EXPLORER");
			this.indicatorEl.toggleClass("mod-normal", false);
			this.indicatorEl.toggleClass("mod-insert", false);
			return;
		}
		const editing = this.modeManager.mode === "editing";
		const insert = editing && this.vimMode === "insert";
		this.indicatorEl.setText(
			editing ? VIM_MODE_LABELS[this.vimMode] ?? "NORMAL" : "READING"
		);
		this.indicatorEl.toggleClass("mod-normal", editing && !insert);
		this.indicatorEl.toggleClass("mod-insert", insert);
	}

	/** Subscribe to the active editor's vim adapter so the indicator can reflect insert mode. */
	private watchVimMode(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cm = (
			view as unknown as {
				editMode?: { editor?: { cm?: { cm?: VimAwareCm } } };
			} | null
		)?.editMode?.editor?.cm?.cm;
		if (!cm?.on || this.vimBoundCms.has(cm)) return;
		this.vimBoundCms.add(cm);
		cm.on("vim-mode-change", this.onVimModeChange);
	}

	private readonly onVimModeChange = (modeObj?: { mode?: string }): void => {
		const mode = modeObj?.mode ?? "normal";
		if (mode === this.vimMode) return;
		this.vimMode = mode;
		this.refreshModeIndicator();
	};
}

/** Human-readable status-pill labels for the Vim modes we distinguish. */
const VIM_MODE_LABELS: Record<string, string> = {
	insert: "INSERT",
	visual: "VISUAL",
	replace: "REPLACE",
};

/** The CM5-flavoured vim adapter Obsidian attaches to markdown editors. */
interface VimAwareCm {
	on(
		event: "vim-mode-change",
		handler: (modeObj?: { mode?: string }) => void
	): void;
	off(
		event: "vim-mode-change",
		handler: (modeObj?: { mode?: string }) => void
	): void;
}

function hasModifier(e: KeyboardEvent): boolean {
	return e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
}

/** Overlays that take over the keyboard, as direct children of <body>. */
const OVERLAY_CLASSES = ["modal-container", "menu", "suggestion-container"];

function isOverlayOpen(): boolean {
	const { children } = activeDocument.body;
	for (let i = 0; i < children.length; i++) {
		const el = children[i];
		if (el != null && OVERLAY_CLASSES.some((cls) => el.classList.contains(cls))) {
			return true;
		}
	}
	return false;
}

/** True when focus is in a text field where our keys must not be hijacked. */
function isEditableTarget(): boolean {
	const el = activeDocument.activeElement as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (el.isContentEditable) return true;
	return false;
}
