import type { BrowserWindow } from "electron";

export type ResizeEdge =
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

/**
 * Apply interactive resize from an edge grip.
 * `dx/dy` are screen-pixel deltas from the drag start point.
 */
export function applyEdgeResize(
  win: BrowserWindow,
  edge: ResizeEdge,
  startBounds: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
  minWidth = 960,
  minHeight = 640,
): void {
  let { x, y, width, height } = startBounds;

  if (edge.includes("e")) {
    width = Math.max(minWidth, startBounds.width + dx);
  }
  if (edge.includes("s")) {
    height = Math.max(minHeight, startBounds.height + dy);
  }
  if (edge.includes("w")) {
    const nextW = Math.max(minWidth, startBounds.width - dx);
    x = startBounds.x + (startBounds.width - nextW);
    width = nextW;
  }
  if (edge.includes("n")) {
    const nextH = Math.max(minHeight, startBounds.height - dy);
    y = startBounds.y + (startBounds.height - nextH);
    height = nextH;
  }

  win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
}
