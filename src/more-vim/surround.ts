import { EditorView } from "@codemirror/view";
import type { ActiveContext } from "./context";

type Pair = [string, string];

const PAIRS: Record<string, Pair> = {
	"(": ["(", ")"],
	")": ["(", ")"],
	"[": ["[", "]"],
	"]": ["[", "]"],
	"{": ["{", "}"],
	"}": ["{", "}"],
	"<": ["<", ">"],
	">": ["<", ">"],
	'"': ['"', '"'],
	"'": ["'", "'"],
	"`": ["`", "`"],
	"*": ["*", "*"],
	_: ["_", "_"],
	"~": ["~", "~"],
};

const ALIASES: Record<string, string> = { b: "(", B: "{", r: "[" };
const BRACKETS: Record<string, string> = {
	"(": ")",
	"[": "]",
	"{": "}",
	"<": ">",
};

const normalizePair = (key: string): string => ALIASES[key] ?? key;
const isPair = (key: string): boolean =>
	Object.prototype.hasOwnProperty.call(PAIRS, normalizePair(key));

type State =
	| { kind: "idle" }
	| { kind: "op"; op: "y" | "d" | "c" }
	| { kind: "ys" }
	| { kind: "ysi" }
	| { kind: "ysa" }
	| { kind: "wrap"; from: number; to: number }
	| { kind: "ds" }
	| { kind: "cs" }
	| { kind: "csOld"; old: string }
	| { kind: "vS" };

type Effect =
	| { kind: "wrap"; from: number; to: number; ch: string }
	| { kind: "deletePair"; from: number; to: number }
	| { kind: "changePair"; from: number; to: number; ch: string }
	| { kind: "replayKeys"; keys: string[] }
	| { kind: "escapeAndWrap"; from: number; to: number; ch: string };

const IDLE: State = { kind: "idle" };

/**
 * Vim surround state machine. `ys`, `ds`, `cs` and visual `S` are handled
 * before Vim sees the keys; anything else is replayed so normal operators keep
 * working.
 */
export class Surround {
	private state: State = IDLE;

	reset(): void {
		this.state = IDLE;
	}

	handle(key: string, ctx: ActiveContext, mode: "normal" | "visual"): boolean {
		if (key === "Escape") {
			this.reset();
			return false;
		}
		if (key.length !== 1) return false;

		const result = this.step(this.state, key, mode, ctx);
		this.state = result.next;
		if (result.effect) this.apply(ctx, result.effect);
		return result.handled;
	}

	private step(
		state: State,
		key: string,
		mode: "normal" | "visual",
		ctx: ActiveContext
	): { next: State; handled: boolean; effect?: Effect } {
		const view = ctx.cmView;
		switch (state.kind) {
			case "idle":
				if (mode === "normal" && (key === "y" || key === "d" || key === "c")) {
					return { next: { kind: "op", op: key }, handled: true };
				}
				if (mode === "visual" && key === "S") {
					return { next: { kind: "vS" }, handled: true };
				}
				return { next: state, handled: false };

			case "op":
				if (key === "s") {
					if (state.op === "y") return { next: { kind: "ys" }, handled: true };
					if (state.op === "d") return { next: { kind: "ds" }, handled: true };
					return { next: { kind: "cs" }, handled: true };
				}
				return {
					next: IDLE,
					handled: true,
					effect: { kind: "replayKeys", keys: [state.op, key] },
				};

			case "ys":
				if (key === "s") {
					const pos = view.state.selection.main.head;
					const line = view.state.doc.lineAt(pos);
					const leading = /^\s*/.exec(line.text)?.[0].length ?? 0;
					return {
						next: { kind: "wrap", from: line.from + leading, to: line.to },
						handled: true,
					};
				}
				if (key === "i") return { next: { kind: "ysi" }, handled: true };
				if (key === "a") return { next: { kind: "ysa" }, handled: true };
				return { next: IDLE, handled: true };

			case "ysi":
			case "ysa": {
				const scope = state.kind === "ysi" ? "i" : "a";
				if (key === "w" || key === "W") {
					const range = ctx.vim.textObjectRange(view, ctx.adapter, scope, key);
					if (!range) return { next: IDLE, handled: true };
					return {
						next: { kind: "wrap", from: range[0], to: range[1] },
						handled: true,
					};
				}
				if (isPair(key)) {
					const range = findPairRange(view, normalizePair(key), view.state.selection.main.head, scope);
					if (!range) return { next: IDLE, handled: true };
					return {
						next: { kind: "wrap", from: range[0], to: range[1] },
						handled: true,
					};
				}
				return { next: IDLE, handled: true };
			}

			case "wrap":
				if (isPair(key)) {
					return {
						next: IDLE,
						handled: true,
						effect: {
							kind: "wrap",
							from: state.from,
							to: state.to,
							ch: normalizePair(key),
						},
					};
				}
				return { next: IDLE, handled: true };

			case "ds": {
				if (isPair(key)) {
					const range = findPairRange(
						view,
						normalizePair(key),
						view.state.selection.main.head,
						"a"
					);
					if (range && range[1] - range[0] >= 2) {
						return {
							next: IDLE,
							handled: true,
							effect: { kind: "deletePair", from: range[0], to: range[1] },
						};
					}
				}
				return { next: IDLE, handled: true };
			}

			case "cs":
				if (isPair(key)) {
					return { next: { kind: "csOld", old: normalizePair(key) }, handled: true };
				}
				return { next: IDLE, handled: true };

			case "csOld": {
				if (isPair(key)) {
					const range = findPairRange(
						view,
						state.old,
						view.state.selection.main.head,
						"a"
					);
					if (range && range[1] - range[0] >= 2) {
						return {
							next: IDLE,
							handled: true,
							effect: {
								kind: "changePair",
								from: range[0],
								to: range[1],
								ch: normalizePair(key),
							},
						};
					}
				}
				return { next: IDLE, handled: true };
			}

			case "vS": {
				if (isPair(key)) {
					const selection = view.state.selection.main;
					const from = Math.min(selection.anchor, selection.head);
					const to = Math.max(selection.anchor, selection.head);
					if (from !== to) {
						return {
							next: IDLE,
							handled: true,
							effect: { kind: "escapeAndWrap", from, to, ch: normalizePair(key) },
						};
					}
				}
				return { next: IDLE, handled: true };
			}
		}
	}

