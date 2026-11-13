// Neo-tree-style keys for Obsidian's built-in file explorer.
import {
	App,
	MarkdownView,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	View,
	WorkspaceLeaf,
	WorkspaceSidedock,
	normalizePath,
} from "obsidian";
import { runCommand } from "./commands";
import { confirmAction, promptText } from "./prompt";
import type { ConfirmOptions, PromptOptions } from "./prompt";
import type { VimiumSettings } from "./settings";

export const EXPLORER_VIEW_TYPE = "file-explorer";
const UNDO_LIMIT = 50;
/** How much deleted content `u` keeps in memory, per delete and across the whole stack. */
const UNDO_MEMORY_LIMIT = 50 * 1024 * 1024;
/** Limit simultaneous reads when snapshotting folders with many small files. */
const SNAPSHOT_BATCH_SIZE = 8;
/** How long to keep asking the explorer for a just-created item, and how often. */
const REVEAL_INTERVAL = 25;
const REVEAL_ATTEMPTS = 20;
/** Rows of breathing room the virtual scroller keeps around the focused row. */
const EXPLORER_SCROLL_MARGIN = 4;

/** A key sequence for the explorer, using raw KeyboardEvent.key values. */
export interface ExplorerBinding {
	keys: string;
	desc: string;
	run: () => unknown;
}

type Clipboard = { mode: "cut" | "copy"; path: string } | null;

interface ExplorerNodeBase {
	el: HTMLElement;
	parent?: ExplorerFolderNode;
}

interface ExplorerFileNode extends ExplorerNodeBase {
	file: TFile;
}

interface ExplorerFolderNode extends ExplorerNodeBase {
	file: TFolder;
	collapsed: boolean;
	setCollapsed(collapsed: boolean): unknown;
	vChildren: { children: ExplorerNode[] };
}

type ExplorerNode = ExplorerFileNode | ExplorerFolderNode;

interface ExplorerTree {
	root: { vChildren: { children: ExplorerNode[] } };
	focusedItem: ExplorerNode | null;
	isAllCollapsed: boolean;
	setFocusedItem(node: ExplorerNode | null, scroll?: boolean): void;
	setCollapseAll(collapsed: boolean): void;
	/** Obsidian's virtual scroller; scrolling via it is reliable where scrollIntoView is not. */
	infinityScroll?: {
		scrollIntoView(node: ExplorerNode, margin: number): void;
	};
	/** Obsidian Scope holding the tree's own key handlers. */
	scope?: unknown;
}

/** The parts of the Folder Notes plugin's settings that affect explorer rows. */
interface FolderNotesExclusion {
	path?: string;
	subFolders?: boolean;
	showFolderNote?: boolean;
	disableFolderNote?: boolean;
}

interface FolderNotesSettings {
	folderNoteName?: string;
	oldFolderNoteName?: string;
	folderNoteType?: string;
	storageLocation?: "insideFolder" | "parentFolder" | "vaultFolder";
	supportedFileTypes?: string[];
	excludeFolders?: FolderNotesExclusion[];
}

interface FileExplorerView extends View {
	tree: ExplorerTree;
	fileItems: Record<string, ExplorerNode | undefined>;
	revealInFolder(file: TAbstractFile): void;
}

/** A handler registered with Scope.register(); `modifiers` is "" for plain keys. */
interface NativeKeyHandler {
	key: string | null;
	modifiers: string | null;
}

/** The parts of Obsidian's Scope that the public typings don't expose. */
interface NativeScope {
	keys: NativeKeyHandler[];
	register(
		modifiers: string[] | null,
		key: string | null,
		func: (evt: KeyboardEvent) => unknown
	): NativeKeyHandler;
	unregister(handler: NativeKeyHandler): void;
}

interface UndoEntry {
	label: string;
	run: () => Promise<void>;
	/** Bytes of deleted content the entry holds on to; 0 for everything else. */
	bytes: number;
}

interface Snapshot {
	folders: string[];
	files: { path: string; data: ArrayBuffer }[];
	bytes: number;
}

function isFolderNode(node: ExplorerNode): node is ExplorerFolderNode {
	return node.file instanceof TFolder;
}

function parentPath(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx > 0 ? path.slice(0, idx) : "";
}

function joinPath(folder: TFolder, name: string): string {
	return normalizePath(folder.isRoot() ? name : `${folder.path}/${name}`);
}

function notifyError(err: unknown): void {
	new Notice(`Vimium++: ${err instanceof Error ? err.message : String(err)}`);
}

function isNativeScope(scope: unknown): scope is NativeScope {
	return Array.isArray((scope as NativeScope | null | undefined)?.keys);
}

export class Explorer {
	private clipboard: Clipboard = null;
	private undoStack: UndoEntry[] = [];
	private removedNativeKeys: { scope: NativeScope; handler: NativeKeyHandler }[] =
		[];
	private modifiedEnterKeys: { scope: NativeScope; handler: NativeKeyHandler }[] =
		[];

	constructor(
		private readonly app: App,
		private readonly settings: VimiumSettings
	) {}

