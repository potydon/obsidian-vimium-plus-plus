// which-key style popup, laid out like LazyVim's "helix" preset: bottom-right
// list of the keys that can follow the current prefix.
import { KeyEntry, displayKey } from "./keys";

export interface WhichKeyContent {
	title: string;
	entries: KeyEntry[];
}

export class WhichKey {
	private el: HTMLElement | null = null;
	private timer: number | null = null;

	/** Shows the popup after `delay` ms, or updates it right away when it is already visible. */
	schedule(content: () => WhichKeyContent, delay: number): void {
		this.clearTimer();

		if (this.el != null) {
			this.render(content());
			return;
		}

		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.render(content());
		}, Math.max(0, delay));
	}

	hide(): void {
		this.clearTimer();
		this.el?.remove();
		this.el = null;
	}

	private clearTimer(): void {
		if (this.timer != null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private render({ title, entries }: WhichKeyContent): void {
		this.el ??= activeDocument.body.createDiv({ cls: "vimium-which-key" });
		const el = this.el;
		el.empty();

		el.createDiv({ cls: "vimium-which-key-title", text: title });

		const list = el.createDiv({ cls: "vimium-which-key-list" });
		for (const entry of entries) {
			const row = list.createDiv({ cls: "vimium-which-key-row" });
			row.createSpan({
				cls: "vimium-which-key-key",
				text: displayKey(entry.key),
			});
			row.createSpan({
				cls: entry.isGroup
					? "vimium-which-key-group"
					: "vimium-which-key-desc",
				text: entry.desc,
			});
		}

		el.createDiv({
			cls: "vimium-which-key-footer",
			text: "esc cancel · bs back",
		});
	}
}
