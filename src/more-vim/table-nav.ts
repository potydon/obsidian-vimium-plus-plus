import {
	EditorSelection,
	type EditorState,
	type Extension,
	type Range,
} from "@codemirror/state";
import {
	Decoration,
	EditorView,
	type DecorationSet,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField, MarkdownView, type App } from "obsidian";
import type { ActiveContext } from "./context";
import type { VimAdapter, VimPos } from "./vim";
import type { Vim } from "./vim";

/** How a table cell is opened after navigation. */
export type TableEntryMode =
	| "insert"
	| "insert-append"
	| "change"
	| "substitute"
	| "normal";

type NavState = "inactive" | "nav" | "edit";
type Placement = "before" | "after";
type Direction = "h" | "j" | "k" | "l";

interface TableCellRef {
	table: TableEditorLike;
	cell: TableCellLike;
	cm?: unknown;
}

interface TableCellLike {
	row: number;
	col: number;
	el?: HTMLElement;
	table?: TableEditorLike;
	getAbsoluteOffsets?(): {
		start: number;
		end: number;
		textStart: number;
		textEnd: number;
	};
}

interface EditViewLike {
	tableCell?: TableCellRef | null;
	/** Obsidian's signature is `editTableCell(table, cell)`. */
	editTableCell?: (table: TableEditorLike, cell: TableCellLike) => unknown;
	destroyTableCell?: () => void;
}

interface TableEditorLike {
	rows?: readonly (readonly unknown[])[];
	getCellAt(row: number, col: number): TableCellLike | null;
	receiveCellFocus?(row: number, col: number): void;
	setCellFocus?(row: number, col: number): void;
	placeCursorAround?(placement: Placement): void;
}

interface TableRange {
	from: number;
	to: number;
	lines: string[];
}

interface ActiveTable {
	editMode: EditViewLike;
	cell: TableCellRef;
	range: TableRange;
	widgetEl: HTMLElement;
	table: TableEditorLike;
	row: number;
	col: number;
}

interface CellVimAdapter extends VimAdapter {
	getCursor?(): VimPos;
	replaceSelection?(text: string): void;
	replaceRange?(text: string, from: VimPos, to: VimPos): void;
	firstLine?(): number;
	lastLine?(): number;
}

const TABLE_RE = /^\s*\|/;
const HIDDEN_CLASS = "vimium-table-cell-hidden";
const NAV_CLASS = "vimium-table-nav-mode";
const ACTIVE_CLASS = "vimium-table-nav-active";
const TABLE_BLANK_CLASS = "vimium-table-leading-blank";
const ENTRY_DELAY_MS = 100;
const ENTRY_DEBOUNCE_MS = 80;

const DIRECTION_KEYS: Record<string, Direction> = {
	h: "h",
	ArrowLeft: "h",
	j: "j",
	ArrowDown: "j",
	k: "k",
	ArrowUp: "k",
	l: "l",
	ArrowRight: "l",
};

/**
 * Enter navigation after a caret/focus change, not only after a keydown.
 * Obsidian opens the native cell editor as part of the editor update, so this
 * is the reliable place to notice that `j`/`k` crossed a table boundary.
 */
export function tableNavActivation(
	onUpdate: (view: EditorView) => void
): Extension {
	return ViewPlugin.fromClass(
		class {
			update(update: ViewUpdate): void {
				if (update.selectionSet || update.focusChanged) {
					onUpdate(update.view);
				}
			}
		}
	);
}

/**
 * Mark the blank line Obsidian requires above a table. The line stays in the
 * document; CSS collapses it visually when the setting is enabled.
 */
export function tableLeadingBlankDecoration(): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildTableBlankDecorations(view);
			}

			update(update: ViewUpdate): void {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildTableBlankDecorations(update.view);
				}
			}
		},
		{ decorations: (plugin) => plugin.decorations }
	);
}

function buildTableBlankDecorations(view: EditorView): DecorationSet {
	const ranges: Range<Decoration>[] = [];
	for (const table of findTableRanges(view.state)) {
		const startLine = view.state.doc.lineAt(table.from).number;
		if (startLine <= 1) continue;
		const previous = view.state.doc.line(startLine - 1);
		if (previous.text.trim().length !== 0) continue;
		ranges.push(
			Decoration.line({ class: TABLE_BLANK_CLASS }).range(previous.from)
		);
	}
	return Decoration.set(ranges, true);
}

/**
 * Modal table navigation for Obsidian's native Live Preview table widget.
 *
 * Obsidian gives each table cell its own editor. When one is open in Vim normal
 * mode, we hide that editor, own the keyboard from Vimium++'s capture listener,
 * and move a highlighted cell through the rendered widget. `i`/`Enter` then
 * reveals the cell editor again and hands the key to its Vim instance.
 */