	isActive(): boolean {
		if (this.hasTreeFocus()) {
			return true;
		}
		if (!this.isActiveView()) {
			return false;
		}
		// The explorer leaf can stay active while Reading view owns the
		// keyboard; don't route keys to the tree in that case.
		const note = this.noteLeaf()?.view.containerEl;
		return note == null || !note.contains(activeDocument.activeElement);
	}

	/** True when the keyboard is inside the explorer tree. */
	private hasTreeFocus(): boolean {
		const container = this.view?.containerEl;
		return (
			container != null && container.contains(activeDocument.activeElement)
		);
	}

	/** True when the explorer leaf itself is the workspace's active leaf. */
	private isActiveView(): boolean {
		return (
			this.app.workspace.getActiveViewOfType(View)?.getViewType() ===
			EXPLORER_VIEW_TYPE
		);
	}

	/** Neo-tree's toggle: open and focus the explorer (revealing the active file), or close it. */
	toggle(): void {
		// Decide from the keyboard's location so a stale active leaf (Reading
		// view can leave the explorer active) doesn't close an open tree.
		if (this.hasTreeFocus()) {
			const close = (): void => this.close();
			close();
			this.refocusAfterOverlay(close);
			return;
		}

		this.focusExplorer();
		this.refocusAfterOverlay(() => this.focusExplorerLeaf());
	}

	/**
	 * Obsidian's command palette can still be tearing down when a command runs,
	 * and its teardown can reclaim the keyboard. Wait for any visible modal to
	 * go, then apply the focus (and once on the next tick).
	 */
	private refocusAfterOverlay(focus: () => void): void {
		let polls = 0;
		const attempt = (): void => {
			const modal = activeDocument.body.querySelector<HTMLElement>(
				".modal-container"
			);
			if (
				modal != null &&
				modal.getClientRects().length > 0 &&
				polls++ < 40
			) {
				window.setTimeout(attempt, 25);
				return;
			}

			focus();
			window.setTimeout(focus, 0);
		};
		window.setTimeout(attempt, 0);
	}

	/**
	 * Ctrl/Cmd+Enter and Shift+Enter always open the focused folder's folder
	 * note. Returns false when there is nothing to open so normal Enter
	 * handling can continue.
	 */
	handleModifiedEnter(e: KeyboardEvent): boolean {
		if (e.key !== "Enter") {
			return false;
		}
		if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
			return false;
		}

		const node = this.focused();
		if (node == null || !isFolderNode(node)) {
			return false;
		}

		const note = this.folderNote(node);
		if (note == null) {
			return false;
		}

