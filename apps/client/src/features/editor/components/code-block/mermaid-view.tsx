import { NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import mermaid from "mermaid";
import { v4 as uuidv4 } from "uuid";
import classes from "./code-block.module.css";
import { useTranslation } from "react-i18next";
import { ActionIcon, Tooltip, useComputedColorScheme } from "@mantine/core";
import { IconMaximize } from "@tabler/icons-react";
import DOMPurify from "dompurify";
import { MermaidZoomModal } from "./mermaid-zoom-modal";

interface MermaidViewProps {
  props: NodeViewProps;
}

export default function MermaidView({ props }: MermaidViewProps) {
  const { t } = useTranslation();
  const computedColorScheme = useComputedColorScheme();
  const { node } = props;
  const [preview, setPreview] = useState<string>("");
  const [hasError, setHasError] = useState(false);
  const [zoomOpened, setZoomOpened] = useState(false);

  // Update Mermaid config when theme changes.
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: computedColorScheme === "light" ? "default" : "dark",
    });
  }, [computedColorScheme]);

  // Re-render the diagram whenever the node content or theme changes.
  useEffect(() => {
    const id = `mermaid-${uuidv4()}`;
    if (node.textContent.length > 0) {
      mermaid
        .render(id, node.textContent)
        .then((item) => {
          setPreview(item.svg);
          setHasError(false);
        })
        .catch((err) => {
          setHasError(true);
          if (props.editor.isEditable) {
            setPreview(
              `<div class="${classes.error}">${t("Mermaid diagram error:")} ${DOMPurify.sanitize(err)}</div>`,
            );
          } else {
            setPreview(
              `<div class="${classes.error}">${t("Invalid Mermaid diagram")}</div>`,
            );
          }
        });
    }
  }, [node.textContent, computedColorScheme]);

  return (
    <div
      className={classes.mermaid}
      contentEditable={false}
      style={{ position: "relative" }}
    >
      <div dangerouslySetInnerHTML={{ __html: preview }} />

      {!hasError && preview && (
        <Tooltip label={t("Expand")} withArrow position="left">
          <ActionIcon
            variant="default"
            size="sm"
            style={{ position: "absolute", top: 8, right: 8 }}
            onClick={() => setZoomOpened(true)}
          >
            <IconMaximize size={14} />
          </ActionIcon>
        </Tooltip>
      )}

      <MermaidZoomModal
        opened={zoomOpened}
        onClose={() => setZoomOpened(false)}
        svg={preview}
      />
    </div>
  );
}