export class TableNav {
	private state: NavState = "inactive";
	private view: EditorView | null = null;
	private widgetEl: HTMLElement | null = null;
	private hiddenEl: HTMLElement | null = null;
	private highlightedEl: HTMLElement | null = null;
	private highlightedCell: TableCellLike | null = null;
	private tableFrom = 0;
	private row = 0;
	private col = 0;
	private countBuffer = "";
	private gPending = false;
	private entryMode: TableEntryMode | null = null;
	private entryKeys: string[] = [];
	private entryTimer: number | null = null;
	private entryTarget: {
		row: number;
		col: number;
		cell: TableCellLike;
		table: TableEditorLike;
	} | null = null;
	private entryAttempts = 0;
	private deferredActivation: number | null = null;
	private deferredView: EditorView | null = null;

	constructor(
		private readonly app: App,
		private readonly vim: Vim,
		private readonly getContext: () => ActiveContext | null,
		private readonly getScrolloff: () => number,
		private readonly isEnabled: () => boolean,
		private readonly onStateChange: () => void
	) {}

	/** Status-pill label while the modal cell navigator owns the keyboard. */
	modeLabel(): "TABLE" | null {
		return this.state === "nav" ? "TABLE" : null;
	}

	/** Called by the CodeMirror activation extension on caret/focus changes. */
	onViewUpdate(view: EditorView): void {
		if (!this.isEnabled() || this.state !== "inactive") return;
		const ctx = this.getContext();
		if (!ctx || ctx.cmView !== view || !this.mainVimIdle(ctx)) return;
		if (
			!findTableRanges(ctx.cmView.state).some((table) =>
				cursorInTable(ctx, table)
			)
		) {
			return;
		}
		this.scheduleActivation(ctx);
	}

	/** Consume a key when table nav owns it. Caller performs stopPropagation. */
	handleKeyDown(event: KeyboardEvent, ctx: ActiveContext): boolean {
		if (!this.isEnabled()) {
			this.reset();
			return false;
		}
		if (this.state !== "inactive" && ctx.cmView !== this.view) {
			this.reset();
		}

		if (this.state === "inactive") {
			if (!this.mainVimIdle(ctx)) {
				this.cancelDeferredActivation();
				return false;
			}
			// Crossing into a table from the line right above it is unreliable:
			// CodeMirror treats the rendered table widget as one display line and
			// jumps straight past it. Own that boundary key ourselves.
			if (this.tryEnterFromBoundary(event, ctx)) return true;
			if (!this.tryEnter(ctx)) {
				// A j/k from just outside a table creates the cell editor only
				// after this capture listener has run. Re-check once the native
				// key has moved the cursor so the first key already lands in
				// table-nav mode instead of needing a second one.
				this.scheduleActivationAfterKey(event, ctx);
				return false;
			}
		}
		if (!this.sessionValid(ctx)) {
			this.reset();
			return false;
		}

		return this.state === "nav"
			? this.handleNavKey(event, ctx)
			: this.handleEditKey(event);
	}

	/** Leave any nav/edit session without moving the source cursor. */
	reset(): void {
		this.exitTable(null);
	}

	/** Settings-disable and plugin-unload cleanup. */
	uninstall(): void {
		this.exitTable(null);
	}

	/** React to the enable setting being turned off at runtime. */
	syncSettings(): void {
		if (!this.isEnabled()) this.reset();
	}

	/** While a cell editor is open, its keys belong to it, not the leader. */
	ownsCellKeyboard(): boolean {
		return this.state === "edit";
	}

	// ---- activation and key handling -------------------------------------

	private mainVimIdle(ctx: ActiveContext): boolean {
		return (
			this.vim.mode(ctx.adapter) === "normal" &&
			!this.vim.hasPendingInput(ctx.adapter)
		);
	}

	/**
	 * The native key (or an editor update) may create the cell editor only
	 * after our capture listener runs. Re-check shortly afterwards so the key
	 * that crosses the table boundary already lands in navigation mode.
	 */
	private scheduleActivationAfterKey(
		event: KeyboardEvent,
		ctx: ActiveContext
	): void {
		if (event.ctrlKey || event.altKey || event.metaKey) return;
		this.scheduleActivation(ctx);
	}

	/**
	 * Enter a table when a vertical key moves in from the immediately adjacent
	 * line. Both arrow keys and Vim's h/j/k/l reach this listener, so this fixes
	 * the "Down from above skips the whole table" case for every vertical key.
	 */
	private tryEnterFromBoundary(
		event: KeyboardEvent,
		ctx: ActiveContext
	): boolean {
		if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
			return false;
		}
		const direction = DIRECTION_KEYS[event.key];
		if (direction !== "j" && direction !== "k") return false;

		const { state } = ctx.cmView;
		const headLine = state.doc.lineAt(state.selection.main.head).number;
		const table = findTableRanges(state).find((range) => {
			const startLine = state.doc.lineAt(range.from).number;
			const endLine = state.doc.lineAt(range.to).number;
			// Step over the blank line Markdown requires above a table.
			return direction === "j"
				? blankLinesBetween(state, headLine + 1, startLine)
				: blankLinesBetween(state, endLine + 1, headLine);
		});
		if (!table) return false;