		if (this.settings.expandFolderOnEnter) {
			node.setCollapsed(false);
		}
		void this.openFile(note).catch(notifyError);
		return true;
	}

	private focusExplorer(): void {
		const reveal = this.app.workspace.getActiveFile() != null;
		runCommand(
			this.app,
			reveal ? "file-explorer:reveal-active-file" : "file-explorer:open"
		);
		// The command reveals the file but does not necessarily move keyboard
		// focus, so make the explorer leaf active ourselves.
		this.focusExplorerLeaf();
	}

	private focusExplorerLeaf(): void {
		const leaf = this.app.workspace.getLeavesOfType(EXPLORER_VIEW_TYPE)[0];
		if (leaf == null) {
			return;
		}
		const root = leaf.getRoot();
		if (root instanceof WorkspaceSidedock && root.collapsed) {
			root.expand();
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		void this.app.workspace.revealLeaf(leaf);
		this.focusExplorerTree(leaf);
	}

	/**
	 * `setActiveLeaf` makes the explorer the active view but can leave DOM focus
	 * in the editor, which makes our key handler treat the target as editable.
	 * Move focus onto the tree row (or the tree itself) explicitly.
	 */
	private focusExplorerTree(leaf: WorkspaceLeaf): void {
		const view = leaf.view as Partial<FileExplorerView>;
		const container = view.containerEl;
		if (container == null) {
			return;
		}

		const row = this.view?.tree.focusedItem?.el;
		const rowEl =
			row?.isConnected && row.getClientRects().length > 0
				? row.querySelector<HTMLElement>(".tree-item-self")
				: null;
		const target =
			rowEl ??
			container.querySelector<HTMLElement>(".nav-files-container") ??
			container;
		if (!target.hasAttribute("tabindex")) {
			target.setAttribute("tabindex", "-1");
		}
		target.focus({ preventScroll: true });
	}

	/**
	 * Obsidian's explorer opens the focused item on Enter, and its key scope runs
	 * before any plugin keydown listener. Remove that so Enter isn't handled
	 * twice while explorer keys are active. Safe to call repeatedly; restores first.
	 */
	syncNativeKeys(remove: { space: boolean; enter: boolean }): void {
		this.restoreNativeKeys();

		const view = this.view;
		if (view == null) {
			return;
		}

		const scopes = [
			...new Set([view.scope, view.tree.scope].filter(isNativeScope)),
		];
		for (const scope of scopes) {
			for (const handler of [...scope.keys]) {
				const plain = (handler.modifiers ?? "") === "";
				if (
					(remove.space && plain && handler.key === " ") ||
					(remove.enter && handler.key === "Enter")
				) {
					scope.unregister(handler);
					this.removedNativeKeys.push({ scope, handler });
				}
			}
		}

		// Obsidian's global hotkeys run at the window level, before our
		// document listener, so Ctrl/Cmd+Enter is consumed by "Open link under
		// cursor in new tab" before we ever see it. Register on the explorer's
		// own scope instead: scopes are consulted before the global hotkeys,
		// and returning false stops the event there.
		if (remove.enter) {
			for (const scope of scopes) {
				for (const modifiers of [["Mod"], ["Shift"]]) {
					const handler = scope.register(modifiers, "Enter", (evt) =>
						this.handleScopeEnter(evt)
					);
					this.modifiedEnterKeys.push({ scope, handler });
				}
			}
		}
	}

	private handleScopeEnter(evt: KeyboardEvent): boolean {
		if (!this.settings.explorerKeys || !this.isActive()) {
			return true;
		}
		this.handleModifiedEnter(evt);
		// Swallow the event so the global "open link in new tab" hotkey does
		// not fire while the explorer has focus.
		return false;
	}

	restoreNativeKeys(): void {
		for (const { scope, handler } of this.modifiedEnterKeys) {
			scope.unregister(handler);
		}
		this.modifiedEnterKeys = [];

		for (const { scope, handler } of this.removedNativeKeys) {
			if (!scope.keys.includes(handler)) {
				scope.keys.push(handler);
			}
		}
		this.removedNativeKeys = [];
	}

	bindings(): ExplorerBinding[] {
		const bind = (
			keys: string,
			desc: string,
			run: () => unknown
		): ExplorerBinding => ({
			keys,
			desc,
			run: () => Promise.resolve(run()).catch(notifyError),
		});

		return [
			bind("j", "Move down", () => this.moveDown()),
			bind("k", "Move up", () => this.moveUp()),
			bind("h", "Close folder / go to parent", () => this.moveLeft()),
			bind("l", "Open file / expand folder", () => this.open(false)),
			bind("Enter", "Open file / folder note / toggle folder", () =>
				this.open(true)
			),
			bind("gg", "First item", () => this.focusEdge("first")),
			bind("G", "Last item", () => this.focusEdge("last")),
			bind("z", "Collapse all folders", () => this.collapseAll()),
			bind("a", "Add file (end with / for a folder)", () => this.add(false)),
			bind("A", "Add folder", () => this.add(true)),
			bind("d", "Delete", () => this.delete()),
			bind("r", "Rename", () => this.rename()),
			bind("m", "Move", () => this.move()),
			bind("c", "Copy to path", () => this.copyTo()),
			bind("x", "Cut", () => this.setClipboard("cut")),
			bind("y", "Copy", () => this.setClipboard("copy")),
			bind("p", "Paste", () => this.paste()),
			bind("u", "Undo last file operation", () => this.undo()),
			bind("s", "Open in vertical split", () => this.openIn("vertical")),
			bind("S", "Open in horizontal split", () =>
				this.openIn("horizontal")
			),
			bind("t", "Open in new tab", () => this.openIn("tab")),
			bind("q", "Close explorer", () => this.close()),
			bind("Escape", "Back to editor", () => this.focusEditor()),
		];
	}

	/** The loaded explorer view; null while Obsidian still has it as a deferred placeholder. */
	private get view(): FileExplorerView | null {
		const view = this.app.workspace.getLeavesOfType(EXPLORER_VIEW_TYPE)[0]
			?.view as Partial<FileExplorerView> | undefined;
		return view?.tree != null ? (view as FileExplorerView) : null;
	}

	private focused(): ExplorerNode | null {
		return this.view?.tree.focusedItem ?? null;
	}

	/** Target folder for new items and paste: the focused folder, or the focused file's folder. */
	private targetFolder(): TFolder {
		const node = this.focused();
		if (node == null) {
			return this.app.vault.getRoot();
		}
		return isFolderNode(node)
			? node.file
			: (node.file.parent ?? this.app.vault.getRoot());
	}

	/**
	 * Every tree node in display order, including hidden ones. Collapsed folders
	 * are not descended into, so this matches what the explorer can show.
	 */
	private flatten(): ExplorerNode[] {
		const nodes: ExplorerNode[] = [];
		const walk = (children: ExplorerNode[]): void => {
			for (const node of children) {
				nodes.push(node);
				if (isFolderNode(node) && !node.collapsed) {
					walk(node.vChildren?.children ?? []);
				}
			}
		};
		walk(this.view?.tree.root.vChildren?.children ?? []);
		return nodes;
	}

	private folderNotesSettings(): FolderNotesSettings | null {
		const app = this.app as unknown as {
			plugins?: {
				getPlugin(id: string): { settings?: FolderNotesSettings } | null;
			};
		};
		return app.plugins?.getPlugin("folder-notes")?.settings ?? null;
	}

	/** The Folder Notes exclusion that applies to a folder, if any. */
	private folderNoteExclusion(
		folder: TFolder,
		settings: FolderNotesSettings
	): FolderNotesExclusion | undefined {
		let match: FolderNotesExclusion | undefined;
		for (const excluded of settings.excludeFolders ?? []) {
			const path = excluded.path;
			if (path == null || path.length === 0) {
				continue;
			}
			if (
				folder.path === path ||
				(excluded.subFolders === true &&
					folder.path.startsWith(`${path}/`))
			) {
				match = excluded;
			}
		}
		return match;
	}

	/**
	 * Paths where Folder Notes may have stored this folder's note, in the same
	 * order the plugin's own lookup uses. `.ask` is a creation prompt rather
	 * than a file extension, so it is skipped and the supported types are
	 * tried instead.
	 */
	private folderNoteCandidates(
		folder: TFolder,
		settings: FolderNotesSettings,
		noteName = settings.folderNoteName ?? "{{folder_name}}"
	): string[] {
		const name = noteName.replace(/\{\{folder_name\}\}/g, folder.name);
		let dir = folder.path;
		if (settings.storageLocation === "parentFolder") {
			dir = folder.parent?.path ?? "";
		} else if (settings.storageLocation === "vaultFolder") {
			dir = "";
		}
		const base = normalizePath(dir ? `${dir}/${name}` : name);

		const supported = (settings.supportedFileTypes ?? ["md"]).map((type) =>
			type.startsWith(".") ? type : `.${type}`
		);
		const declared = settings.folderNoteType ?? ".md";
		const primary = declared.startsWith(".") ? declared : `.${declared}`;
		// Folder Notes looks Excalidraw notes up as Markdown first.
		const primaryType = primary === ".excalidraw" ? ".md" : primary;

		const extensions: string[] = [];
		if (supported.includes(primaryType)) {
			extensions.push(primaryType);
		}
		for (const type of supported) {
			if (type === primaryType) {
				continue;
			}
			if (type === ".excalidraw") {
				extensions.push(".md", ".excalidraw");
			} else {
				extensions.push(type);
			}
		}
		if (extensions.length === 0) {
			extensions.push(primaryType);
		}

		return [
			...new Set(
				extensions.map((extension) => normalizePath(`${base}${extension}`))
			),
		];
	}

	/** Whether this folder's note is deliberately visible in the explorer. */
	private folderNoteVisible(
		folder: TFolder,
		notePath: string,
		settings: FolderNotesSettings,
		doc: Document
	): boolean {
		const excluded = this.folderNoteExclusion(folder, settings);
		if (
			excluded?.showFolderNote === true ||
			excluded?.disableFolderNote === true
		) {
			return true;
		}

		const title = doc.querySelector(
			`.nav-folder-title[data-path="${CSS.escape(folder.path)}"]`
		);
		if (title != null) {
			if (title.classList.contains("show-folder-note-in-explorer")) {
				return true;
			}
			if (!title.classList.contains("has-folder-note")) {
				return true;
			}
		}

		const row = doc.querySelector(
			`.nav-file-title[data-path="${CSS.escape(notePath)}"]`
		);
		return row != null && !row.classList.contains("is-folder-note");
	}

	/**
	 * Paths of folder notes that Folder Notes is currently hiding. Use its DOM
	 * markers first, then compute paths from its settings so notes that are
	 * virtualized out of the explorer DOM are still skipped.
	 */
	private hiddenFolderNotes(): Set<string> {
		const hidden = new Set<string>();
		const doc = this.view?.containerEl.ownerDocument;
		if (doc == null || !doc.body.classList.contains("hide-folder-note")) {
			return hidden;
		}

		for (const item of Array.from(
			doc.querySelectorAll(".is-folder-note[data-path]")
		)) {
			const path = item.getAttribute("data-path");
			if (path != null) {
				hidden.add(path);
			}
		}

		const settings = this.folderNotesSettings();
		if (settings == null) {
			return hidden;
		}

		for (const folder of this.app.vault.getAllLoadedFiles()) {
			if (!(folder instanceof TFolder) || folder.isRoot()) {
				continue;
			}
			const notePath = this.folderNoteCandidates(folder, settings).find(
				(path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile
			);
			if (notePath == null) {
				continue;
			}
			if (this.folderNoteVisible(folder, notePath, settings, doc)) {
				continue;
			}
			hidden.add(notePath);
		}
		return hidden;
	}

	private isHidden(node: ExplorerNode, hidden: Set<string>): boolean {
		if (!isFolderNode(node)) {
			if (hidden.has(node.file.path)) {
				return true;
			}
			if (this.isUnsupported(node.file)) {
				return true;
			}
		}
		return this.isRowHidden(node);
	}

	/**
	 * Obsidian keeps unsupported files in the explorer's tree but hides their
	 * rows unless "Show unsupported files" is enabled. Skip them the same way
	 * so `j`/`k`, `gg`/`G` and folder entry never land on an invisible row.
	 */
	private isUnsupported(file: TFile): boolean {
		if (this.app.vault.getConfig("showUnsupportedFiles") === true) {
			return false;
		}
		return !this.app.viewRegistry.isExtensionRegistered(file.extension);
	}

	/**
	 * Other plugins (for example Hide Folders) hide explorer rows with CSS
	 * rather than removing their tree nodes. Walking into those rows leaves
	 * keyboard focus on an element nobody can see. Check the node and its
	 * ancestors for a connected row that is styled away; detached subtrees are
	 * left alone because they may simply be virtualized out of the viewport.
	 */
	private isRowHidden(node: ExplorerNode): boolean {
		let current: ExplorerNode | null = node;
		while (current != null) {
			const el = current.el;
			if (el?.isConnected) {
				const style = getComputedStyle(el);
				if (style.display === "none" || style.visibility === "hidden") {
					return true;
				}
			}
			current = current.parent ?? null;
		}
		return false;
	}

	/** Whether Folder Notes has marked this folder as having a folder note. */
	private folderHasFolderNote(node: ExplorerFolderNode): boolean {
		if (node.el.classList.contains("has-folder-note")) {
			return true;
		}

		// Scope to this folder's own title; child folders may have notes too.
		const title = node.el.querySelector(
			`.nav-folder-title[data-path="${CSS.escape(node.file.path)}"]`
		);
		return title?.classList.contains("has-folder-note") ?? false;
	}

	/**
	 * The folder note belonging to `folder`, if there is one. Prefer the exact
	 * path Folder Notes derives from its settings; fall back to the same-name
	 * convention without ever picking up a child folder's note.
	 */
	private folderNote(node: ExplorerFolderNode): TFile | null {
		const folder = node.file;
		const settings = this.folderNotesSettings();

		if (settings != null) {
			const excluded = this.folderNoteExclusion(folder, settings);
			if (excluded?.disableFolderNote !== true) {
				for (const name of [
					settings.folderNoteName,
					settings.oldFolderNoteName,
				]) {
					if (name == null || name.length === 0) {
						continue;
					}
					for (const path of this.folderNoteCandidates(
						folder,
						settings,
						name
					)) {
						const expected =
							this.app.vault.getAbstractFileByPath(path);
						if (expected instanceof TFile) {
							return expected;
						}
					}
				}
			}
		}

		// No settings-based match: fall back to the same-name convention, but
		// only in the directory where Folder Notes would store it. In
		// particular, never search a parent folder's children when notes live
		// beside their folders: a subfolder's note could share the name.
		if (!this.folderHasFolderNote(node)) {
			return null;
		}

		const search: TAbstractFile[] = [];
		const storage = settings?.storageLocation;
		if (storage == null || storage === "insideFolder") {
			search.push(...folder.children);
		}
		if (storage == null || storage !== "insideFolder") {
			search.push(...(folder.parent?.children ?? []));
		}
		search.push(...this.app.vault.getRoot().children);

		const seen = new Set<string>();
		for (const item of search) {
			if (
				item instanceof TFile &&
				item.basename === folder.name &&
				!seen.has(item.path)
			) {
				seen.add(item.path);
				return item;
			}
		}
		return null;
	}

	private focusNode(node: ExplorerNode): void {
		const tree = this.view?.tree;
		if (tree == null) {
			return;
		}

		// Move the viewport ourselves so the row keeps a margin at the top and
		// bottom instead of being scrolled flush against the clipped edge.
		tree.setFocusedItem(node);
		if (tree.infinityScroll != null) {
			tree.infinityScroll.scrollIntoView(node, EXPLORER_SCROLL_MARGIN);
		} else {
			node.el.scrollIntoView({ block: "nearest" });
		}
	}

	/** Moves to the next visible row, crossing into/out of expanded folders. */
	private step(offset: 1 | -1): void {
		const tree = this.view?.tree;
		if (tree == null) {
			return;
		}

		const nodes = this.flatten();
		if (nodes.length === 0) {
			return;
		}

		const hidden = this.hiddenFolderNotes();
		const current = tree.focusedItem;
		let index = current == null ? -1 : nodes.indexOf(current);
		if (index < 0) {
			index = offset > 0 ? -1 : nodes.length;
		}

		for (let i = index + offset; i >= 0 && i < nodes.length; i += offset) {
			const node = nodes[i];
			if (node != null && !this.isHidden(node, hidden)) {
				this.focusNode(node);
				return;
			}
		}
	}

	private moveDown(): void {
		this.step(1);
	}

	private moveUp(): void {
		this.step(-1);
	}

	/** Vim `h`: collapse the focused folder, otherwise jump to its parent. */
	private moveLeft(): void {
		const node = this.focused();
		if (node == null) {
			return;
		}

		if (isFolderNode(node) && !node.collapsed) {
			node.setCollapsed(true);
			return;
		}

		if (node.parent != null) {
			this.focusNode(node.parent);
		}
	}

	/** Vim `l` on a folder: expand it, or enter its first visible child. */
	private enterFolder(node: ExplorerFolderNode): void {
		if (node.collapsed) {
			node.setCollapsed(false);
			return;
		}

		const hidden = this.hiddenFolderNotes();
		const child = (node.vChildren?.children ?? []).find(
			(item) => !this.isHidden(item, hidden)
		);
		if (child != null) {
			this.focusNode(child);
		}
	}

	private async open(toggleFolder: boolean): Promise<void> {
		const node = this.focused();
		if (node == null) {
			return;
		}

		if (!isFolderNode(node)) {
			await this.openFile(node.file);
			return;
		}

		if (toggleFolder) {
			// Enter: open the folder note when the setting allows it.
			if (this.settings.enterOpensFolderNote) {
				const note = this.folderNote(node);
				if (note != null) {
					if (this.settings.expandFolderOnEnter) {
						node.setCollapsed(false);
					}
					await this.openFile(note);
					return;
				}
			}

			if (this.settings.expandFolderOnEnter) {
				node.setCollapsed(false);
			} else {
				node.setCollapsed(!node.collapsed);
			}
			return;
		}

		// `l`: expand the folder, or step into its first visible child.
		if (node.collapsed) {
			node.setCollapsed(false);
		} else {
			this.enterFolder(node);
		}
	}

	private async openFile(file: TFile): Promise<void> {
		const leaf =
			this.app.workspace.getMostRecentLeaf() ??
			this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private async openIn(kind: "vertical" | "horizontal" | "tab"): Promise<void> {
		const node = this.focused();
		if (node == null || isFolderNode(node)) {
			return;
		}

		// getLeaf splits/tabs the active leaf, which is the sidebar explorer right now.
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent != null) {
			this.app.workspace.setActiveLeaf(recent, { focus: false });
		}

		const leaf =
			kind === "tab"
				? this.app.workspace.getLeaf("tab")
				: this.app.workspace.getLeaf("split", kind);
		await leaf.openFile(node.file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private focusEdge(edge: "first" | "last"): void {
		const hidden = this.hiddenFolderNotes();
		const nodes = this.flatten().filter(
			(node) => !this.isHidden(node, hidden)
		);
		const node = edge === "first" ? nodes[0] : nodes[nodes.length - 1];
		if (node != null) {
			this.focusNode(node);
		}
	}

	private collapseAll(): void {
		const tree = this.view?.tree;
		if (tree == null) {
			return;
		}

		tree.isAllCollapsed = false;
		tree.setCollapseAll(true);
	}

	private async add(folderOnly: boolean): Promise<void> {
		const folder = this.targetFolder();
		const input = await this.prompt({
			title: folderOnly ? "New folder" : "New file",
			prefix: folder.isRoot() ? "/" : `${folder.path}/`,
			hint: folderOnly
				? undefined
				: "End with / to create a folder. Nested paths like a/b/note work. No extension means a .md note.",
		});
		if (input == null) {
			return;
		}

		const isFolder = folderOnly || input.endsWith("/");
		let path = joinPath(folder, input);

		if (this.app.vault.getAbstractFileByPath(path) != null) {
			new Notice(`Already exists: ${path}`);
			return;
		}

		if (isFolder) {
			const created = await this.ensureFolder(path);
			this.pushUndo(`create ${path}`, () =>
				this.removeEmptyFolders(created)
			);
			this.reveal(path);
			return;
		}

		const name = path.split("/").pop() ?? "";
		if (!name.includes(".")) {
			path = `${path}.md`;
		}

		if (this.app.vault.getAbstractFileByPath(path) != null) {
			new Notice(`Already exists: ${path}`);
			return;
		}

		const created = await this.ensureFolder(parentPath(path));
		await this.app.vault.create(path, "");
		this.pushUndo(`create ${path}`, async () => {
			await this.trashIfExists(path);
			await this.removeEmptyFolders(created);
		});
		this.reveal(path);
	}

	private async delete(): Promise<void> {
		const node = this.focused();
		if (node == null) {
			return;
		}

		const file = node.file;
		if (this.settings.confirmDelete) {
			const confirmed = await this.confirm({
				title: "Delete",
				message: `Delete "${file.path}"${
					file instanceof TFolder ? " and everything in it" : ""
				}?`,
				confirmText: "Delete",
			});
			if (!confirmed) {
				return;
			}
		}

		const snapshot = await this.snapshot(file);
		// trashFile follows the user's trash setting (system trash, .trash folder, or delete).
		await this.app.fileManager.trashFile(file);

		if (snapshot == null) {
			new Notice(
				`Deleted ${file.name}. It is too large to undo here; restore it from the trash.`
			);
			return;
		}

		this.pushUndo(
			`delete ${file.path}`,
			async () => {
				for (const folder of snapshot.folders) {
					await this.ensureFolder(folder);
				}
				for (const { path, data } of snapshot.files) {
					if (this.app.vault.getAbstractFileByPath(path) == null) {
						await this.ensureFolder(parentPath(path));
						await this.app.vault.createBinary(path, data);
					}
				}
				this.reveal(file.path);
			},
			snapshot.bytes
		);
	}

	private async rename(): Promise<void> {
		const node = this.focused();
		if (node == null) {
			return;
		}

		const file = node.file;
		const name = await this.prompt({
			title: "Rename",
			value: file.name,
			selectBaseName: file instanceof TFile,
		});
		if (name == null || name === file.name) {
			return;
		}

		await this.moveTo(
			file,
			joinPath(file.parent ?? this.app.vault.getRoot(), name)
		);
	}

	private async move(): Promise<void> {
		const node = this.focused();
		if (node == null) {
			return;
		}

		const dest = await this.prompt({
			title: "Move to",
			value: node.file.path,
			hint: "Full path from the vault root. Missing folders are created.",
		});
		if (dest == null || normalizePath(dest) === node.file.path) {
			return;
		}

		await this.moveTo(node.file, normalizePath(dest));
	}

	private async copyTo(): Promise<void> {
		const node = this.focused();
		if (node == null) {
			return;
		}

		const dest = await this.prompt({
			title: "Copy to",
			value: this.availablePath(
				node.file,
				node.file.parent ?? this.app.vault.getRoot()
			),
			hint: "Full path from the vault root. Missing folders are created.",
		});
		if (dest == null) {
			return;
		}

		await this.copyFile(node.file, normalizePath(dest));
	}

	private setClipboard(mode: "cut" | "copy"): void {
		const node = this.focused();
		if (node == null) {
			return;
		}

		this.clipboard = { mode, path: node.file.path };
		new Notice(
			`${mode === "cut" ? "Cut" : "Copied"}: ${node.file.name} (p to paste)`
		);
	}

	private async paste(): Promise<void> {
		if (this.clipboard == null) {
			new Notice("Nothing to paste. Cut or copy an item first.");
			return;
		}

		const source = this.app.vault.getAbstractFileByPath(this.clipboard.path);
		if (source == null) {
			this.clipboard = null;
			new Notice("The cut or copied item no longer exists");
			return;
		}

		const folder = this.targetFolder();

		if (this.clipboard.mode === "copy") {
			await this.copyFile(source, this.availablePath(source, folder));
			return;
		}

		if (
			source instanceof TFolder &&
			(folder === source || folder.path.startsWith(`${source.path}/`))
		) {
			new Notice("Cannot move a folder into itself");
			return;
		}

		await this.moveTo(source, joinPath(folder, source.name));
		this.clipboard = null;
	}

	private async undo(): Promise<void> {
		const entry = this.undoStack.pop();
		if (entry == null) {
			new Notice("Nothing to undo");
			return;
		}

		await entry.run();
		new Notice(`Undid ${entry.label}`);
	}

	private pushUndo(
		label: string,
		run: () => Promise<void>,
		bytes = 0
	): void {
		this.undoStack.push({ label, run, bytes });

		let held = this.undoStack.reduce((total, entry) => total + entry.bytes, 0);
		while (this.undoStack.length > UNDO_LIMIT || held > UNDO_MEMORY_LIMIT) {
			held -= this.undoStack.shift()?.bytes ?? 0;
		}
	}

	private async moveTo(file: TAbstractFile, dest: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(dest) != null) {
			new Notice(`Already exists: ${dest}`);
			return;
		}

		const from = file.path;
		const created = await this.ensureFolder(parentPath(dest));
		// fileManager (not vault) so links to the file are updated.
		await this.app.fileManager.renameFile(file, dest);
		this.pushUndo(`move ${from} → ${dest}`, async () => {
			const moved = this.app.vault.getAbstractFileByPath(dest);
			if (moved != null) {
				await this.ensureFolder(parentPath(from));
				await this.app.fileManager.renameFile(moved, from);
			}
			await this.removeEmptyFolders(created);
			this.reveal(from);
		});
		this.reveal(dest);
	}

	private async copyFile(file: TAbstractFile, dest: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(dest) != null) {
			new Notice(`Already exists: ${dest}`);
			return;
		}

		const created = await this.ensureFolder(parentPath(dest));
		await this.app.vault.copy(file, dest);
		this.pushUndo(`copy ${file.path} → ${dest}`, async () => {
			await this.trashIfExists(dest);
			await this.removeEmptyFolders(created);
		});
		this.reveal(dest);
	}

	/** Keeps the contents of a file or folder in memory so a delete can be undone. */
	private async snapshot(file: TAbstractFile): Promise<Snapshot | null> {
		const files: TFile[] = [];
		const folders: string[] = [];
		const walk = (item: TAbstractFile): void => {
			if (item instanceof TFile) {
				files.push(item);
			} else if (item instanceof TFolder) {
				folders.push(item.path);
				item.children.forEach(walk);
			}
		};
		walk(file);

		const bytes = files.reduce((total, item) => total + item.stat.size, 0);
		if (bytes > UNDO_MEMORY_LIMIT) {
			return null;
		}

		const contents: Snapshot["files"] = [];
		for (let i = 0; i < files.length; i += SNAPSHOT_BATCH_SIZE) {
			const batch = await Promise.all(
				files
					.slice(i, i + SNAPSHOT_BATCH_SIZE)
					.map(async (item) => ({
						path: item.path,
						data: await this.app.vault.readBinary(item),
					}))
			);
			contents.push(...batch);
		}
		return { folders, files: contents, bytes };
	}

	private async trashIfExists(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file != null) {
			await this.app.fileManager.trashFile(file);
		}
	}

	/** Removes folders created by an operation, deepest first, if they are still empty. */
	private async removeEmptyFolders(paths: string[]): Promise<void> {
		for (const path of [...paths].reverse()) {
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (folder instanceof TFolder && folder.children.length === 0) {
				await this.app.fileManager.trashFile(folder);
			}
		}
	}

	/** "note.md" -> "note 1.md", like Obsidian's own duplicates. */
	private availablePath(file: TAbstractFile, folder: TFolder): string {
		const ext = file instanceof TFile ? file.extension : "";
		const base = file instanceof TFile ? file.basename : file.name;
		const build = (suffix: string): string =>
			joinPath(folder, `${base}${suffix}${ext ? `.${ext}` : ""}`);

		let path = build("");
		for (let i = 1; this.app.vault.getAbstractFileByPath(path) != null; i++) {
			path = build(` ${i}`);
		}
		return path;
	}

	/** Creates missing folders along `path` and returns the ones it created, shallowest first. */
	private async ensureFolder(path: string): Promise<string[]> {
		const created: string[] = [];
		const normalized = normalizePath(path);
		if (normalized === "" || normalized === "/") {
			return created;
		}

		let current = "";
		for (const segment of normalized.split("/")) {
			current = current ? `${current}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(current);

			if (existing == null) {
				await this.app.vault.createFolder(current);
				created.push(current);
			} else if (!(existing instanceof TFolder)) {
				throw new Error(`Not a folder: ${current}`);
			}
		}
		return created;
	}

	/**
	 * Focuses a path in the explorer. The tree builds its item from the vault event, which
	 * has not necessarily arrived yet, so ask again until it has rather than guess at a
	 * delay that is long enough.
	 */
	private reveal(path: string): void {
		let attempts = 0;

		const focus = (): void => {
			const file = this.app.vault.getAbstractFileByPath(path);
			const view = this.view;
			if (file == null || view == null) {
				return;
			}

			// Expands the parents, which is what creates the item for a collapsed folder.
			view.revealInFolder(file);

			const node = view.fileItems[file.path];
			if (node != null) {
				// Folder Notes may have revealed a hidden folder-note file; keep
				// the visible focus on its folder instead.
				view.tree.setFocusedItem(
					this.isHidden(node, this.hiddenFolderNotes()) &&
						node.parent != null
						? node.parent
						: node
				);
			} else if (++attempts < REVEAL_ATTEMPTS) {
				window.setTimeout(focus, REVEAL_INTERVAL);
			}
		};

		window.setTimeout(focus, REVEAL_INTERVAL);
	}

	private async prompt(options: PromptOptions): Promise<string | null> {
		const value = await promptText(this.app, options);
		this.restoreExplorerFocus();
		return value;
	}

	private async confirm(options: ConfirmOptions): Promise<boolean> {
		const confirmed = await confirmAction(this.app, options);
		this.restoreExplorerFocus();
		return confirmed;
	}

	/**
	 * Cancelling a modal must not strand the keyboard in the note. Put focus
	 * back on the explorer, and again after Obsidian's modal teardown runs.
	 */
	private restoreExplorerFocus(): void {
		this.focusExplorerLeaf();
		// Obsidian's modal teardown can reclaim focus on the next tick.
		window.setTimeout(() => this.focusExplorerLeaf(), 0);
	}

	private close(): void {
		const leaf = this.app.workspace.getLeavesOfType(EXPLORER_VIEW_TYPE)[0];
		const root = leaf?.getRoot();
		if (root instanceof WorkspaceSidedock) {
			root.collapse();
		}
		this.focusEditor();
	}

	private focusEditor(): void {
		const leaf = this.noteLeaf();
		if (leaf == null) {
			return;
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		void this.app.workspace.revealLeaf(leaf);

		// `setActiveLeaf` focuses the leaf only while the workspace window
		// reports focus, which is not true right after a command palette closes.
		// Apply the leaf's own focus state as well; for Reading mode that
		// focuses `.markdown-preview-view`, which has no editor to focus.
		if (leaf.isDeferred) {
			void leaf
				.loadIfDeferred()
				.then(() => leaf.setEphemeralState({ focus: true }));
		} else {
			leaf.setEphemeralState({ focus: true });
		}
	}

	/** The most recently active markdown leaf, i.e. the note to return to. */
	private noteLeaf(): WorkspaceLeaf | null {
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent?.view.getViewType() === "markdown") {
			return recent;
		}

		let best: WorkspaceLeaf | null = null;
		let bestTime = -1;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const time =
				(leaf as unknown as { activeTime?: number }).activeTime ?? 0;
			if (time > bestTime) {
				best = leaf;
				bestTime = time;
			}
		}
		return best;
	}
}
