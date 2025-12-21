import {
  BubbleMenu as BaseBubbleMenu,
  findParentNode,
  posToDOMRect,
  useEditorState,
} from "@tiptap/react";
import { useCallback } from "react";
import { sticky } from "tippy.js";
import { Node as PMNode } from "prosemirror-model";
import {
  EditorMenuProps,
  ShouldShowProps,
} from "@/features/editor/components/table/types/types.ts";
import { NodeWidthResize } from "@/features/editor/components/common/node-width-resize.tsx";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconArrowBack } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

export function AiDrawioMenu({ editor }: EditorMenuProps) {
  const { t } = useTranslation();

  const shouldShow = useCallback(
    ({ state }: ShouldShowProps) => {
      if (!state) {
        return false;
      }

      return editor.isActive("aiDrawio") && editor.getAttributes("aiDrawio")?.src;
    },
    [editor],
  );

  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      if (!ctx.editor) {
        return null;
      }

      const aiDrawioAttr = ctx.editor.getAttributes("aiDrawio");
      return {
        isAiDrawio: ctx.editor.isActive("aiDrawio"),
        width: aiDrawioAttr?.width ? parseInt(aiDrawioAttr.width) : null,
      };
    },
  });

  const getReferenceClientRect = useCallback(() => {
    const { selection } = editor.state;
    const predicate = (node: PMNode) => node.type.name === "aiDrawio";
    const parent = findParentNode(predicate)(selection);

    if (parent) {
      const dom = editor.view.nodeDOM(parent?.pos) as HTMLElement;
      return dom.getBoundingClientRect();
    }

    return posToDOMRect(editor.view, selection.from, selection.to);
  }, [editor]);

  const onWidthChange = useCallback(
    (value: number) => {
      editor.commands.updateAttributes("aiDrawio", { width: `${value}%` });
    },
    [editor],
  );

  const convertToDrawio = useCallback(() => {
    const { selection } = editor.state;
    const predicate = (node: PMNode) => node.type.name === "aiDrawio";
    const parent = findParentNode(predicate)(selection);

    if (parent) {
      const attrs = parent.node.attrs;
      editor
        .chain()
        .focus()
        .deleteRange({ from: parent.pos, to: parent.pos + parent.node.nodeSize })
        .insertContent({
          type: "drawio",
          attrs: {
            src: attrs.src,
            title: attrs.title,
            width: attrs.width,
            size: attrs.size,
            attachmentId: attrs.attachmentId,
          },
        })
        .run();
    }
  }, [editor]);

  return (
    <BaseBubbleMenu
      editor={editor}
      pluginKey={`ai-drawio-menu`}
      updateDelay={0}
      tippyOptions={{
        getReferenceClientRect,
        offset: [0, 8],
        zIndex: 99,
        popperOptions: {
          modifiers: [{ name: "flip", enabled: false }],
        },
        plugins: [sticky],
        sticky: "popper",
      }}
      shouldShow={shouldShow}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        {editorState?.width && (
          <NodeWidthResize onChange={onWidthChange} value={editorState.width} />
        )}
        <Tooltip label={t("Convert to basic Draw.io")}>
          <ActionIcon
            onClick={convertToDrawio}
            variant="default"
            size="sm"
          >
            <IconArrowBack size={16} />
          </ActionIcon>
        </Tooltip>
      </div>
    </BaseBubbleMenu>
  );
}

export default AiDrawioMenu;
