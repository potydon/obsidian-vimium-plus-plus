import type { RegisterController, VimRegister } from "./vim";

/** Callbacks the clipboard register needs from the plugin wrapper. */
export interface ClipboardHost {
	isEnabled(): boolean;
	getController(): RegisterController | undefined;
	onFocus(handler: () => void): void;
}

/**
 * Replaces Vim's unnamed register with one that mirrors the OS clipboard.
 * Named registers are left alone.
 */
export class Clipboard {
	private register: ClipboardRegister | null = null;
	private originalUnnamed: VimRegister | null = null;
	private host: ClipboardHost | null = null;

	install(host: ClipboardHost): void {
		if (this.register || this.host) return;
		const controller = host.getController();
		if (!controller) return;

		this.host = host;
		this.originalUnnamed = controller.unnamedRegister;
		const register = new ClipboardRegister(() => host.isEnabled());
		this.register = register;
		controller.unnamedRegister = register;
		controller.registers['"'] = register;

		if (host.isEnabled()) void syncFromClipboard(register);
		host.onFocus(() => {
			if (host.isEnabled() && this.register) void syncFromClipboard(this.register);
		});
	}

	uninstall(): void {
		if (!this.register) return;
		const controller = this.host?.getController();
		if (controller && this.originalUnnamed) {
			controller.unnamedRegister = this.originalUnnamed;
			controller.registers['"'] = this.originalUnnamed;
		}
		this.originalUnnamed = null;
		this.register = null;
		this.host = null;
	}

	syncWithSetting(): void {
		if (!this.register || !this.host?.isEnabled()) return;
		void syncFromClipboard(this.register);
	}
}

async function syncFromClipboard(register: ClipboardRegister): Promise<void> {
	try {
		const text = await navigator.clipboard.readText();
		if (text === register.toString()) return;
		register.keyBuffer = [text];
		register.linewise = false;
		register.blockwise = false;
	} catch {
		// Clipboard access can be denied; keep the existing register content.
	}
}

class ClipboardRegister implements VimRegister {
	keyBuffer: string[] = [""];
	insertModeChanges: unknown[] = [];
	searchQueries: string[] = [];
	linewise = false;
	blockwise = false;

	constructor(private readonly syncEnabled: () => boolean) {}

	setText(text: string, linewise?: boolean, blockwise?: boolean): void {
		this.keyBuffer = [text];
		this.linewise = !!linewise;
		this.blockwise = !!blockwise;
		if (this.syncEnabled()) void navigator.clipboard.writeText(text);
	}

	pushText(text: string, linewise?: boolean): void {
		if (linewise) {
			if (!this.linewise) this.keyBuffer.push("\n");
			this.linewise = true;
		} else if (this.linewise) {
			this.keyBuffer.push("\n");
		}
		this.keyBuffer.push(text);
		if (this.syncEnabled()) void navigator.clipboard.writeText(this.toString());
	}

	clear(): void {
		this.keyBuffer = [];
		this.linewise = false;
		this.blockwise = false;
	}

	pushInsertModeChanges(changes: unknown): void {
		this.insertModeChanges.push(changes);
	}

	pushSearchQuery(query: string): void {
		this.searchQueries.push(query);
	}

	toString(): string {
		return this.keyBuffer.join("");
	}
}
