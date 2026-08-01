import { useState } from "react";
import { Button, Group, Stack, TextInput } from "@mantine/core";
import { modals } from "@mantine/modals";
import { sanitizeUrl } from "@docmost/editor-ext";
import i18n from "i18next";
import { Editor } from "@tiptap/react";

const MODAL_ID = "image-from-url";

function ImageUrlForm({ editor }: { editor: Editor }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    // sanitizeUrl turns anything script-ish into about:blank
    const safe = sanitizeUrl(trimmed);
    if (!safe || safe === "about:blank") {
      setError(i18n.t("Enter a valid http(s) image URL"));
      return;
    }

    editor.chain().focus().insertContent({ type: "image", attrs: { src: safe } }).run();
    modals.close(MODAL_ID);
  };

  return (
    <Stack gap="sm">
      <TextInput
        placeholder="https://example.com/image.png"
        value={url}
        error={error}
        onChange={(event) => {
          setUrl(event.currentTarget.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
        data-autofocus
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={() => modals.close(MODAL_ID)}>
          {i18n.t("Cancel")}
        </Button>
        <Button onClick={submit} disabled={!url.trim()}>
          {i18n.t("Insert")}
        </Button>
      </Group>
    </Stack>
  );
}

export function openImageUrlModal(editor: Editor) {
  modals.open({
    modalId: MODAL_ID,
    title: i18n.t("Image from URL"),
    children: <ImageUrlForm editor={editor} />,
  });
}
