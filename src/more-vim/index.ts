import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MarkdownView, Platform, type App } from "obsidian";
import type VimiumPlugin from "../main";
import { defineCommands } from "./commands";
import type { ActiveContext } from "./context";
import { scrolloff } from "./scrolloff";
import { Surround } from "./surround";
import { TableNav, tableNavActivation } from "./table-nav";
import type { VimAdapter, VimMode } from "./vim";
import { Vim } from "./vim";
import { Clipboard } from "./yank";

const MOTIONS = ["h", "j", "k", "l", "w", "W", "b", "B", "e", "E", "$", "^"];

/**
 * Vim features ported from More Vim: surround, multiple cursors, select-word,
 * scrolloff, the system-clipboard register, and gd/gx/list-aware o.
 *
 * Keyboard features are handled by Vimium++'s existing capture-phase listener
 * so they respect the hint and leader priority rules. Only scrolloff needs a
 * CodeMirror extension.
 */
export class VimExtras {
	readonly vim = new Vim();
	readonly tableNav: TableNav;
	private readonly clipboard = new Clipboard();
	private readonly surround = new Surround();
	private initialized = false;

	constructor(
		private readonly app: App,
		private readonly plugin: VimiumPlugin
	) {
		this.tableNav = new TableNav(
			this.app,
			this.vim,
			() => this.activeContext(),
			() => this.plugin.settings.scrolloff,
			() => this.plugin.settings.tableNavigation,
			() => this.plugin.refreshModeIndicator()
		);
	}

	/** Initialize once an editor with a live Vim adapter is available. */
	init(): void {
		this.syncDisplayLineMotion();
		if (this.initialized) return;
		const ctx = this.activeContext();
		if (!ctx || !this.vim.init(ctx.adapter)) return;
		this.initialized = true;
		this.syncDisplayLineMotion();

		defineCommands(this);
		this.clipboard.install({
			isEnabled: () => this.plugin.settings.registerSystemClipboard,
			getController: () => this.vim.getRegisterController(),
			onFocus: (handler) =>
				this.plugin.registerDomEvent(window, "focus", handler),
		});
		this.plugin.registerEditorExtension(
			scrolloff(() => this.plugin.settings.scrolloff)
		);
		this.plugin.registerEditorExtension(
			tableNavActivation((view) => this.tableNav.onViewUpdate(view))
		);
	}

	/** Called after settings are saved so the clipboard toggle takes effect. */
	syncSettings(): void {
		this.clipboard.syncWithSetting();
		this.syncDisplayLineMotion();
		this.tableNav.syncSettings();
	}

	/** Keep Vim's j/k mapping in sync with the setting. */
	private syncDisplayLineMotion(): void {
		this.vim.applyDisplayLineMotion(this.plugin.settings.jkAsGjGk);
	}

	/** Drop any half-typed command or active table session. */
	reset(): void {
		this.surround.reset();
		this.tableNav.reset();
	}

	uninstall(): void {
		this.vim.applyDisplayLineMotion(false);
		this.clipboard.uninstall();
		this.surround.reset();
		this.tableNav.uninstall();
	}