		const widgetEl = findTableWidgetElement(ctx.cmView, table.from);
		const editor = widgetEl ? tableEditorFromWidget(widgetEl) : null;
		if (!editor) return false;
		const rowCount = editor.rows?.length ?? 0;
		if (rowCount === 0) return false;
		const row = direction === "j" ? 0 : rowCount - 1;
		const cell = editor.getCellAt(row, 0);
		if (!cell) return false;

		// Move the real cursor into the cell so Obsidian opens its editor, then
		// let the usual deferred activation take over once that editor exists.
		this.moveMainCursorToCell(cell, ctx.cmView);
		this.scheduleActivation(ctx);
		return true;
	}

	private scheduleActivation(ctx: ActiveContext, attempt = 0): void {
		if (this.deferredActivation !== null) {
			if (this.deferredView === ctx.cmView) return;
			this.cancelDeferredActivation();
		}

		this.deferredView = ctx.cmView;
		this.deferredActivation = window.setTimeout(() => {
			this.deferredActivation = null;
			const view = this.deferredView;
			this.deferredView = null;
			if (this.state !== "inactive" || !view) return;

			const fresh = this.getContext();
			if (!fresh || fresh.cmView !== view || !this.mainVimIdle(fresh)) {
				return;
			}
			// Obsidian may create the cell editor a little later than the
			// selection change. Retry briefly instead of dropping the entry.
			if (!this.tryEnter(fresh) && attempt < 3) {
				this.scheduleActivation(fresh, attempt + 1);
			}
		}, ENTRY_DEBOUNCE_MS);
	}

	private cancelDeferredActivation(): void {
		if (this.deferredActivation !== null) {
			window.clearTimeout(this.deferredActivation);
		}
		this.deferredActivation = null;
		this.deferredView = null;
	}

	private tryEnter(ctx: ActiveContext): boolean {
		const active = this.findActiveTable(ctx);
		if (!active) return false;

		this.hideCellEditor(active.cell);
		this.state = "nav";
		this.view = ctx.cmView;
		this.widgetEl = active.widgetEl;
		this.tableFrom = active.range.from;
		this.row = active.row;
		this.col = active.col;
		this.countBuffer = "";
		this.gPending = false;
		this.entryMode = null;
		this.entryKeys = [];

		active.widgetEl.classList.add(NAV_CLASS);
		this.highlightCell(active.table);
		this.focusMainEditor(ctx.cmView);
		this.onStateChange();
		return true;
	}

	private sessionValid(ctx: ActiveContext): boolean {
		if (ctx.cmView !== this.view) return false;
		if (!this.freshWidgetEl()) return false;
		return findTableRanges(ctx.cmView.state).some(
			(table) =>
				table.from === this.tableFrom && cursorInTable(ctx, table)
		);
	}

	private handleNavKey(event: KeyboardEvent, ctx: ActiveContext): boolean {
		if (event.ctrlKey || event.altKey || event.metaKey) return false;

		if (/^[1-9]$/.test(event.key) || (this.countBuffer && event.key === "0")) {
			this.countBuffer += event.key;
			return true;
		}
		const count = this.consumeCount();

		// Plain characters are swallowed below to protect the hidden cell
		// editor, so Vim's `gg`/`G` never reach it. Handle them as table-local
		// motions: first row / last row.
		if (event.key === "g" || event.key === "G") {
			if (event.key === "G") {
				this.gPending = false;
				this.jumpToRow("last");
			} else if (this.gPending) {
				this.gPending = false;
				this.jumpToRow("first");
			} else {
				this.gPending = true;
			}
			return true;
		}
		this.gPending = false;

		if (event.key === "Escape") {
			this.exitTable("before");
			return true;
		}
		if (event.key === "Tab") {
			this.navigate(event.shiftKey ? "h" : "l", count, true);
			return true;
		}

		const direction = DIRECTION_KEYS[event.key];
		if (direction) {
			this.navigate(direction, count, false);
			return true;
		}

		switch (event.key) {
			case "0":
				this.moveToCell(this.row, 0);
				return true;
			case "^":
				this.moveToCell(this.row, this.firstNonBlankColumn());
				return true;
			case "$":
				this.moveToCell(this.row, Number.MAX_SAFE_INTEGER);
				return true;
			case "H":
			case "M":
			case "L":
				this.moveToWindowRow(event.key);
				return true;
			case "i":
				this.enterCellEdit("insert", ctx);
				return true;
			case "a":
				this.enterCellEdit("insert-append", ctx);
				return true;
			case "c":
				this.enterCellEdit("change", ctx);
				return true;
			case "s":
				this.enterCellEdit("substitute", ctx);
				return true;
			case "Enter":
				this.enterCellEdit("normal", ctx);
				return true;
			default:
				// The hidden cell editor is still connected. Any typed key must
				// be swallowed, or it would land in the Markdown source.
				return typesIntoCell(event);
		}
	}

	private handleEditKey(event: KeyboardEvent): boolean {
		// Keys typed while the cell editor is opening must be replayed after
		// the entry key; otherwise `iq` starts a macro instead of typing `q`.
		if (this.entryMode !== null) {
			const held = heldEntryKey(event);
			if (held) this.entryKeys.push(held);
			return true;
		}

		const cell = this.currentCell();
		const adapter = cell ? this.cellAdapter(cell) : null;

		if (event.key === "Escape") {
			if (adapter && !this.cellVimIdle(adapter)) {
				this.vim.send(adapter, "<Esc>");
				return true;
			}
			this.exitCellEditToNav();
			return true;
		}

		if (event.ctrlKey || event.altKey || event.metaKey) return false;

		if (event.key === "Tab") {
			if (adapter && !this.cellVimIdle(adapter)) return false;
			this.exitCellEditToNav();
			this.navigate(event.shiftKey ? "h" : "l", 1, true);
			return true;
		}

		const direction = DIRECTION_KEYS[event.key];
		if (direction) {
			if (adapter && !this.cellVimIdle(adapter)) return false;
			if (adapter && !this.atCellBoundary(adapter, direction)) return false;
			this.exitCellEditToNav();
			this.navigate(direction, 1, false);
			return true;
		}

		return false;
	}

	// ---- movement ---------------------------------------------------------

	private navigate(
		direction: Direction,
		count: number,
		wrap: boolean
	): void {
		if (this.state !== "nav" || !this.view) return;
		const table = this.currentTable();
		if (!table) return;

		const rowCount = table.rows?.length ?? 0;
		const colCount = table.rows?.[0]?.length ?? 0;
		if (rowCount === 0 || colCount === 0) return;

		for (let step = 0; step < count; step += 1) {
			if (direction === "h") {
				if (this.col > 0) this.col -= 1;
				else if (wrap && this.row > 0) {
					this.row -= 1;
					this.col = colCount - 1;
				} else break;
			} else if (direction === "l") {
				if (this.col < colCount - 1) this.col += 1;
				else if (wrap && this.row < rowCount - 1) {
					this.row += 1;
					this.col = 0;
				} else break;
			} else if (direction === "j") {
				if (this.row >= rowCount - 1) {
					this.exitTable("after");
					return;
				}
				this.row += 1;
			} else {
				if (this.row <= 0) {
					this.exitTable("before");
					return;
				}
				this.row -= 1;
			}
		}

		// The visual highlight is not enough: Obsidian keeps its own cell
		// editor at the cell where the table was entered. Move that editor to
		// the highlighted cell now so mode keys act on the right cell instead
		// of the entry cell.
		this.syncNativeCellFocus(this.row, this.col);
		const fresh = this.currentTable() ?? table;
		this.highlightCell(fresh);
		this.scrollCellIntoView(fresh);
	}

	/** Move the highlight and the hidden cell editor to one cell. */
	private moveToCell(row: number, col: number): void {
		if (this.state !== "nav" || !this.view) return;
		const table = this.currentTable();
		if (!table) return;
		const rowCount = table.rows?.length ?? 0;
		const colCount = table.rows?.[0]?.length ?? 0;
		if (rowCount === 0 || colCount === 0) return;
		this.row = Math.max(0, Math.min(rowCount - 1, row));
		this.col = Math.max(0, Math.min(colCount - 1, col));
		this.syncNativeCellFocus(this.row, this.col);
		const fresh = this.currentTable() ?? table;
		this.highlightCell(fresh);
		this.scrollCellIntoView(fresh);
	}

	/** Table-local `gg` / `G`: jump to the first / last row. */
	private jumpToRow(edge: "first" | "last"): void {
		const rowCount = this.currentTable()?.rows?.length ?? 0;
		this.moveToCell(edge === "first" ? 0 : rowCount - 1, this.col);
	}

	/** Table-local `^`: first cell in the row with visible text. */
	private firstNonBlankColumn(): number {
		const table = this.currentTable();
		if (!table) return 0;
		const colCount = table.rows?.[this.row]?.length ?? 0;
		for (let col = 0; col < colCount; col += 1) {
			const text = table.getCellAt(this.row, col)?.el?.textContent?.trim() ?? "";
			if (text.length > 0) return col;
		}
		return 0;
	}

	/** Rows currently inside the editor viewport, for `H` / `M` / `L`. */
	private visibleRows(table: TableEditorLike): number[] {
		if (!this.view) return [];
		const viewport = this.view.scrollDOM.getBoundingClientRect();
		const rows: number[] = [];
		const rowCount = table.rows?.length ?? 0;
		for (let row = 0; row < rowCount; row += 1) {
			const el = table.getCellAt(row, 0)?.el;
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
				rows.push(row);
			}
		}
		return rows;
	}

	/** Table-local `H` / `M` / `L`: top / middle / bottom visible row. */
	private moveToWindowRow(which: "H" | "M" | "L"): void {
		const table = this.currentTable();
		if (!table) return;
		const rows = this.visibleRows(table);
		if (rows.length === 0) {
			const rowCount = table.rows?.length ?? 0;
			const fallback =
				which === "H"
					? 0
					: which === "L"
						? rowCount - 1
						: Math.floor((rowCount - 1) / 2);
			this.moveToCell(fallback, this.col);
			return;
		}
		const index =
			which === "H"
				? 0
				: which === "L"
					? rows.length - 1
					: Math.floor((rows.length - 1) / 2);
		this.moveToCell(rows[index], this.col);
	}

	/**
	 * Keep Obsidian's hidden cell editor on the highlighted cell.
	 *
	 * Without this, navigation only moves our own highlight. The real cursor
	 * used by `i`/`a`/`c`/`s`/`Enter` stays at the cell where the table was
	 * entered, so those modes open on the wrong cell.
	 */
	private syncNativeCellFocus(row: number, col: number): void {
		this.moveNativeCellTo(row, col);
		this.hideCellEditor(this.currentCell());
		if (this.view) this.focusMainEditor(this.view);
	}

	/**
	 * Switch Obsidian's real cell editor and cursor to `row`/`col`.
	 *
	 * `cell.table` is authoritative: the object cached on the widget can be a
	 * stale duplicate after Obsidian re-renders a table. Try the native focus
	 * paths in order and verify `editMode.tableCell` after each one.
	 */
	private moveNativeCellTo(row: number, col: number): boolean {
		if (this.cellMatches(row, col)) return true;

		const current = this.currentCell();
		const table = current?.cell.table ?? this.currentTable();
		const targetCell = table?.getCellAt(row, col) ?? null;
		const editMode = this.editMode();

		// Moving the main cursor into the target cell's source range is the
		// most direct route: Obsidian's own selection handler then opens the
		// cell editor at that cell.
		this.moveMainCursorToCell(targetCell);
		if (this.cellMatches(row, col)) return true;

		try {
			table?.receiveCellFocus?.(row, col);
		} catch {
			// Try the direct editor path below.
		}
		if (!this.cellMatches(row, col) && table && targetCell && editMode) {
			try {
				editMode.editTableCell?.(table, targetCell);
			} catch {
				// Try the setter path below.
			}
		}
		if (!this.cellMatches(row, col)) {
			try {
				table?.setCellFocus?.(row, col);
			} catch {
				// Keep whatever cell editor is active.
			}
		}
		return this.cellMatches(row, col);
	}

	/** Put the main cursor inside the highlighted cell's source range. */
	private moveMainCursorToCell(
		cell: TableCellLike | null,
		view: EditorView | null = this.view
	): void {
		if (!cell || !view) return;
		const offsets = cell.getAbsoluteOffsets?.();
		if (!offsets) return;
		let pos = offsets.textStart;
		if (!Number.isFinite(pos) || pos < offsets.start || pos > offsets.end) {
			pos = offsets.start;
		}
		pos = Math.max(0, Math.min(pos, view.state.doc.length));
		view.dispatch({
			selection: EditorSelection.single(pos),
			scrollIntoView: false,
		});
	}

	private cellMatches(row: number, col: number): boolean {
		const cell = this.currentCell();
		return !!cell && cell.cell.row === row && cell.cell.col === col;
	}

	// ---- cell editor handoff ---------------------------------------------

	private enterCellEdit(mode: TableEntryMode, ctx: ActiveContext): void {
		const active = this.findActiveTable(ctx);
		if (!active) {
			this.exitTable("before");
			return;
		}

		const table = active.cell.cell.table ?? active.table;
		const highlighted = this.highlightedCell;
		const targetCell =
			highlighted &&
			highlighted.row === this.row &&
			highlighted.col === this.col
				? highlighted
				: table.getCellAt(this.row, this.col);
		const targetTable = targetCell?.table ?? table;

		// Do this synchronously, before the cell editor is revealed and the
		// deferred mode key is sent. Navigation keeps the editor synced, but a
		// table rebuild between the last move and this key can still leave it
		// behind.
		this.moveNativeCellTo(this.row, this.col);

		const current = this.currentCell();
		const editor = current ?? active.cell;
		this.removeHighlight();
		this.freshWidgetEl()?.classList.remove(NAV_CLASS);
		this.showCellEditor(editor);

		this.state = "edit";
		this.entryMode = mode;
		this.entryKeys = [];
		this.countBuffer = "";
		this.gPending = false;
		this.entryTarget = {
			row: this.row,
			col: this.col,
			cell: targetCell ?? editor.cell,
			table: targetTable,
		};
		this.entryAttempts = 0;

		this.clearEntryTimer();
		this.scheduleCellEditFinish();
		this.onStateChange();
	}

	private scheduleCellEditFinish(): void {
		this.entryTimer = window.setTimeout(
			() => this.finishCellEditEntry(),
			ENTRY_DELAY_MS
		);
	}

	/**
	 * Final guard before sending a mode key. Navigation already keeps the
	 * native editor on the highlighted cell; this only recovers from a table
	 * rebuild that happened between the last move and the mode key.
	 */
	private ensureEntryCell(): boolean {
		const target = this.entryTarget;
		if (!target) return true;

		if (this.cellMatches(target.row, target.col)) {
			this.entryTarget = null;
			return true;
		}
		if (this.entryAttempts >= 2) {
			this.entryTarget = null;
			return true;
		}

		this.entryAttempts += 1;
		this.moveNativeCellTo(target.row, target.col);
		if (this.cellMatches(target.row, target.col)) {
			this.entryTarget = null;
			return true;
		}
		this.scheduleCellEditFinish();
		return false;
	}

	private finishCellEditEntry(): void {
		this.entryTimer = null;
		if (this.state !== "edit" || !this.ensureEntryCell()) return;

		const mode = this.entryMode ?? "normal";
		const held = this.entryKeys;
		this.entryMode = null;
		this.entryKeys = [];

		const cell = this.currentCell();
		const cellView = cell?.cm as EditorView | undefined;
		if (!cellView) return;

		cellView.focus();
		cellView.contentDOM?.click();

		const adapter = cell ? this.cellAdapter(cell) : null;
		if (!adapter) {
			if (mode !== "normal") this.insertFallback(cellView, held);
			return;
		}

		const entryKey: Record<TableEntryMode, string | null> = {
			insert: "i",
			"insert-append": "A",
			change: "cc",
			substitute: "S",
			normal: null,
		};
		const first = entryKey[mode];
		if (first) this.vim.send(adapter, first);

		for (const key of held) {
			if (this.vim.send(adapter, key)) continue;
			if (mode === "normal") continue;
			if (key.length === 1) {
				adapter.replaceSelection?.(key);
			} else if (key === "<BS>") {
				const at = adapter.getCursor?.();
				if (at && at.ch > 0) {
					adapter.replaceRange?.(
						"",
						{ line: at.line, ch: at.ch - 1 },
						at
					);
				}
			}
		}
	}

	private exitCellEditToNav(): void {
		if (this.state !== "edit") return;
		this.clearEntryTimer();
		this.entryMode = null;
		this.entryKeys = [];
		this.countBuffer = "";
		this.gPending = false;

		const cell = this.currentCell();
		if (cell) {
			this.row = cell.cell.row;
			this.col = cell.cell.col;
		}
		this.showCellEditor(cell);

		this.state = "nav";
		this.widgetEl?.classList.add(NAV_CLASS);
		this.highlightCell(this.currentTable());
		if (this.view) this.focusMainEditor(this.view);
		this.onStateChange();
	}

	private insertFallback(view: EditorView, keys: readonly string[]): void {
		let pos = view.state.selection.main.head;
		for (const key of keys) {
			if (key.length !== 1) continue;
			view.dispatch({
				changes: { from: pos, insert: key },
				selection: { anchor: pos + key.length },
			});
			pos += key.length;
		}
	}

	// ---- table lookup -----------------------------------------------------

	private findActiveTable(ctx: ActiveContext): ActiveTable | null {
		const editMode = this.editMode();
		const cell = editMode?.tableCell;
		if (!editMode || !cell) return null;

		const range = findTableRanges(ctx.cmView.state).find((table) =>
			cursorInRange(ctx, table)
		);
		if (!range || range.lines.length < 3) return null;

		const widgetEl = findTableWidgetElement(ctx.cmView, range.from);
		if (!widgetEl) return null;
		const table = tableEditorFromWidget(widgetEl);
		if (!table) return null;

		const row = cell.cell?.row;
		const col = cell.cell?.col;
		if (
			typeof row !== "number" ||
			typeof col !== "number" ||
			!Number.isInteger(row) ||
			!Number.isInteger(col) ||
			row < 0 ||
			col < 0
		) {
			return null;
		}

		return {
			editMode,
			cell,
			range,
			widgetEl,
			table,
			row,
			col,
		};
	}

	private editMode(): EditViewLike | null {
		// Resolve the edit mode from the view that owns this editor, so a split
		// pane or a focus change cannot make us switch cells in the wrong note.
		let owner: { editMode?: EditViewLike } | null = null;
		if (this.view) {
			try {
				const info = this.view.state.field(editorInfoField) as unknown as {
					editMode?: EditViewLike;
				} | null;
				if (info?.editMode) owner = info;
			} catch {
				// Fall back to the active Markdown view below.
			}
		}
		if (!owner) {
			owner = this.app.workspace.getActiveViewOfType(MarkdownView) as
				| { editMode?: EditViewLike }
				| null;
		}
		const editMode = owner?.editMode;
		if (!editMode || typeof editMode.editTableCell !== "function") return null;
		return editMode;
	}

	private currentCell(): TableCellRef | null {
		return this.editMode()?.tableCell ?? null;
	}

	private currentTable(): TableEditorLike | null {
		// The table attached to the live cell is the one Obsidian's edit mode
		// actually uses. The widget's cmTile can be a stale duplicate after a
		// table re-render.
		const cellTable = this.currentCell()?.cell.table;
		if (cellTable) return cellTable;
		const widgetEl = this.freshWidgetEl();
		return widgetEl ? tableEditorFromWidget(widgetEl) : null;
	}

	/** Re-find the table widget when Obsidian rebuilds it during navigation. */
	private freshWidgetEl(): HTMLElement | null {
		if (this.widgetEl?.isConnected) return this.widgetEl;
		if (!this.view || !this.tableFrom) return null;
		const widgetEl = findTableWidgetElement(this.view, this.tableFrom);
		if (widgetEl) this.widgetEl = widgetEl;
		return widgetEl;
	}

	private cellAdapter(cell: TableCellRef): CellVimAdapter | null {
		const view = cell.cm as (EditorView & { cm?: CellVimAdapter }) | null;
		return view?.cm ?? null;
	}

	private cellVimIdle(adapter: CellVimAdapter): boolean {
		return (
			this.vim.mode(adapter) === "normal" &&
			!this.vim.hasPendingInput(adapter)
		);
	}

	private atCellBoundary(adapter: CellVimAdapter, direction: Direction): boolean {
		const head = adapter.getCursor?.();
		if (!head) return false;
		if (direction === "h") return head.ch <= 0;
		if (direction === "l") {
			return head.ch >= (adapter.getLine(head.line)?.length ?? 0) - 1;
		}
		if (direction === "j") return head.line >= (adapter.lastLine?.() ?? head.line);
		return head.line <= (adapter.firstLine?.() ?? head.line);
	}

	// ---- visual state and cleanup ----------------------------------------

	private highlightCell(table: TableEditorLike | null): void {
		this.removeHighlight();
		if (!table) return;
		const cell = table.getCellAt(this.row, this.col);
		if (!cell) return;
		this.highlightedCell = cell;
		const el = cell.el;
		if (!el) return;
		el.classList.add(ACTIVE_CLASS);
		this.highlightedEl = el;
	}

	private removeHighlight(): void {
		this.highlightedEl?.classList.remove(ACTIVE_CLASS);
		this.highlightedEl = null;
		this.highlightedCell = null;
	}

	private scrollCellIntoView(table: TableEditorLike): void {
		if (!this.view) return;
		const cell = table.getCellAt(this.row, this.col)?.el;
		if (!cell) return;

		const scroller = this.view.scrollDOM;
		const cellRect = cell.getBoundingClientRect();
		const scrollerRect = scroller.getBoundingClientRect();
		const margin = Math.max(5, this.getScrolloff() * this.view.defaultLineHeight);

		let dy = 0;
		if (cellRect.top < scrollerRect.top + margin) {
			dy = cellRect.top - scrollerRect.top - margin;
		} else if (cellRect.bottom > scrollerRect.bottom - margin) {
			dy = cellRect.bottom - scrollerRect.bottom + margin;
		}
		if (dy) scroller.scrollTop += dy;

		if (this.widgetEl && this.widgetEl.scrollWidth > this.widgetEl.clientWidth) {
			const widgetRect = this.widgetEl.getBoundingClientRect();
			let dx = 0;
			if (cellRect.left < widgetRect.left + 5) {
				dx = cellRect.left - widgetRect.left - 5;
			} else if (cellRect.right > widgetRect.right - 5) {
				dx = cellRect.right - widgetRect.right + 5;
			}
			if (dx) this.widgetEl.scrollLeft += dx;
		}
	}

	private hideCellEditor(cell: TableCellRef | null): void {
		this.hiddenEl?.classList.remove(HIDDEN_CLASS);
		this.hiddenEl = null;
		if (!cell) return;
		const view = cell.cm as EditorView | undefined;
		const target = view?.dom ?? cell.cell.el;
		if (!target) return;
		target.classList.add(HIDDEN_CLASS);
		this.hiddenEl = target;
	}

	private showCellEditor(cell: TableCellRef | null): void {
		this.hiddenEl?.classList.remove(HIDDEN_CLASS);
		this.hiddenEl = null;
		if (!cell) return;
		const view = cell.cm as EditorView | undefined;
		const target = view?.dom ?? cell.cell.el;
		target?.classList.remove(HIDDEN_CLASS);
	}

	private focusMainEditor(view: EditorView): void {
		const top = view.scrollDOM.scrollTop;
		view.contentDOM.focus({ preventScroll: true });
		view.scrollDOM.scrollTop = top;
	}

	private exitTable(placement: Placement | null): void {
		this.cancelDeferredActivation();
		if (this.state === "inactive" && !this.hiddenEl) return;

		const wasActive = this.state !== "inactive";
		const view = this.view;
		const table = this.currentTable();
		const widgetEl = this.widgetEl;
		const tableRange = view
			? findTableRanges(view.state).find((t) => t.from === this.tableFrom)
			: null;

		this.clearEntryTimer();
		this.entryMode = null;
		this.entryKeys = [];
		this.countBuffer = "";
		this.gPending = false;
		this.removeHighlight();
		widgetEl?.classList.remove(NAV_CLASS);
		this.showCellEditor(this.currentCell());

		this.state = "inactive";
		this.view = null;
		this.widgetEl = null;
		this.tableFrom = 0;
		if (wasActive) this.onStateChange();

		if (!view) return;
		this.focusMainEditor(view);

		if (!placement) return;
		const editMode = this.editMode();
		editMode?.destroyTableCell?.();

		window.requestAnimationFrame(() => {
			if (placement === "before" && tableRange) {
				// Skip the blank separator Obsidian keeps above a table.
				const pos = cursorPosBeforeTable(view.state, tableRange.from);
				view.dispatch({
					selection: EditorSelection.single(pos),
					effects: EditorView.scrollIntoView(pos, { y: "nearest" }),
				});
			} else if (table?.placeCursorAround) {
				table.placeCursorAround(placement);
			} else if (tableRange) {
				const pos = Math.min(view.state.doc.length, tableRange.to + 1);
				view.dispatch({
					selection: EditorSelection.single(pos),
					effects: EditorView.scrollIntoView(pos, { y: "nearest" }),
				});
			}
			view.focus();
		});
	}

	private clearEntryTimer(): void {
		if (this.entryTimer === null) return;
		window.clearTimeout(this.entryTimer);
		this.entryTimer = null;
	}

	private consumeCount(): number {
		if (!this.countBuffer) return 1;
		const parsed = Number.parseInt(this.countBuffer, 10);
		this.countBuffer = "";
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
	}
}

