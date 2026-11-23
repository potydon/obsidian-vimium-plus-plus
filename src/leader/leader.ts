// The configurable leader layer: press the leader key, then a key sequence.
// A which-key popup lists what can follow while the sequence is pending.
import { App, Notice, TFile } from "obsidian";
import type { LeaderBinding, VimiumSettings } from "../settings";
import {
	Binding,
	Groups,
	KeyMap,
	KeySequence,
	displayKey,
	eventToKey,
	normalizeLeaderKey,
	parseKeys,
} from "./keys";
import { WhichKey } from "./which-key";

/** LazyVim's timeoutlen: only applies to keys that are both an action and a prefix. */
const ACTION_AND_PREFIX_TIMEOUT_MS = 300;
const FALLBACK_LEADER_KEY = "<Space>";

/**
 * Owns the leader keymap and the which-key popup. The plugin's key router calls
 * `handleKey` before its explorer/editor/reading handlers; while a sequence is
 * pending every key belongs to the leader, so <Esc>/<BS> can navigate it.
 */
export class Leader {
	private map = new KeyMap([]);
	private sequence: KeySequence | null = null;
	private readonly whichKey = new WhichKey();
	private timeout: number | null = null;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => VimiumSettings,
		private readonly pendingEl: HTMLElement | null
	) {}

	get active(): boolean {
		return this.sequence !== null;
	}

	/** Rebuild the key trie from settings. Call after any setting changes. */
	rebuild(): void {
		const settings = this.getSettings();
		const leaderKey = normalizeLeaderKey(settings.leaderKey) ?? FALLBACK_LEADER_KEY;

		const bindings: Binding[] = [];
		for (const binding of settings.leaderBindings ?? []) {
			const keys = binding.keys.trim();
			if (!keys) {
				continue;
			}
			const tokens = parseKeys(keys);
			if (tokens.length === 0) {
				continue;
			}
			bindings.push({
				keys: leaderKey + tokens.join(""),
				desc: describe(binding),
				run: () => this.run(binding),
			});
		}

		const groups: Groups = {};
		for (const group of settings.leaderGroups ?? []) {
			const prefix = group.prefix.trim();
			const name = group.name.trim();
			if (!prefix || !name) {
				continue;
			}
			const tokens = parseKeys(prefix);
			if (tokens.length === 0) {
				continue;
			}
			groups[leaderKey + tokens.join("")] = name;
		}

		this.map = new KeyMap(bindings, groups);
		this.reset();
	}

	/**
	 * Feed one keydown to the leader. Returns true when the key belongs to the
	 * leader (including cancelling a pending sequence), so the caller should
	 * swallow it.
	 */
	handleKey(event: KeyboardEvent): boolean {
		const key = eventToKey(event);
		if (key == null) {
			return false;
		}

		if (this.sequence == null) {
			if (!this.map.hasFirstKey(key)) {
				return false;
			}
			this.sequence = new KeySequence(this.map);
		}

		const sequence = this.sequence;
		if (sequence == null) {
			return false;
		}

		if (sequence.hasKeys && key === "<Esc>") {
			this.reset();
			return true;
		}

		if (sequence.hasKeys && key === "<BS>") {
			if (sequence.back()) {
				this.showPending(sequence);
			} else {
				this.reset();
			}
			return true;
		}

		const result = sequence.feed(key);
		if (result.type === "pending") {
			this.showPending(sequence);
			return true;
		}

		this.reset();
		if (result.type === "match") {
			void result.binding.run();
		}
		return true;
	}

	/** Drop a pending sequence, e.g. when a modal opens or the plugin unloads. */
	reset(): void {
		this.clearTimeout();
		this.sequence = null;
		this.whichKey.hide();
		this.pendingEl?.setText("");
	}

	destroy(): void {
		this.reset();
	}

	private showPending(sequence: KeySequence): void {
		this.clearTimeout();

		const settings = this.getSettings();
		const keys = sequence.keys.map(displayKey).join(" ");
		this.pendingEl?.setText(keys);

		if (settings.whichKey) {
			const group = sequence.group;
			const title = group ? `${keys} · ${group}` : keys;
			this.whichKey.schedule(
				() => ({ title, entries: sequence.entries() }),
				Math.max(0, settings.whichKeyDelay)
			);
		} else {
			this.whichKey.hide();
		}

		const action = sequence.binding;
		if (action != null) {
			// The sequence is both an action and a prefix; wait briefly for a
			// longer sequence before running the shorter action.
			this.timeout = window.setTimeout(() => {
				this.reset();
				void action.run();
			}, ACTION_AND_PREFIX_TIMEOUT_MS);
		} else if (settings.leaderTimeout > 0) {
			this.timeout = window.setTimeout(
				() => this.reset(),
				settings.leaderTimeout
			);
		}
	}

	private clearTimeout(): void {
		if (this.timeout != null) {
			window.clearTimeout(this.timeout);
			this.timeout = null;
		}
	}

	private run(binding: LeaderBinding): void {
		if (binding.kind === "file") {
			this.openFile(binding.filePath);
			return;
		}

		const id = binding.commandId.trim();
		if (!id) {
			return;
		}
		if (!(id in this.app.commands.commands)) {
			new Notice(`Vimium++: command not available: ${id}`);
			return;
		}
		this.app.commands.executeCommandById(id);
	}

	private openFile(pathOrName: string): void {
		const file = this.findFile(pathOrName);
		if (file == null) {
			new Notice(`Vimium++: file not found: ${pathOrName}`);
			return;
		}

		const leaf =
			this.app.workspace.getMostRecentLeaf() ??
			this.app.workspace.getLeaf(true);
		void (async () => {
			await leaf.openFile(file);
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		})();
	}

	/**
	 * A vault path (contains a slash) or a file name searched across the vault.
	 * The `.md` extension is optional, matching the spacekeys keymap format.
	 */
	private findFile(pathOrName: string): TFile | null {
		const input = pathOrName.trim();
		if (!input) {
			return null;
		}

		const normalized = input.replace(/^\/+/, "");
		const exact = this.app.vault.getAbstractFileByPath(normalized);
		if (exact instanceof TFile) {
			return exact;
		}

		const lower = normalized.toLowerCase();
		const withMd = lower.endsWith(".md") ? lower : `${lower}.md`;

		for (const file of this.app.vault.getFiles()) {
			const path = file.path.toLowerCase();
			if (
				path === lower ||
				path === withMd ||
				file.name.toLowerCase() === lower ||
				file.basename.toLowerCase() === lower
			) {
				return file;
			}
		}
		return null;
	}
}

function describe(binding: LeaderBinding): string {
	const description = binding.description.trim();
	if (description) {
		return description;
	}
	if (binding.kind === "file") {
		return binding.filePath.trim() || "Open file";
	}
	return (
		binding.commandName.trim() ||
		binding.commandId.trim() ||
		"Command"
	);
}
