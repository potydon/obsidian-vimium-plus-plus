import type { MotionArgs, MotionFn, VimAdapter, VimPos } from "./vim";

// Same source-line rules as the table motions in resources/motions:
// src/motions/tables.ts and src/vim/table-utils.ts.
const TABLE_RE = /^\s*\|/;
const SEPARATOR_RE = /^\s*\|[\s:]*-+[\s:|-]*\|\s*$/;

/**
 * Table-aware replacement for Vim's `moveByDisplayLines` motion.
 *
 * The j/k mapping is installed natively (`j` -> `gj`, `k` -> `gk`), so Vim
 * still owns counts and pending prefixes. This wrapper only changes where the
 * `gj`/`gk` motion lands when the cursor is in a Markdown table, keeping the
 * current cell column and skipping the separator row.
 */
export function tableAwareDisplayMotion(
	display: MotionFn,
	linewise?: MotionFn
): MotionFn {
	return (cm, head, args, state, inputState) => {
		const tableTarget = tableVerticalTarget(cm, head, args);
		if (tableTarget) return tableTarget;

		// Leaving a table uses logical line motion, as does entering one.
		if (isTableLineAt(cm, head.line)) {
			const logical = callMotion(linewise, cm, head, args, state, inputState);
			if (isPos(logical)) return logical;
		}

		const displayTarget = callMotion(display, cm, head, args, state, inputState);
		if (
			isPos(displayTarget) &&
			linewise &&
			isTableLineAt(cm, displayTarget.line)
		) {
			const logical = callMotion(linewise, cm, head, args, state, inputState);
			if (isPos(logical)) return logical;
		}
		return displayTarget;
	};
}

/** Port of `tableVerticalMotion` from resources/motions/src/motions/tables.ts. */
function tableVerticalTarget(
	cm: VimAdapter,
	head: VimPos,
	args: MotionArgs
): VimPos | null {
	if (!isTableLineAt(cm, head.line)) return null;

	const lineText = cm.getLine(head.line);
	const pipeIndex = getPipeIndex(lineText, head.ch);
	const direction = args.forward === false ? -1 : 1;
	let remaining = Math.max(args.repeat || 1, 1);

	for (
		let line = head.line + direction;
		line >= 0 && line < cm.lineCount();
		line += direction
	) {
		const text = cm.getLine(line);
		if (!isTableLineAt(cm, line)) return null;
		if (SEPARATOR_RE.test(text)) continue;
		remaining -= 1;
		if (remaining === 0) {
			return { line, ch: getCellStartAtPipeIndex(text, pipeIndex) };
		}
	}
	return null;
}

/** A pipe-leading line is a table row only when it has a pipe-led neighbour. */
function isTableLineAt(cm: VimAdapter, line: number): boolean {
	if (line < 0 || line >= cm.lineCount()) return false;
	if (!TABLE_RE.test(cm.getLine(line))) return false;

	let count = 1;
	for (
		let n = line - 1;
		n >= 0 && TABLE_RE.test(cm.getLine(n));
		n -= 1
	) {
		count += 1;
	}
	for (
		let n = line + 1;
		n < cm.lineCount() && TABLE_RE.test(cm.getLine(n));
		n += 1
	) {
		count += 1;
	}
	return count >= 2;
}

function callMotion(
	fn: MotionFn | undefined,
	cm: VimAdapter,
	head: VimPos,
	args: MotionArgs,
	state: Parameters<MotionFn>[3],
	inputState: Parameters<MotionFn>[4]
): ReturnType<MotionFn> | undefined {
	return fn?.(cm, head, args, state, inputState);
}

function isPos(value: ReturnType<MotionFn> | undefined): value is VimPos {
	return (
		value != null &&
		typeof value === "object" &&
		"line" in value &&
		"ch" in value
	);
}

function getPipeIndex(line: string, ch: number): number {
	const pipes = findUnescapedPipes(line);
	let index = 0;
	for (const pos of pipes) {
		if (pos >= ch) break;
		index += 1;
	}
	return index;
}

function getCellStartAtPipeIndex(line: string, pipeIndex: number): number {
	const pipes = findUnescapedPipes(line);
	const leftPipe = pipes[pipeIndex - 1];
	if (leftPipe === undefined) return 0;
	const afterPipe = leftPipe + 1;
	const trimmed = line.substring(afterPipe).search(/\S/);
	return trimmed >= 0 ? afterPipe + trimmed : afterPipe;
}

function findUnescapedPipes(line: string): number[] {
	const positions: number[] = [];
	for (let index = 0; index < line.length; index += 1) {
		if (line[index] !== "|") continue;
		let backslashes = 0;
		for (
			let cursor = index - 1;
			cursor >= 0 && line[cursor] === "\\";
			cursor -= 1
		) {
			backslashes += 1;
		}
		if (backslashes % 2 === 0) positions.push(index);
	}
	return positions;
}
