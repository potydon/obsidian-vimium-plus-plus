import { MarkdownView, Notice, Plugin, View } from "obsidian";
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
import { Leader } from "./leader/leader";
import { VimExtras } from "./more-vim";

export default class VimiumPlugin extends Plugin {
	settings!: VimiumSettings;

	private modeManager!: ModeManager;
	private explorer!: Explorer;
	private hintEngine!: HintEngine;
	private scroller!: Scroller;
	private webviewBridge!: WebviewBridge;
	private leader!: Leader;
	private vimExtras!: VimExtras;

	private indicatorEl: HTMLElement | null = null;
	private pendingEl: HTMLElement | null = null;
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
		this.syncTableBlankClass();

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

		this.pendingEl = this.addStatusBarItem();
		this.pendingEl.addClass("vimium-pending-keys");
		this.leader = new Leader(this.app, () => this.settings, this.pendingEl);
		this.leader.rebuild();
		this.vimExtras = new VimExtras(this.app, this);

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
				this.leader?.reset();
				this.vimExtras?.reset();
				this.vimExtras?.init();
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
				this.leader?.reset();
				this.vimExtras?.reset();
				this.vimExtras?.init();
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
			this.vimExtras.init();
			this.watchVimMode();
			this.webviewBridge.ensureAll();
			this.syncExplorerKeys();
			this.refreshModeIndicator();
		});
	}

	onunload(): void {
		document.body.classList.remove("vimium-collapse-table-blank");
		activeDocument.body.classList.remove("vimium-collapse-table-blank");
		this.webviewBridge?.destroy();
		this.hintEngine?.hide();
		this.leader?.destroy();
		this.vimExtras?.uninstall();
		this.explorer?.restoreNativeKeys();
		this.pendingEl?.remove();
		this.pendingEl = null;
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
		const data = (await this.loadData()) as
			| (Partial<VimiumSettings> & {
					/** Older versions kept shell commands in their own list. */
					terminalCommands?: { key?: string; command?: string }[];
			  })
			| null;
		const settings: VimiumSettings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Normalize stored bindings and fold the old terminal list into the one
		// reading-mode list, so both kinds share a single ordered array.
		settings.keyBindings = (settings.keyBindings ?? []).map((binding) => ({
			key: binding.key ?? "",
			kind: binding.kind === "terminal" ? "terminal" : "command",
			commandId: binding.commandId ?? "",
			commandName: binding.commandName ?? "",
			terminalCommand: binding.terminalCommand ?? "",
		}));
		for (const cmd of data?.terminalCommands ?? []) {
			if (!cmd?.key && !cmd?.command) continue;
			settings.keyBindings.push({
				key: cmd.key ?? "",
				kind: "terminal",
				commandId: "",
				commandName: "",
				terminalCommand: cmd.command ?? "",
			});
		}
		// Drop the legacy key so it is not saved (and migrated) again.
		delete (settings as VimiumSettings & { terminalCommands?: unknown })
			.terminalCommands;
		this.settings = settings;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Keep live webview guests in sync with hint/scroll settings.
		this.webviewBridge?.reinjectAll();
		this.syncTableBlankClass();
		this.syncExplorerKeys();
		this.leader?.rebuild();
		this.vimExtras?.syncSettings();
		this.clearPending();
	}

	/** Toggle the CSS class that collapses a table's mandatory blank source line. */
	syncTableBlankClass(): void {
		const enabled = this.settings.collapseTableLeadingBlank;
		document.body.classList.toggle("vimium-collapse-table-blank", enabled);
		if (activeDocument !== document) {
			activeDocument.body.classList.toggle(
				"vimium-collapse-table-blank",
				enabled
			);
		}
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
		this.leader?.reset();
		this.vimMode = "normal";
		void this.modeManager.enterEditing();
	}

	private exitToReading(): void {
		this.leader?.reset();
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
		if (isOverlayOpen()) {
			this.leader.reset();
			return;
		}

		// While a leader sequence is pending every key belongs to it, so <Esc>
		// can cancel and <BS> can step back out of a group. Focus moving into a
		// text field ends the sequence so typing is never swallowed.
		if (this.leader.active) {
			// The editor is contentEditable, but in Vim normal mode the leader
			// owns the sequence there too. Any other text field ends it.
			if (isEditableTarget() && !this.editorAcceptsLeader(e.target)) {
				this.leader.reset();
				return;
			}
			if (this.leader.handleKey(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
			return;
		}

		// Spacekeys-style activation: when enabled, the leader key starts a
		// sequence from any pane where the user is not typing, not just the
		// Reading/explorer/editor contexts handled below.
		if (
			this.settings.activateOnLeaderKey !== "disabled" &&
			this.leaderExplorerAllowed() &&
			this.startLeader(e, true)
		) {
			return;
		}

		// The file explorer has its own neo-tree-style key set. This must run
		// before the editing guard: clicking the explorer while a note was in
		// editing mode leaves modeManager.mode as "editing".
		if (this.settings.explorerKeys && this.explorer.isActive()) {
			if (isEditableTarget()) return;
			if (this.leaderExplorerAllowed() && this.startLeader(e)) return;
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
			const fromEditor = this.isEditorTarget(e.target);
			// The leader works in the editor too, but only in Vim normal mode
			// with no command in progress, so it can't steal a count, operator,
			// motion, or f/t key from Vim.
			if (fromEditor && this.editorAcceptsLeader(e.target) && this.startLeader(e)) {
				return;
			}
			if (this.vimExtras.handleKeyDown(e, fromEditor)) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			// Escape only exits to Reading from the editor text itself. A modal
			// that closed on this same Escape (command palette, Omnisearch) has
			// already removed its container by now, so an overlay check alone
			// would misread it as an editor Escape. Let Vim cancel an in-progress
			// count/operator instead of exiting.
			if (e.key === "Escape" && !hasModifier(e) && fromEditor) {
				const vimBusy =
					this.activeEditorVim()?.state?.vim != null &&
					!this.editorAcceptsLeader(e.target);
				if (!vimBusy && this.modeManager.handleEditingEscape(this.vimMode)) {
					this.vimMode = "normal";
					e.preventDefault();
					e.stopPropagation();
				}
			}
			return;
		}

		// --- reading mode ---
		if (isEditableTarget()) return;
		// This branch is also the fallback for every non-editor pane. Without
		// broad activation, keep the leader to Markdown views (and the explorer,
		// which normally returns above) instead of every pane.
		if (
			(this.settings.activateOnLeaderKey === "enabled" ||
				(this.leaderExplorerAllowed() && this.explorer.isActive()) ||
				this.app.workspace.getActiveViewOfType(MarkdownView) != null) &&
			this.startLeader(e)
		) {
			return;
		}
		// Leave OS/Obsidian shortcuts (Ctrl/Cmd/Alt) untouched. Shift is ours.
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		if (this.handleReadingKey(e)) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	/** Whether the file explorer may start a leader sequence. */
	private leaderExplorerAllowed(): boolean {
		return !this.settings.leaderIgnoreExplorer || !this.explorer.isActive();
	}

	/**
	 * Try to begin a leader sequence. Checked before the modifier filter so
	 * sequences like <C-Space> work, and before the chord buffer so a pending
	 * chord (e.g. `g` waiting for `gg`) cannot swallow the leader key.
	 *
	 * `broad` marks the Spacekeys-style activation pass, which applies the
	 * "Activate on leader key" restriction. The usual Reading/explorer/editor
	 * call sites keep working regardless of that setting.
	 */
	private startLeader(e: KeyboardEvent, broad = false): boolean {
		if (broad && !this.leaderActivationAllowed(e)) return false;
		// Spacekeys leaves these panes alone: Canvas uses Space to pan, a Web
		// viewer page keeps its own keyboard, and the sidebars bind Space to
		// their own actions.
		if (this.leaderBlockedView()) return false;
		if (!this.leader.handleKey(e)) return false;
		this.vimExtras?.reset();
		this.clearPending();
		e.preventDefault();
		e.stopPropagation();
		return true;
	}

	/** View types where the leader must never start. */
	private leaderBlockedView(): boolean {
		const viewType =
			this.app.workspace.getActiveViewOfType(View)?.getViewType() ?? "";
		return (
			viewType === "webviewer" ||
			viewType === "canvas" ||
			LEADER_BLOCKED_VIEW_TYPES.has(viewType)
		);
	}

	/**
	 * Whether the broad leader activation pass may start a sequence from the
	 * current focus. Mirrors Spacekeys' "Activate on space": allow any pane
	 * where the user is not typing, and with "Markdown only" require a
	 * Markdown view. Blocked view types are handled by startLeader.
	 */
	private leaderActivationAllowed(e: KeyboardEvent): boolean {
		const mode = this.settings.activateOnLeaderKey;
		if (mode === "disabled") return false;

		// The editor body is contentEditable, so handle it before the generic
		// text-field check: Vim normal mode is allowed, insert/visual are not.
		if (this.isEditorTarget(e.target)) {
			return this.editorAcceptsLeader(e.target);
		}

		if (
			mode === "markdown_only" &&
			this.app.workspace.getActiveViewOfType(MarkdownView) == null
		) {
			return false;
		}

		return !isEditableTarget();
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
		const targets: { seq: string; run: () => void }[] = [];
		for (const binding of this.settings.keyBindings) {
			if (!binding.key) continue;
			if (binding.kind === "terminal") {
				if (!binding.terminalCommand) continue;
				const command = binding.terminalCommand;
				targets.push({
					seq: binding.key,
					run: () => runTerminalCommand(this.app, command),
				});
			} else {
				if (!binding.commandId) continue;
				const commandId = binding.commandId;
				targets.push({
					seq: binding.key,
					run: () => void this.app.commands.executeCommandById(commandId),
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
		const tableMode = editing ? this.vimExtras?.tableNav.modeLabel() : null;
		if (tableMode) {
			this.indicatorEl.setText(tableMode);
			this.indicatorEl.toggleClass("mod-normal", true);
			this.indicatorEl.toggleClass("mod-insert", false);
			return;
		}
		const insert = editing && this.vimMode === "insert";
		this.indicatorEl.setText(
			editing ? VIM_MODE_LABELS[this.vimMode] ?? "NORMAL" : "READING"
		);
		this.indicatorEl.toggleClass("mod-normal", editing && !insert);
		this.indicatorEl.toggleClass("mod-insert", insert);
	}

	/** Subscribe to the active editor's vim adapter so the indicator can reflect insert mode. */
	private watchVimMode(): void {
		const cm = this.activeEditorVim();
		if (!cm?.on || this.vimBoundCms.has(cm)) return;
		this.vimBoundCms.add(cm);
		cm.on("vim-mode-change", this.onVimModeChange);
	}

	/** The active markdown editor's vim adapter, if Obsidian's vim mode is loaded. */
	private activeEditorVim(): VimAwareCm | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cm = (
			view as unknown as {
				editMode?: { editor?: { cm?: { cm?: VimAwareCm } } };
			} | null
		)?.editMode?.editor?.cm?.cm;
		return cm ?? null;
	}

	/**
	 * Whether a key event came from the active note's editor text. Modals,
	 * sidebars, the inline title, and properties are all outside it, even when
	 * the event was dispatched just as a modal closed.
	 */
	private isEditorTarget(target: EventTarget | null): boolean {
		if (target == null) return false;
		const content = this.app.workspace
			.getActiveViewOfType(MarkdownView)
			?.contentEl.querySelector(".cm-content");
		return content != null && content.contains(target as Node);
	}

	/**
	 * Whether a key event came from the active editor's text in Vim normal mode
	 * with no command in progress. Mirrors Vimakase: a count, operator, motion,
	 * or f/t key buffer belongs to Vim, so the leader must leave those alone.
	 */
	private editorAcceptsLeader(target: EventTarget | null): boolean {
		if (!this.isEditorTarget(target)) return false;
		if (this.vimExtras?.tableNav.ownsCellKeyboard()) return false;

		const vim = this.activeEditorVim()?.state?.vim;
		if (vim == null) return false;
		const input = vim.inputState;
		return (
			vim.insertMode !== true &&
			vim.visualMode !== true &&
			input?.operator == null &&
			input?.motion == null &&
			(input?.keyBuffer?.length ?? 0) === 0
		);
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
	/** Vim's own state; absent until Obsidian's vim mode has loaded. */
	state?: { vim?: VimState };
}

interface VimInputState {
	keyBuffer?: string[];
	operator?: string | null;
	motion?: string | null;
}

interface VimState {
	insertMode?: boolean;
	visualMode?: boolean;
	inputState?: VimInputState;
}

/** Panes that bind Space to their own action; the broad leader pass leaves them alone. */
const LEADER_BLOCKED_VIEW_TYPES = new Set(["bookmarks", "outline", "tag"]);

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
