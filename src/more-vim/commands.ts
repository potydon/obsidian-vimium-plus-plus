import type { Editor } from "obsidian";
import type { ActiveContext } from "./context";
import type { Vim, VimAdapter } from "./vim";

interface CommandsHost {
	vim: Vim;
	activeContext(): ActiveContext | null;
	openLink(text: string, sourcePath: string): void;
	openExternal(url: string): void;
}

/** Register the extra normal-mode Vim actions once the namespace is ready. */
export function defineCommands(host: CommandsHost): void {
	host.vim.defineCommand({
		name: "navigateLinkUnderCursor",
		keys: "gd",
		fn: () => {
			const ctx = host.activeContext();
			if (!ctx) return;
			const token = getTokenAtCursor(ctx.editor);
			if (token?.type === "internal-link") {
				host.openLink(token.text, ctx.file?.path ?? "");
			}
		},
	});

	host.vim.defineCommand({
		name: "openLinkUnderCursor",
		keys: "gx",
		fn: () => {
			const ctx = host.activeContext();
			if (!ctx) return;
			const token = getTokenAtCursor(ctx.editor);
			if (token?.type === "external-link") host.openExternal(token.text);
		},
	});

	host.vim.defineCommand({
		name: "openLineKeepList",
		keys: "o",
		fn: (_cm: VimAdapter) => {
			const ctx = host.activeContext();
			if (!ctx) return;
			const { editor, cmView, vim, adapter } = ctx;
			const { line } = editor.getCursor();
			editor.setCursor({ line, ch: editor.getLine(line).length });
			vim.send(adapter, "A");
			cmView.contentDOM.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					code: "Enter",
					bubbles: true,
					cancelable: true,
				})
			);
		},
	});
}

interface ClickableToken {
	type: "internal-link" | "external-link";
	text: string;
}

function getTokenAtCursor(editor: Editor): ClickableToken | undefined {
	const internal = editor as Editor & {
		getClickableTokenAt: (
			pos: ReturnType<Editor["getCursor"]>
		) => ClickableToken | undefined;
	};
	return internal.getClickableTokenAt(editor.getCursor());
}