	private apply(ctx: ActiveContext, effect: Effect): void {
		const { cmView: view, adapter, vim } = ctx;
		switch (effect.kind) {
			case "wrap":
			case "changePair": {
				const [open, close] = PAIRS[effect.ch];
				view.dispatch({
					changes: [
						{ from: effect.to, to: effect.to, insert: close },
						{ from: effect.from, to: effect.from, insert: open },
					],
					selection: { anchor: effect.from },
				});
				return;
			}
			case "deletePair":
				view.dispatch({
					changes: [
						{ from: effect.to - 1, to: effect.to, insert: "" },
						{ from: effect.from, to: effect.from + 1, insert: "" },
					],
					selection: { anchor: effect.from },
				});
				return;
			case "replayKeys":
				for (const key of effect.keys) vim.send(adapter, key);
				return;
			case "escapeAndWrap": {
				vim.send(adapter, "<Esc>");
				const [open, close] = PAIRS[effect.ch];
				view.dispatch({
					changes: [
						{ from: effect.to, to: effect.to, insert: close },
						{ from: effect.from, to: effect.from, insert: open },
					],
					selection: { anchor: effect.from },
				});
				return;
			}
		}
	}
}

function findPairRange(
	view: EditorView,
	ch: string,
	cursor: number,
	scope: "i" | "a"
): [number, number] | undefined {
	if (Object.prototype.hasOwnProperty.call(BRACKETS, ch)) {
		return findBracketRange(view, ch, BRACKETS[ch], cursor, scope);
	}
	return findQuoteRange(view, ch, cursor, scope);
}

function findBracketRange(
	view: EditorView,
	open: string,
	close: string,
	cursor: number,
	scope: "i" | "a"
): [number, number] | undefined {
	const doc = view.state.doc.toString();
	let depth = 0;
	let openPos = -1;
	for (let i = cursor - 1; i >= 0; i--) {
		const c = doc[i];
		if (c === close) depth++;
		else if (c === open) {
			if (depth === 0) {
				openPos = i;
				break;
			}
			depth--;
		}
	}
	if (openPos === -1) {
		for (let i = cursor; i < doc.length; i++) {
			if (doc[i] === open) {
				openPos = i;
				break;
			}
		}
	}
	if (openPos === -1) return undefined;

	depth = 0;
	let closePos = -1;
	for (let i = openPos + 1; i < doc.length; i++) {
		const c = doc[i];
		if (c === open) depth++;
		else if (c === close) {
			if (depth === 0) {
				closePos = i;
				break;
			}
			depth--;
		}
	}
	if (closePos === -1) return undefined;
	return scope === "i" ? [openPos + 1, closePos] : [openPos, closePos + 1];
}

function findQuoteRange(
	view: EditorView,
	ch: string,
	cursor: number,
	scope: "i" | "a"
): [number, number] | undefined {
	const doc = view.state.doc.toString();
	const positions: number[] = [];
	for (let i = 0; i < doc.length; i++) {
		if (doc[i] === ch && (i === 0 || doc[i - 1] !== "\\")) positions.push(i);
	}
	const pairFor = (a: number, b: number): [number, number] =>
		scope === "i" ? [a + 1, b] : [a, b + 1];

	for (let i = 0; i + 1 < positions.length; i += 2) {
		if (cursor >= positions[i] && cursor <= positions[i + 1]) {
			return pairFor(positions[i], positions[i + 1]);
		}
	}
	for (let i = 0; i + 1 < positions.length; i += 2) {
		if (positions[i] >= cursor) return pairFor(positions[i], positions[i + 1]);
	}
	for (let i = positions.length - 2; i >= 0; i -= 2) {
		if (positions[i + 1] <= cursor) return pairFor(positions[i], positions[i + 1]);
	}
	return undefined;
}
