import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Group, Modal, Tooltip } from "@mantine/core";
import {
  IconFocusCentered,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

const MIN_SCALE = 0.2;
const MAX_SCALE = 10;

type Props = {
  opened: boolean;
  onClose: () => void;
  svg: string;
};

/**
 * Full-screen diagram viewer with wheel zoom and drag panning.
 *
 * ponytail: plain CSS transform instead of a zoom/pan library — a fork carries
 * every extra dependency through each upstream merge, and this needs 3 gestures.
 */
export function MermaidZoomModal({ opened, onClose, svg }: Props) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  /** Scale the diagram so it fills ~90% of the viewport, then centre it. */
  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const svgEl = contentRef.current?.querySelector("svg");
    if (!viewport || !svgEl) return;

    const box = svgEl.getBoundingClientRect();
    // the rendered box already includes the current scale
    const naturalWidth = box.width / transform.scale;
    const naturalHeight = box.height / transform.scale;
    if (!naturalWidth || !naturalHeight) return;

    const scale = Math.min(
      (viewport.clientWidth * 0.9) / naturalWidth,
      (viewport.clientHeight * 0.9) / naturalHeight,
      MAX_SCALE,
    );

    setTransform({ scale: Math.max(scale, MIN_SCALE), x: 0, y: 0 });
    // transform.scale is read to undo it, not to react to it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!opened) return;
    // wait for the modal to lay out before measuring
    const timer = setTimeout(fit, 50);
    return () => clearTimeout(timer);
  }, [opened, svg, fit]);

  const zoomBy = (factor: number) =>
    setTransform((prev) => ({
      ...prev,
      scale: clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE),
    }));

  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    dragRef.current = {
      x: event.clientX - transform.x,
      y: event.clientY - transform.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    setTransform((prev) => ({
      ...prev,
      x: event.clientX - dragRef.current!.x,
      y: event.clientY - dragRef.current!.y,
    }));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      padding={0}
      withCloseButton={false}
      transitionProps={{ duration: 120 }}
    >
      <div
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          width: "100vw",
          height: "100vh",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: dragRef.current ? "grabbing" : "grab",
          touchAction: "none",
        }}
      >
        <div
          ref={contentRef}
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            transformOrigin: "center center",
            transition: dragRef.current ? "none" : "transform 80ms linear",
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      <Group
        gap="xs"
        style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)" }}
      >
        <Tooltip label={t("Zoom out")} withArrow>
          <ActionIcon variant="default" size="lg" onClick={() => zoomBy(1 / 1.25)}>
            <IconZoomOut size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Fit to screen")} withArrow>
          <ActionIcon variant="default" size="lg" onClick={fit}>
            <IconFocusCentered size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Zoom in")} withArrow>
          <ActionIcon variant="default" size="lg" onClick={() => zoomBy(1.25)}>
            <IconZoomIn size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Modal>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