// ---- helpers -------------------------------------------------------------

/** True when every line in [fromLine, toLine) is blank (or there are none). */
function blankLinesBetween(
	state: EditorState,
	fromLine: number,
	toLine: number
): boolean {
	if (fromLine > toLine) return false;
	for (let line = fromLine; line < toLine; line += 1) {
		if (state.doc.line(line).text.trim().length !== 0) return false;
	}
	return true;
}

/** Position of the last real line above a table, skipping blank separators. */
function cursorPosBeforeTable(state: EditorState, tableFrom: number): number {
	const startLine = state.doc.lineAt(tableFrom).number;
	if (startLine <= 1) return 0;
	let line = startLine - 1;
	while (line > 1 && state.doc.line(line).text.trim().length === 0) {
		line -= 1;
	}
	return state.doc.line(line).to;
}

function cursorInRange(ctx: ActiveContext, table: TableRange): boolean {
	return ctx.cmView.state.selection.ranges.some(
		(range) => range.from <= table.to && range.to >= table.from
	);
}

function cursorInTable(ctx: ActiveContext, table: TableRange): boolean {
	const head = ctx.cmView.state.selection.main.head;
	return head >= table.from && head <= table.to;
}

function findTableRanges(state: EditorState): TableRange[] {
	const doc = state.doc;
	const ranges: TableRange[] = [];
	let lineNo = 1;
	while (lineNo <= doc.lines) {
		const line = doc.line(lineNo);
		if (!TABLE_RE.test(line.text)) {
			lineNo += 1;
			continue;
		}
		const start = lineNo;
		const lines = [line.text];
		lineNo += 1;
		while (lineNo <= doc.lines) {
			const next = doc.line(lineNo);
			if (!TABLE_RE.test(next.text)) break;
			lines.push(next.text);
			lineNo += 1;
		}
		if (lines.length >= 2) {
			ranges.push({
				from: doc.line(start).from,
				to: doc.line(start + lines.length - 1).to,
				lines,
			});
		}
	}
	return ranges;
}

