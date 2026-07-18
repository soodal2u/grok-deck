import { useCallback, useEffect, useRef } from "react";

type Side = "left" | "right";

/**
 * Draggable vertical divider between shell columns.
 * - left: resizes sidebar (dragging right grows sidebar)
 * - right: resizes rightbar (dragging left grows rightbar)
 */
export function PanelDivider({
  side,
  onDrag,
  onDragEnd,
}: {
  side: Side;
  onDrag: (deltaX: number) => void;
  onDragEnd?: () => void;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - lastX.current;
      lastX.current = e.clientX;
      onDrag(dx);
    },
    [onDrag],
  );

  const onUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onDragEnd?.();
  }, [onDragEnd]);

  useEffect(() => {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onMove, onUp]);

  return (
    <div
      className={`panel-divider panel-divider-${side}`}
      title="드래그하여 패널 크기 조절"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging.current = true;
        lastX.current = e.clientX;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        // Reset signal: large negative sentinel handled by parent? skip — parent can pass reset
      }}
    />
  );
}
