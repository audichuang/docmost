import { Modal, Group, Button, ActionIcon, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useCallback, useState } from "react";
import { getNextAiDrawioUrl } from "@/lib/config.ts";
import { IconX } from "@tabler/icons-react";

interface EmbedMessage {
  type: "READY" | "EXPORT_RESULT" | "SAVE_REQUESTED" | "LOAD_DIAGRAM" | "REQUEST_EXPORT";
  payload?: {
    xml?: string;
    svg?: string;
    chatHistory?: string;
  };
}

interface AiDrawioModalProps {
  opened: boolean;
  onClose: () => void;
  initialXML: string;
  initialChatHistory?: string;
  onSave: (svgString: string, xml: string, chatHistory?: string) => Promise<void>;
}

export function AiDrawioModal({
  opened,
  onClose,
  initialXML,
  initialChatHistory,
  onSave,
}: AiDrawioModalProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hasLoadedRef = useRef(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Reset loaded flag when modal closes
  useEffect(() => {
    if (!opened) {
      hasLoadedRef.current = false;
      // Clear any pending timeout when modal closes
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    }
  }, [opened]);

  // Request export from iframe and save
  const handleSaveAndClose = useCallback(() => {
    console.log('[Docmost] handleSaveAndClose called');
    if (iframeRef.current?.contentWindow) {
      setIsSaving(true);
      console.log('[Docmost] Sending REQUEST_EXPORT to iframe');

      // Set timeout to prevent infinite spinning (10 seconds)
      saveTimeoutRef.current = setTimeout(() => {
        console.error('[Docmost] Save timeout - no response from iframe');
        setIsSaving(false);
        notifications.show({
          title: "Save Timeout",
          message: "The diagram editor did not respond. Please check if it loaded correctly and try again.",
          color: "red",
        });
      }, 10000);

      iframeRef.current.contentWindow.postMessage(
        { type: "REQUEST_EXPORT" },
        "*"
      );
    } else {
      console.error('[Docmost] iframe not ready - contentWindow is null');
      notifications.show({
        title: "Error",
        message: "Diagram editor is not ready. Please wait and try again.",
        color: "red",
      });
    }
  }, []);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const message = event.data as EmbedMessage;

      if (!message || typeof message.type !== "string") {
        return;
      }

      console.log('[Docmost] Received message:', message.type, message.payload ? 'with payload' : 'no payload');

      // Handle READY - load diagram when iframe is ready
      if (message.type === "READY" && !hasLoadedRef.current) {
        console.log('[Docmost] Handling READY message');
        hasLoadedRef.current = true;
        if (iframeRef.current?.contentWindow) {
          console.log('[Docmost] Sending LOAD_DIAGRAM with initialXML length:', initialXML?.length, 'chatHistory length:', initialChatHistory?.length);
          iframeRef.current.contentWindow.postMessage(
            {
              type: "LOAD_DIAGRAM",
              payload: {
                xml: initialXML,
                chatHistory: initialChatHistory
              },
            } as EmbedMessage,
            "*"
          );
        } else {
          console.log('[Docmost] No initialXML to load or iframe not ready');
        }
      }

      // Handle SAVE_REQUESTED - user clicked save in next-ai-draw-io
      if (message.type === "SAVE_REQUESTED" && message.payload) {
        console.log('[Docmost] Handling SAVE_REQUESTED, xml length:', message.payload.xml?.length, 'svg length:', message.payload.svg?.length, 'chatHistory length:', message.payload.chatHistory?.length);
        // Clear timeout since we got a response
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
        }
        const { xml, svg, chatHistory } = message.payload;
        if (svg && xml) {
          onSave(svg, xml, chatHistory).then(() => {
            console.log('[Docmost] Save completed successfully');
            setIsSaving(false);
            onClose();
          }).catch((err) => {
            console.error('[Docmost] Save failed:', err);
            setIsSaving(false);
          });
        } else {
          console.error('[Docmost] SAVE_REQUESTED missing xml or svg');
          setIsSaving(false);
        }
      }

      // Handle EXPORT_RESULT - diagram export completed
      if (message.type === "EXPORT_RESULT" && message.payload) {
        console.log('[Docmost] Handling EXPORT_RESULT, xml length:', message.payload.xml?.length, 'svg length:', message.payload.svg?.length, 'chatHistory length:', message.payload.chatHistory?.length);
        // Clear timeout since we got a response
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
        }
        const { xml, svg, chatHistory } = message.payload;
        if (svg && xml) {
          onSave(svg, xml, chatHistory).then(() => {
            console.log('[Docmost] Save from EXPORT_RESULT completed successfully');
            setIsSaving(false);
            onClose();
          }).catch((err) => {
            console.error('[Docmost] Save from EXPORT_RESULT failed:', err);
            setIsSaving(false);
          });
        } else {
          console.error('[Docmost] EXPORT_RESULT missing xml or svg');
          setIsSaving(false);
        }
      }
    },
    [initialXML, initialChatHistory, onSave, onClose]
  );

  // Listen for messages from iframe
  useEffect(() => {
    if (!opened) return;

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [opened, handleMessage]);

  const iframeUrl = `${getNextAiDrawioUrl()}?embed=true`;
  console.log('[Docmost] iframe URL:', iframeUrl);

  return (
    <Modal.Root opened={opened} onClose={onClose} fullScreen>
      <Modal.Overlay />
      <Modal.Content style={{ overflow: "hidden" }}>
        <Modal.Body p={0} style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
          {/* Header with close and save buttons */}
          <Group
            justify="space-between"
            px="md"
            py="xs"
            style={{
              borderBottom: "1px solid var(--mantine-color-gray-3)",
              backgroundColor: "var(--mantine-color-body)",
              flexShrink: 0,
            }}
          >
            <Group gap="xs">
              <ActionIcon
                variant="subtle"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                title="Close"
              >
                <IconX size={18} />
              </ActionIcon>
              <Text fw={500}>AI Diagram Editor</Text>
            </Group>
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  console.log('[Docmost] Cancel clicked');
                  onClose();
                }}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSaveAndClose();
                }}
                loading={isSaving}
              >
                Save & Close
              </Button>
            </Group>
          </Group>

          {/* Iframe */}
          <iframe
            ref={iframeRef}
            src={iframeUrl}
            style={{
              width: "100%",
              flex: 1,
              border: "none",
            }}
            allow="clipboard-read; clipboard-write"
          />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

export default AiDrawioModal;
