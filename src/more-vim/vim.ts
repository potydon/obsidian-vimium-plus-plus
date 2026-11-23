import { EditorSelection, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { tableAwareDisplayMotion } from "./display-line";

/** Vim modes we care about, normalized from the adapter's raw mode string. */
export type VimMode = "normal" | "visual" | "insert" | "replace";

/** A cursor position in CodeMirror's CM5-compatible Vim adapter. */
export interface VimPos {
	line: number;
	ch: number;
}

/** Arguments passed to a Vim motion. */
export interface MotionArgs {
	repeat: number;
	forward?: boolean;
	linewise?: boolean;
	[key: string]: unknown;
}

/** Motion function signature used by `getMotion`/`defineMotion`. */
export type MotionFn = (
	cm: VimAdapter,
	head: VimPos,
	args: MotionArgs,
	state: unknown,
	inputState: unknown
) => VimPos | [VimPos, VimPos] | Promise<VimPos | null> | null | undefined;

/** The minimal shape of a Vim register that the system-clipboard register needs. */
export interface VimRegister {
	keyBuffer: string[];
	insertModeChanges: unknown[];
	searchQueries: string[];
	linewise: boolean;
	blockwise: boolean;
	setText(text: string, linewise?: boolean, blockwise?: boolean): void;
	pushText(text: string, linewise?: boolean): void;
	clear(): void;
	pushInsertModeChanges(changes: unknown): void;
	pushSearchQuery(query: string): void;
	toString(): string;
}

/** Vim's register controller, reached through the live adapter namespace. */
export interface RegisterController {
	unnamedRegister: VimRegister | null;
	registers: Record<string, VimRegister>;
}

/** The CM5-flavoured adapter Obsidian attaches to each CodeMirror 6 editor. */
export interface VimAdapter {
	state: {
		vim?: {
			mode?: string;
			inputState?: {
				keyBuffer?: string[];
				operator?: string | null;
				motion?: string | null;
			};
		};
	};
	/** The Vim namespace is hung off the adapter constructor at runtime. */
	constructor: { Vim?: VimNamespace };
	getLine(n: number): string;
	lineCount(): number;
}

/** Untyped surface of `@replit/codemirror-vim` used by the enhancements. */
export interface VimNamespace {
	handleKey(cm: VimAdapter, keys: string, origin: string): boolean | void;
	defineAction(name: string, fn: (cm: VimAdapter) => void): void;
	mapCommand(
		keys: string,
		type: string,
		name: string,
		args: Record<string, unknown>,
		options: { context: string }
	): void;
	getRegisterController(): RegisterController | undefined;
	getMotion?(name: string): MotionFn | undefined;
	defineMotion?(name: string, fn: MotionFn): void;
	noremap?(lhs: string, rhs: string, context?: string): void;
	unmap?(lhs: string, context?: string): boolean;
}

/** Wrapper around the live Vim adapter; no bundled copy of the Vim engine. */
export class Vim {
	private namespace: VimNamespace | undefined;
	private displayMappingApplied = false;
	private displayMotionApplied = false;
	private originalDisplayMotion: MotionFn | undefined;
	private originalLineMotion: MotionFn | undefined;

	init(adapter: VimAdapter): boolean {
		this.namespace = adapter.constructor?.Vim;
		return this.namespace != null;
	}

	isReady(): boolean {
		return this.namespace != null;
	}

	mode(adapter: VimAdapter): VimMode {
		const raw = adapter.state.vim?.mode;
		if (raw?.startsWith("visual")) return "visual";
		if (raw === "insert" || raw === "replace") return raw;
		return "normal";
	}

	hasPendingInput(adapter: VimAdapter): boolean {
		const input = adapter.state.vim?.inputState;
		if (input?.operator != null || input?.motion != null) return true;
		const buffer = input?.keyBuffer;
		return buffer != null && buffer.some((key) => key !== "");
	}

	send(adapter: VimAdapter, keys: string): boolean {
		return Boolean(this.namespace?.handleKey(adapter, keys, "user"));
	}

	/**
	 * Install or remove the native j/k display-line mappings. This mirrors
	 * vimrc-support's `nmap j gj` path: the mapping lives in CodeMirror's Vim
	 * keymap, so Vim handles counts and pending prefixes itself.
	 */
	applyDisplayLineMotion(enabled: boolean): void {
		const vim = this.globalNamespace() ?? this.namespace;
		if (!vim) return;

		if (!enabled) {
			if (this.displayMappingApplied) {
				vim.unmap?.("j", "normal");
				vim.unmap?.("k", "normal");
				this.displayMappingApplied = false;
			}
			if (this.displayMotionApplied && this.originalDisplayMotion) {
				vim.defineMotion?.("moveByDisplayLines", this.originalDisplayMotion);
				this.originalDisplayMotion = undefined;
				this.originalLineMotion = undefined;
				this.displayMotionApplied = false;
			}
			return;
		}

		if (
			!this.displayMotionApplied &&
			vim.getMotion &&
			vim.defineMotion
		) {
			const display = vim.getMotion("moveByDisplayLines");
			if (display) {
				this.originalDisplayMotion = display;
				this.originalLineMotion = vim.getMotion("moveByLines");
				vim.defineMotion(
					"moveByDisplayLines",
					tableAwareDisplayMotion(display, this.originalLineMotion)
				);
				this.displayMotionApplied = true;
			}
		}

		if (!this.displayMappingApplied && vim.noremap) {
			vim.noremap("j", "gj", "normal");
			vim.noremap("k", "gk", "normal");
			this.displayMappingApplied = true;
		}
	}

	/** `window.CodeMirrorAdapter.Vim` is vimrc-support's canonical entry point. */
	private globalNamespace(): VimNamespace | undefined {
		return (
			window as unknown as {
				CodeMirrorAdapter?: { Vim?: VimNamespace };
			}
		).CodeMirrorAdapter?.Vim;
	}

	defineCommand(opts: {
		name: string;
		keys: string;
		fn: (cm: VimAdapter) => void;
	}): void {
		if (!this.namespace) return;
		this.namespace.defineAction(opts.name, opts.fn);
		this.namespace.mapCommand(
			opts.keys,
			"action",
			opts.name,
			{},
			{ context: "normal" }
		);
	}

	getRegisterController(): RegisterController | undefined {
		return this.namespace?.getRegisterController();
	}

	/** Use Vim's own `viw`/`vaw` handling to find a word text object. */
	textObjectRange(
		view: EditorView,
		adapter: VimAdapter,
		scope: "i" | "a",
		target: "w" | "W"
	): [number, number] | undefined {
		const original = view.state.selection.main.head;
		this.send(adapter, "v");
		this.send(adapter, scope);
		this.send(adapter, target);
		const selection = view.state.selection.main;
		const from = Math.min(selection.anchor, selection.head);
		const to = Math.max(selection.anchor, selection.head);
		this.send(adapter, "<Esc>");
		view.dispatch({ selection: { anchor: original } });
		return from === to ? undefined : [from, to];
	}

	/** Run a key once per selection, then rebuild the multi-cursor selection. */
	perCursor(
		view: EditorView,
		adapter: VimAdapter,
		fn: () => void
	): void {
		const oldRanges = view.state.selection.ranges;
		const newRanges: SelectionRange[] = [];
		for (const range of oldRanges) {
			view.dispatch({ selection: EditorSelection.single(range.head) });
			fn();
			const main = view.state.selection.main;
			newRanges.push(EditorSelection.range(main.anchor, main.head));
		}
		view.dispatch({
			selection: EditorSelection.create(newRanges, newRanges.length - 1),
		});
	}
}
