import { ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Keep `scrolloff` lines of context around the lowest cursor. */
export function scrolloff(getLines: () => number) {
	return ViewPlugin.fromClass(
		class {
			update(update: ViewUpdate): void {
				const lines = getLines();
				if (!Number.isFinite(lines) || lines <= 0) return;
				if (!update.selectionSet && !update.docChanged) return;

				update.view.requestMeasure({
					read(view) {
						const lowestHead = Math.max(
							...view.state.selection.ranges.map((range) => range.head)
						);
						const coords = view.coordsAtPos(lowestHead);
						if (!coords) return null;
						const rect = view.scrollDOM.getBoundingClientRect();
						const margin = lines * view.defaultLineHeight;
						const topDist = coords.top - rect.top;
						const bottomDist = rect.bottom - coords.bottom;
						if (topDist < margin) return topDist - margin;
						if (bottomDist < margin) return margin - bottomDist;
						return null;
					},
					write(delta, view) {
						if (delta != null) view.scrollDOM.scrollTop += delta;
					},
				});
			}
		}
	);
}