function findTableWidgetElement(
	view: EditorView,
	tableFrom: number
): HTMLElement | null {
	const widgets = Array.from(
		view.dom.querySelectorAll<HTMLElement>(".cm-table-widget")
	);
	if (widgets.length === 0) return null;
	if (widgets.length === 1) return widgets[0];

	let best: HTMLElement | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const widget of widgets) {
		try {
			const pos = view.posAtDOM(widget, 0);
			const distance = Math.abs(pos - tableFrom);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = widget;
			}
		} catch {
			// Detached or offscreen widget.
		}
	}
	return best;
}

function tableEditorFromWidget(widgetEl: HTMLElement): TableEditorLike | null {
	const cmTile = (widgetEl as unknown as { cmTile?: { widget?: unknown } })
		.cmTile;
	const widget = cmTile?.widget as TableEditorLike | undefined;
	return widget && typeof widget.getCellAt === "function" ? widget : null;
}

function typesIntoCell(event: KeyboardEvent): boolean {
	if (event.ctrlKey || event.metaKey || event.altKey) return false;
	return event.key.length === 1 || event.key === "Backspace" || event.key === "Delete";
}

function heldEntryKey(event: KeyboardEvent): string | null {
	if (event.ctrlKey || event.metaKey || event.altKey) return null;
	if (event.key.length === 1) return event.key;
	if (event.key === "Escape") return "<Esc>";
	if (event.key === "Backspace") return "<BS>";
	if (event.key === "Delete") return "<Del>";
	return null;
}
