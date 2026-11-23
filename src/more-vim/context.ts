import type { Editor, TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { Vim, VimAdapter } from "./vim";

/** Everything the Vim enhancements need about the currently active note. */
export interface ActiveContext {
	editor: Editor;
	cmView: EditorView;
	adapter: VimAdapter;
	vim: Vim;
	file: TFile | null;
}