	/** The active Markdown editor, its CodeMirror view, and its Vim adapter. */
	activeContext(): ActiveContext | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor;
		if (!editor) return null;
		const raw = editor as unknown as {
			cm?: EditorView & { cm?: VimAdapter };
		};
		const cmView = raw.cm;
		const adapter = cmView?.cm;
		if (!cmView || !adapter) return null;
		return {
			editor,
			cmView,
			adapter,
			vim: this.vim,
			file: view?.file ?? null,
		};
	}

	openLink(text: string, sourcePath: string): void {
		void this.app.workspace.openLinkText(text, sourcePath);
	}

	openExternal(url: string): void {
		window.open(url, "_blank");
	}

	/**
	 * Handle a keydown from the active editor. Returns true when the key was
	 * consumed. The caller is responsible for preventDefault/stopPropagation.
	 */
	handleKeyDown(event: KeyboardEvent, fromEditor: boolean): boolean {
		if (!this.initialized || !fromEditor || event.isComposing) return false;
		const ctx = this.activeContext();
		if (!ctx) return false;

		if (this.tableNav.handleKeyDown(event, ctx)) return true;

		if (event.key === "Escape") {
			this.surround.reset();
			return this.collapseToMain(ctx);
		}

		const mod = Platform.isMacOS ? event.metaKey : event.ctrlKey;
		if (mod && !event.altKey && event.key.toLowerCase() === "d") {
			return this.selectWord(ctx);
		}
		if (
			mod &&
			event.altKey &&
			(event.key === "ArrowDown" || event.key === "ArrowUp")
		) {
			return this.addCursorVertical(ctx, event.key === "ArrowDown");
		}

		// Plain Ctrl (except AltGr) and Meta belong to the OS / Obsidian.
		if (event.metaKey || (event.ctrlKey && !event.altKey)) return false;
		if (event.key.length !== 1) return false;

		const mode = this.vim.mode(ctx.adapter);
		if (mode !== "normal" && mode !== "visual") return false;

		// A pending Vim prefix belongs to Vim (e.g. the `g` of `gd`).
		if (this.vim.hasPendingInput(ctx.adapter)) return false;

		if (mode === "normal" && MOTIONS.includes(event.key)) {
			return this.runPerCursor(ctx, event.key);
		}
		return this.surround.handle(event.key, ctx, mode);
	}

	private collapseToMain(ctx: ActiveContext): boolean {
		const selection = ctx.cmView.state.selection;
		if (selection.ranges.length <= 1) return false;
		if (this.vim.mode(ctx.adapter) !== "normal") return false;
		ctx.cmView.dispatch({ selection: EditorSelection.single(selection.main.head) });
		return true;
	}

	private addCursorVertical(ctx: ActiveContext, forward: boolean): boolean {
		const { cmView: view } = ctx;
		const selection = view.state.selection;
		const main = selection.main;
		const moved = view.moveVertically(main, forward);
		if (moved.head === main.head) return true;
		const ranges = [...selection.ranges, moved];
		view.dispatch({
			selection: EditorSelection.create(ranges, ranges.length - 1),
		});
		return true;
	}

	private runPerCursor(ctx: ActiveContext, key: string): boolean {
		const { cmView: view, adapter, vim } = ctx;
		if (view.state.selection.ranges.length <= 1) return false;
		if (vim.mode(adapter) !== "normal") return false;
		const motion =
			this.plugin.settings.jkAsGjGk && (key === "j" || key === "k")
				? `g${key}`
				: key;
		vim.perCursor(view, adapter, () => vim.send(adapter, motion));
		return true;
	}

	private selectWord(ctx: ActiveContext): boolean {
		if (!this.vim.isReady()) return false;
		if (!this.plugin.settings.modD) return false;

		const { cmView: view, adapter, vim } = ctx;
		const mode: VimMode = vim.mode(adapter);
		const selection = view.state.selection;
		const main = selection.main;

		if (mode === "insert" && main.empty && selection.ranges.length === 1) {
			return false;
		}
		if (main.empty && selection.ranges.length === 1) {
			vim.send(adapter, "v");
			vim.send(adapter, "i");
			vim.send(adapter, "w");
			return true;
		}

		const needle = view.state.sliceDoc(main.from, main.to);
		if (!needle) return true;

		const doc = view.state.doc.toString();
		const taken = new Set(selection.ranges.map((range) => range.from));
		let foundAt = findNext(doc, needle, main.to, taken);
		if (foundAt === -1) foundAt = findNext(doc, needle, 0, taken);
		if (foundAt === -1) return true;

		const newRange = EditorSelection.range(foundAt, foundAt + needle.length);
		const ranges = [...selection.ranges, newRange];
		if (mode === "visual") vim.send(adapter, "<Esc>");
		view.dispatch({
			selection: EditorSelection.create(ranges, ranges.length - 1),
			effects: EditorView.scrollIntoView(foundAt + needle.length, {
				y: "center",
			}),
		});
		return true;
	}
}

function findNext(
	doc: string,
	needle: string,
	from: number,
	taken: Set<number>
): number {
	let index = doc.indexOf(needle, from);
	while (index !== -1 && taken.has(index)) {
		index = doc.indexOf(needle, index + 1);
	}
	return index;
}
