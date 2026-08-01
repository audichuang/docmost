import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Alert, Stack } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { getAppName } from "@/lib/config.ts";
import GithubConnectCard from "@/features/integrations/github/components/github-connect-card.tsx";
import GithubSourceForm from "@/features/integrations/github/components/github-source-form.tsx";
import GithubSourceList from "@/features/integrations/github/components/github-source-list.tsx";

export default function GithubIntegration() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  // the GitHub App callback bounces back here with the outcome in the query
  useEffect(() => {
    const success = searchParams.get("success");
    const error = searchParams.get("error");
    if (!success && !error) return;

    notifications.show({
      message: success ? t("GitHub connected") : t("GitHub connection failed: {{error}}", { error }),
      color: success ? "green" : "red",
    });

    searchParams.delete("success");
    searchParams.delete("error");
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams, t]);

  return (
    <>
      <Helmet>
        <title>
          {t("GitHub")} - {getAppName()}
        </title>
      </Helmet>
      <SettingsTitle title={t("GitHub")} />

      <Alert variant="light" color="blue" icon={<IconInfoCircle />} mb="md">
        {t(
          "Sync markdown files from a GitHub repository into a space. Synced pages are read-only and update automatically when you push.",
        )}
      </Alert>

      <Stack gap="md">
        <GithubConnectCard />
        <GithubSourceForm onSyncStarted={setActiveJobId} />
        <GithubSourceList
          activeJobId={activeJobId}
          onSyncStarted={setActiveJobId}
        />
      </Stack>
    </>
  );
}
