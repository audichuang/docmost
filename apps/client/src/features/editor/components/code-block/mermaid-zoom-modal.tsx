import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  ActionIcon,
  Group,
  Tooltip,
  rem,
  useComputedColorScheme,
  useMantineTheme,
  Box,
} from "@mantine/core";
import { IconZoomIn, IconZoomOut, IconRefresh } from "@tabler/icons-react";
import mermaid from "mermaid";
import {
  TransformWrapper,
  TransformComponent,
  ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { useTranslation } from "react-i18next";

interface MermaidZoomModalProps {
  opened: boolean;
  onClose: () => void;
  code: string;
}

export function MermaidZoomModal({
  opened,
  onClose,
  code,
}: MermaidZoomModalProps) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const computedColorScheme = useComputedColorScheme();
  const [svg, setSvg] = useState<string>("");
  const [isPositioned, setIsPositioned] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  const initialScaleRef = useRef<number>(1);

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
        const { svg } = await mermaid.render(
          `modal-mermaid-${Date.now()}`,
          code,
        );
        if (!cancelled) {
          setSvg(svg);
          setIsPositioned(false); // Reset positioning state
        }
      } catch (e) {
        if (!cancelled) setSvg("");
      }
    }
    if (opened && code?.trim()) {
      render();
    }
    return () => {
      cancelled = true;
    };
  }, [opened, code, computedColorScheme]);

  // Keep a memoized SVG element string to avoid re-parsing unless svg changes
  const svgContent = useMemo(() => ({ __html: svg }), [svg]);

  // Initialize diagram with proper scale (60% of viewport)
  useEffect(() => {
    if (!opened || !svg) {
      setIsPositioned(false);
      return;
    }

    // Wait for DOM to be ready, then calculate and apply scale
    const timeoutId = setTimeout(() => {
      const svgEl = contentRef.current?.querySelector?.("svg");
      if (!svgEl || !transformRef.current) {
        setIsPositioned(true);
        return;
      }

      const wrapper = transformRef.current.instance.wrapperComponent;
      if (!wrapper) {
        setIsPositioned(true);
        return;
      }

      // Get container dimensions
      const containerWidth = wrapper.clientWidth;
      const containerHeight = wrapper.clientHeight;

      // Get SVG dimensions from viewBox or bounding box
      let svgWidth = 0;
      let svgHeight = 0;

      const viewBox = svgEl.getAttribute("viewBox");
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

      if (
        svgWidth > 0 &&
        svgHeight > 0 &&
        containerWidth > 0 &&
        containerHeight > 0
      ) {
        // Calculate scale to fit diagram in container
        const padding = 40;
        const scaleX = (containerWidth - padding * 2) / svgWidth;
        const scaleY = (containerHeight - padding * 2) / svgHeight;

        // Get the scale that fits the diagram completely in the container
        const fitScale = Math.min(scaleX, scaleY);

        // Use 95% of fit scale to make diagram large
        // Ensure minimum 1.0x (original size) and maximum 3x
        const initialScale = Math.max(Math.min(fitScale * 0.95, 3), 1.0);

        // Save initial scale for reset
        initialScaleRef.current = initialScale;

        // Apply the scale and center
        transformRef.current.centerView(initialScale, 0);
      }

      // Show content with fade-in
      setTimeout(() => setIsPositioned(true), 50);
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [svg, opened]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      padding={0}
      withCloseButton
      styles={{
        body: { height: "100%", padding: 0 },
        content: { height: "100vh", display: "flex", flexDirection: "column" },
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
        wheel={{ step: 0.2 }}
        panning={{ velocityDisabled: false }}
        doubleClick={{ disabled: true }}
      >
        {({ zoomIn, zoomOut }) => (
          <Box
            style={{
              height: "100%",
              width: "100%",
              overflow: "hidden",
              position: "relative",
              background:
                computedColorScheme === "dark"
                  ? theme.colors.dark[7]
                  : "#fafafa",
            }}
          >
            <TransformComponent
              wrapperStyle={{
                width: "100%",
                height: "100%",
              }}
            >
              <div
                ref={contentRef}
                dangerouslySetInnerHTML={svgContent}
                style={{
                  display: "inline-block",
                  opacity: isPositioned ? 1 : 0,
                  transition: "opacity 250ms ease-in",
                }}
              />
            </TransformComponent>

            {/* Floating toolbar at bottom center */}
            <Box
              style={{
                position: "absolute",
                bottom: "24px",
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 1000,
              }}
            >
              <Group
                gap="xs"
                style={{
                  background:
                    computedColorScheme === "dark"
                      ? "rgba(0, 0, 0, 0.75)"
                      : "rgba(255, 255, 255, 0.9)",
                  backdropFilter: "blur(12px)",
                  padding: "8px 12px",
                  borderRadius: "24px",
                  boxShadow:
                    computedColorScheme === "dark"
                      ? "0 8px 32px rgba(0, 0, 0, 0.4)"
                      : "0 4px 24px rgba(0, 0, 0, 0.12)",
                  border: `1px solid ${
                    computedColorScheme === "dark"
                      ? "rgba(255, 255, 255, 0.1)"
                      : "rgba(0, 0, 0, 0.08)"
                  }`,
                }}
              >
                <Tooltip label={t("Zoom in")} withArrow position="top">
                  <ActionIcon
                    variant="subtle"
                    color={computedColorScheme === "dark" ? "gray" : "dark"}
                    size="lg"
                    radius="xl"
                    onClick={() => zoomIn()}
                    aria-label="Zoom in"
                    style={{
                      transition: "all 0.2s ease",
                      "&:hover": {
                        background:
                          computedColorScheme === "dark"
                            ? "rgba(255, 255, 255, 0.1)"
                            : "rgba(0, 0, 0, 0.05)",
                      },
                    }}
                  >
                    <IconZoomIn style={{ width: rem(20), height: rem(20) }} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("Zoom out")} withArrow position="top">
                  <ActionIcon
                    variant="subtle"
                    color={computedColorScheme === "dark" ? "gray" : "dark"}
                    size="lg"
                    radius="xl"
                    onClick={() => zoomOut()}
                    aria-label="Zoom out"
                    style={{
                      transition: "all 0.2s ease",
                      "&:hover": {
                        background:
                          computedColorScheme === "dark"
                            ? "rgba(255, 255, 255, 0.1)"
                            : "rgba(0, 0, 0, 0.05)",
                      },
                    }}
                  >
                    <IconZoomOut style={{ width: rem(20), height: rem(20) }} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t("Reset")} withArrow position="top">
                  <ActionIcon
                    variant="subtle"
                    color={computedColorScheme === "dark" ? "gray" : "dark"}
                    size="lg"
                    radius="xl"
                    onClick={() => {
                      if (transformRef.current) {
                        transformRef.current.centerView(
                          initialScaleRef.current,
                          300,
                        );
                      }
                    }}
                    aria-label="Reset"
                    style={{
                      transition: "all 0.2s ease",
                      "&:hover": {
                        background:
                          computedColorScheme === "dark"
                            ? "rgba(255, 255, 255, 0.1)"
                            : "rgba(0, 0, 0, 0.05)",
                      },
                    }}
                  >
                    <IconRefresh style={{ width: rem(20), height: rem(20) }} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Box>
          </Box>
        )}
      </TransformWrapper>
    </Modal>
  );
}

export default MermaidZoomModal;
