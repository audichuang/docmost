import classes from "@/features/editor/styles/editor.module.css";
import React from "react";
import { TitleEditor } from "@/features/editor/title-editor";
import PageEditor from "@/features/editor/page-editor";
import { Container, Alert } from "@mantine/core";
import { useAtom } from "jotai";
import { userAtom } from "@/features/user/atoms/current-user-atom.ts";
import { IconBrandGithub, IconLock } from "@tabler/icons-react";

const MemoizedTitleEditor = React.memo(TitleEditor);
const MemoizedPageEditor = React.memo(PageEditor);

export interface FullEditorProps {
  pageId: string;
  slugId: string;
  title: string;
  content: string;
  spaceSlug: string;
  editable: boolean;
  isLocked?: boolean;
}

export function FullEditor({
  pageId,
  title,
  slugId,
  content,
  spaceSlug,
  editable,
  isLocked = false,
}: FullEditorProps) {
  const [user] = useAtom(userAtom);
  const fullPageWidth = user.settings?.preferences?.fullPageWidth;

  return (
    <Container
      fluid={fullPageWidth}
      size={!fullPageWidth && 900}
      className={classes.editor}
    >
      {isLocked && (
        <Alert
          variant="light"
          color="blue"
          title="GitHub Managed (Read-Only)"
          icon={<IconBrandGithub size={16} />}
          mb="md"
          styles={{
            root: { borderLeft: "4px solid var(--mantine-color-blue-6)" },
          }}
        >
          This page is automatically synced from GitHub and is read-only in
          Docmost. To edit this content, please make changes in your GitHub
          repository.
        </Alert>
      )}
      <MemoizedTitleEditor
        pageId={pageId}
        slugId={slugId}
        title={title}
        spaceSlug={spaceSlug}
        editable={editable && !isLocked}
      />
      <MemoizedPageEditor
        pageId={pageId}
        editable={editable && !isLocked}
        content={content}
        isLocked={isLocked}
      />
    </Container>
  );
}
