import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, ActionIcon, Group, Tooltip, rem, useComputedColorScheme } from "@mantine/core";
import { IconZoomIn, IconZoomOut, IconRefresh, IconMaximize } from "@tabler/icons-react";
import mermaid from "mermaid";
import { TransformWrapper, TransformComponent, ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { useTranslation } from "react-i18next";

interface MermaidZoomModalProps {
  opened: boolean;
  onClose: () => void;
  code: string;
}

export function MermaidZoomModal({ opened, onClose, code }: MermaidZoomModalProps) {
  const { t } = useTranslation();
  const computedColorScheme = useComputedColorScheme();
  const [svg, setSvg] = useState<string>("");
  const [isPositioned, setIsPositioned] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<ReactZoomPanPinchRef>(null);

  // Configure Mermaid on theme change
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: computedColorScheme === "light" ? "default" : "dark",
    });
  }, [computedColorScheme]);

  // Render SVG when opened or code/theme changes
  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const { svg } = await mermaid.render(`modal-mermaid-${Date.now()}`, code);
        if (!cancelled) setSvg(svg);
      } catch (e) {
        if (!cancelled) setSvg("");
      }
    }
    if (opened && code?.trim()) {
      setIsPositioned(false); // Reset positioning state
      render();
    }
    return () => {
      cancelled = true;
    };
  }, [opened, code, computedColorScheme]);

  // Keep a memoized SVG element string to avoid re-parsing unless svg changes
  const svgContent = useMemo(() => ({ __html: svg }), [svg]);

  // Fit to screen handler
  const handleFitToScreen = (animate: boolean = true) => {
    if (!transformRef.current) return;

    const svgEl = contentRef.current?.querySelector?.("svg");
    if (!svgEl) return;

    const wrapper = transformRef.current.instance.wrapperComponent;
    if (!wrapper) return;

    const containerWidth = wrapper.clientWidth;
    const containerHeight = wrapper.clientHeight;

    // Ensure container has valid dimensions
    if (containerWidth === 0 || containerHeight === 0) return;

    // Get SVG dimensions from viewBox or bounding box
    let svgWidth = 0;
    let svgHeight = 0;

    const viewBox = svgEl.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.trim().split(/\s+/);
      if (parts.length === 4) {
        svgWidth = parseFloat(parts[2]);
        svgHeight = parseFloat(parts[3]);
      }
    }

    if (!svgWidth || !svgHeight || isNaN(svgWidth) || isNaN(svgHeight)) {
      const bbox = svgEl.getBBox();
      svgWidth = bbox.width;
      svgHeight = bbox.height;
    }

    if (svgWidth > 0 && svgHeight > 0) {
      const padding = 40;
      const scaleX = (containerWidth - padding * 2) / svgWidth;
      const scaleY = (containerHeight - padding * 2) / svgHeight;
      const scale = Math.min(scaleX, scaleY, 3); // Cap at 3x

      // Use animation only when manually triggered
      transformRef.current.centerView(scale, animate ? 300 : 0);
    }
  };

  // Auto-fit to screen when modal opens
  useEffect(() => {
    if (!opened || !svg) return;

    let attempts = 0;
    const maxAttempts = 3;
    let timeoutId: NodeJS.Timeout | null = null;

    const tryFit = () => {
      attempts++;

      // Check if we have all required elements
      const hasTransform = !!transformRef.current;
      const hasSvg = !!contentRef.current?.querySelector?.("svg");
      const hasWrapper = !!transformRef.current?.instance?.wrapperComponent;

      if (hasTransform && hasSvg && hasWrapper) {
        // No animation on initial load - instant positioning
        handleFitToScreen(false);
        // Show content after positioning with fade-in effect
        setTimeout(() => setIsPositioned(true), 50);
      } else if (attempts < maxAttempts) {
        timeoutId = setTimeout(tryFit, 150);
      }
    };

    // Shorter initial delay - just enough for DOM to render
    timeoutId = setTimeout(tryFit, 150);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [opened, svg]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      padding={0}
      withCloseButton
      styles={{
        body: { height: '100%', padding: 0 },
        content: { height: '100vh', display: 'flex', flexDirection: 'column' }
      }}
      title={null}
    >
      <TransformWrapper
        ref={transformRef}
        initialScale={1}
        minScale={0.1}
        maxScale={10}
        limitToBounds={false}
        centerOnInit={false}
        wheel={{ step: 0.15 }}
        panning={{ velocityDisabled: true }}
        doubleClick={{ disabled: true }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
            <Group
              justify="center"
              gap="md"
              p="md"
              style={{
                flexShrink: 0,
                background: computedColorScheme === 'dark'
                  ? 'rgba(26, 27, 30, 0.95)'
                  : 'rgba(255, 255, 255, 0.95)',
                backdropFilter: 'blur(10px)',
                borderBottom: computedColorScheme === 'dark'
                  ? '1px solid rgba(255, 255, 255, 0.1)'
                  : '1px solid rgba(0, 0, 0, 0.1)',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
              }}
            >
              <Tooltip label={t("Fit to screen")} withArrow position="bottom">
                <ActionIcon
                  variant="filled"
                  color="blue"
                  size="lg"
                  onClick={() => handleFitToScreen()}
                  aria-label="Fit to screen"
                >
                  <IconMaximize style={{ width: rem(20), height: rem(20) }} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={t("Zoom in")} withArrow position="bottom">
                <ActionIcon
                  variant="default"
                  size="lg"
                  onClick={() => zoomIn()}
                  aria-label="Zoom in"
                >
                  <IconZoomIn style={{ width: rem(20), height: rem(20) }} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={t("Zoom out")} withArrow position="bottom">
                <ActionIcon
                  variant="default"
                  size="lg"
                  onClick={() => zoomOut()}
                  aria-label="Zoom out"
                >
                  <IconZoomOut style={{ width: rem(20), height: rem(20) }} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={t("Reset")} withArrow position="bottom">
                <ActionIcon
                  variant="default"
                  size="lg"
                  onClick={() => resetTransform()}
                  aria-label="Reset zoom"
                >
                  <IconRefresh style={{ width: rem(20), height: rem(20) }} />
                </ActionIcon>
              </Tooltip>
            </Group>
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative', width: '100%', height: '100%' }}>
              <TransformComponent
                wrapperStyle={{
                  width: '100%',
                  height: '100%'
                }}
              >
                <div
                  ref={contentRef}
                  dangerouslySetInnerHTML={svgContent}
                  style={{
                    display: 'inline-block',
                    opacity: isPositioned ? 1 : 0,
                    transition: 'opacity 250ms ease-in'
                  }}
                />
              </TransformComponent>
            </div>
          </div>
        )}
      </TransformWrapper>
    </Modal>
  );
}

export default MermaidZoomModal;
