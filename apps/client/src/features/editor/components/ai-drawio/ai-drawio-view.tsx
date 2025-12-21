import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import {
  ActionIcon,
  Card,
  Image,
  Text,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { uploadFile } from "@/features/page/services/page-service.ts";
import { useDisclosure } from "@mantine/hooks";
import { getFileUrl } from "@/lib/config.ts";
import { IAttachment } from "@/features/attachments/types/attachment.types";
import { decodeBase64ToSvgString, svgStringToFile } from "@/lib/utils";
import clsx from "clsx";
import { IconBrain, IconEdit } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { AiDrawioModal } from "./ai-drawio-modal";

export default function AiDrawioView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { node, updateAttributes, editor, selected, getPos } = props;
  const { src, title, width, attachmentId, chatHistory } = node.attrs;
  const [initialXML, setInitialXML] = useState<string>("");
  const [initialChatHistory, setInitialChatHistory] = useState<string>("");
  const [opened, { open, close }] = useDisclosure(false);

  // Debug: Log when node is rendered
  useEffect(() => {
    const pos = typeof getPos === 'function' ? getPos() : 'unknown';
    console.log('[Docmost ai-drawio-view] Node rendered:', {
      pos,
      src: src?.substring(0, 50),
      attachmentId,
      hasXmlContent: !!node.attrs.xmlContent,
      hasChatHistory: !!node.attrs.chatHistory,
    });
  }, [getPos, src, attachmentId, node.attrs.xmlContent, node.attrs.chatHistory]);

  const handleOpen = async () => {
    if (!editor.isEditable) {
      return;
    }

    try {
      // Load chat history from node attributes
      if (node.attrs.chatHistory) {
        setInitialChatHistory(node.attrs.chatHistory);
      } else {
        setInitialChatHistory("");
      }

      // Prioritize xmlContent from node attributes
      if (node.attrs.xmlContent) {
        setInitialXML(node.attrs.xmlContent);
        open();
        return;
      }

      // Fallback: Extract from SVG file (backwards compatibility)
      if (src) {
        const url = getFileUrl(src);
        const request = await fetch(url, {
          credentials: "include",
          cache: "no-store",
        });
        const blob = await request.blob();

        // Read the SVG content
        const text = await blob.text();

        // Extract the drawio XML from the SVG content attribute
        // The SVG stores drawio data in the 'content' attribute as base64
        const contentMatch = text.match(/content="([^"]+)"/);
        if (contentMatch) {
          // URL-decode and then parse the content
          const decodedContent = decodeURIComponent(contentMatch[1]);
          setInitialXML(decodedContent);
        } else {
          setInitialXML("");
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      open();
    }
  };

  const handleSave = async (svgString: string, xml: string, chatHistory?: string) => {
    console.log('[Docmost ai-drawio-view] handleSave called');
    console.log('[Docmost ai-drawio-view] svgString length:', svgString?.length);
    console.log('[Docmost ai-drawio-view] svgString starts with:', svgString?.substring(0, 100));
    console.log('[Docmost ai-drawio-view] xml length:', xml?.length);

    // Decode base64 SVG to raw SVG string (same as Drawio)
    const decodedSvg = decodeBase64ToSvgString(svgString);
    console.log('[Docmost ai-drawio-view] Decoded SVG length:', decodedSvg?.length);

    const fileName = "diagram.drawio.svg";
    const drawioSVGFile = await svgStringToFile(decodedSvg, fileName);
    console.log('[Docmost ai-drawio-view] File created:', drawioSVGFile.name, drawioSVGFile.size);

    const pageId = editor.storage?.pageId;
    console.log('[Docmost ai-drawio-view] pageId:', pageId, 'attachmentId:', attachmentId);

    let attachment: IAttachment = null;

    if (attachmentId) {
      attachment = await uploadFile(drawioSVGFile, pageId, attachmentId);
    } else {
      attachment = await uploadFile(drawioSVGFile, pageId);
    }
    console.log('[Docmost ai-drawio-view] Upload result:', attachment);

    updateAttributes({
      src: `/api/files/${attachment.id}/${attachment.fileName}?t=${new Date(attachment.updatedAt).getTime()}`,
      title: attachment.fileName,
      size: attachment.fileSize,
      attachmentId: attachment.id,
      xmlContent: xml,
      chatHistory: chatHistory || '',
    });

    close();
  };

  return (
    <NodeViewWrapper>
      <AiDrawioModal
        opened={opened}
        onClose={close}
        initialXML={initialXML}
        initialChatHistory={initialChatHistory}
        onSave={handleSave}
      />

      {src ? (
        <div style={{ position: "relative" }}>
          <Image
            onClick={(e) => {
              if (e.detail === 2) {
                e.stopPropagation();
                handleOpen();
              }
            }}
            radius="md"
            fit="contain"
            w={width}
            src={getFileUrl(src)}
            alt={title}
            className={clsx(
              selected ? "ProseMirror-selectednode" : "",
              "alignCenter",
            )}
          />

          {selected && editor.isEditable && (
            <ActionIcon
              onClick={(e) => {
                e.stopPropagation();
                handleOpen();
              }}
              variant="default"
              color="gray"
              mx="xs"
              className="print-hide"
              style={{
                position: "absolute",
                top: 8,
                right: 8,
              }}
            >
              <IconBrain size={18} />
            </ActionIcon>
          )}
        </div>
      ) : (
        <Card
          radius="md"
          onClick={(e) => {
            if (e.detail === 2) {
              e.stopPropagation();
              handleOpen();
            }
          }}
          p="xs"
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
          withBorder
          className={clsx(selected ? "ProseMirror-selectednode" : "")}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <ActionIcon variant="transparent" color="gray">
              <IconBrain size={18} />
            </ActionIcon>

            <Text component="span" size="lg" c="dimmed">
              {t("Double-click to create AI-powered diagram")}
            </Text>
          </div>
        </Card>
      )}
    </NodeViewWrapper>
  );
}
