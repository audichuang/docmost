import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

export interface AiDrawioOptions {
  HTMLAttributes: Record<string, any>;
  view: any;
}
export interface AiDrawioAttributes {
  src?: string;
  title?: string;
  size?: number;
  width?: string;
  align?: string;
  attachmentId?: string;
  xmlContent?: string;
  chatHistory?: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    aiDrawio: {
      setAiDrawio: (attributes?: AiDrawioAttributes) => ReturnType;
    };
  }
}

export const AiDrawio = Node.create<AiDrawioOptions>({
  name: "aiDrawio",
  inline: false,
  group: "block",
  isolating: true,
  atom: true,
  defining: true,
  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      view: null,
    };
  },

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-src'),
        renderHTML: (attributes) => ({
          'data-src': attributes.src,
        }),
      },
      title: {
        default: undefined,
        parseHTML: (element) => element.getAttribute('data-title'),
        renderHTML: (attributes: AiDrawioAttributes) => ({
          'data-title': attributes.title,
        }),
      },
      width: {
        default: '100%',
        parseHTML: (element) => element.getAttribute('data-width'),
        renderHTML: (attributes: AiDrawioAttributes) => ({
          'data-width': attributes.width,
        }),
      },
      size: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-size'),
        renderHTML: (attributes: AiDrawioAttributes) => ({
          'data-size': attributes.size,
        }),
      },
      align: {
        default: 'center',
        parseHTML: (element) => element.getAttribute('data-align'),
        renderHTML: (attributes: AiDrawioAttributes) => ({
          'data-align': attributes.align,
        }),
      },
      attachmentId: {
        default: undefined,
        parseHTML: (element) => element.getAttribute('data-attachment-id'),
        renderHTML: (attributes: AiDrawioAttributes) => ({
          'data-attachment-id': attributes.attachmentId,
        }),
      },
      xmlContent: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-xml-content'),
        renderHTML: (attributes: AiDrawioAttributes) => ({
          'data-xml-content': attributes.xmlContent,
        }),
      },
      chatHistory: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-chat-history'),
        renderHTML: (attributes: AiDrawioAttributes) => ({
          'data-chat-history': attributes.chatHistory,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[data-type="${this.name}"]`,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(
        { 'data-type': this.name },
        this.options.HTMLAttributes,
        HTMLAttributes
      ),
      ['img', { src: HTMLAttributes['data-src'], alt: HTMLAttributes['data-title'], width: HTMLAttributes['data-width'] }],
    ];
  },

  addCommands() {
    return {
      setAiDrawio:
        (attrs: AiDrawioAttributes) =>
          ({ commands }) => {
            return commands.insertContent({
              type: "aiDrawio",
              attrs: attrs,
            });
          },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(this.options.view);
  },
});
