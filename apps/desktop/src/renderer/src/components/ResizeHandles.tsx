import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = (typeof EDGES)[number];

/**
 * Invisible ~8px edge grips so window resize is easier than the native 1–2px border.
 */
export function ResizeHandles() {
  const dragging = useRef(false);

  const onMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    window.grokDeck.window.resizeMove(e.screenX, e.screenY);
  }, []);

  const onUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    window.grokDeck.window.resizeEnd();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mouseleave", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mouseleave", onUp);
    };
  }, [onMove, onUp]);

  const start = (edge: Edge, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    document.body.style.userSelect = "none";
    window.grokDeck.window.resizeStart(edge, e.screenX, e.screenY);
  };

  return (
    <>
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`resize-grip resize-${edge}`}
          onMouseDown={(e) => start(edge, e)}
        />
      ))}
    </>
  );
}
