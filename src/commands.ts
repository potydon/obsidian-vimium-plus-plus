import { App, Notice } from "obsidian";

export function hasCommand(app: App, id: string): boolean {
	return id in app.commands.commands;
}

/** Runs the first available command; core and optional-plugin commands may be missing. */
export function runCommand(app: App, ...ids: string[]): void {
	const id = ids.find((candidate) => hasCommand(app, candidate));

	if (id == null) {
		new Notice(`Vimium++: command not available: ${ids.join(" / ")}`);
		return;
	}

	app.commands.executeCommandById(id);
}
