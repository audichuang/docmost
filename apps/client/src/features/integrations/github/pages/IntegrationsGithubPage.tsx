import { Helmet } from "react-helmet-async";
import { getAppName } from "@/lib/config.ts";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { Stack, Title, Card, Grid, GridCol, Divider } from "@mantine/core";
import GithubInstallCard from "../components/GithubInstallCard";
import SourceTable from "../components/SourceTable";
import RepoSelector from "../components/RepoSelector";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { getSpaces } from "@/features/space/services/space-service";
import { listInstallations } from "../services/github-integration-api";

export default function IntegrationsGithubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: installations, refetch: refetchInstallations } = useQuery({
    queryKey: ["gh-installations"],
    queryFn: () => listInstallations(),
  });
  const { data: spaces } = useQuery({
    queryKey: ["spaces", { page: 1 }],
    queryFn: async () => (await getSpaces({ page: 1 })).items ?? [],
  });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const success = searchParams.get("success");
    const error = searchParams.get("error");

    if (success === "true") {
      notifications.show({
        title: "GitHub Connected",
        message: "Successfully connected GitHub App to your workspace",
        color: "green",
      });
      refetchInstallations();
      // Clear query params
      setSearchParams({});
    } else if (error) {
      const errorMessages: Record<string, string> = {
        missing_params: "Missing required parameters from GitHub",
        invalid_state: "Invalid state parameter",
        installation_not_found: "Installation not found on GitHub",
        server_error: "Server error occurred",
      };
      notifications.show({
        title: "Connection Failed",
        message: errorMessages[error] || "Failed to connect GitHub App",
        color: "red",
      });
      // Clear query params
      setSearchParams({});
    }
  }, [searchParams, refetchInstallations, setSearchParams]);

  return (
    <>
      <Helmet>
        <title>GitHub Integration - {getAppName()}</title>
      </Helmet>
      <SettingsTitle title={"GitHub Integration"} />

      <Stack gap="lg">
        <Grid>
          <GridCol span={{ base: 12, md: 6 }}>
            <GithubInstallCard
              installations={Array.isArray(installations) ? installations : []}
              onRefresh={() => refetchInstallations()}
            />
          </GridCol>
          <GridCol span={{ base: 12, md: 6 }}>
            <Card withBorder padding="lg">
              <Title order={5} mb="md">
                Add Source
              </Title>
              <RepoSelector
                installations={(Array.isArray(installations)
                  ? installations
                  : []
                ).map((i: any) => ({ id: i.id, accountLogin: i.accountLogin }))}
                spaces={(Array.isArray(spaces) ? spaces : []).map((s: any) => ({
                  id: s.id,
                  name: s.name,
                }))}
                onCreated={() => setRefreshToken((t) => t + 1)}
              />
            </Card>
          </GridCol>
        </Grid>

        <Divider />

        <div>
          <Title order={5} mb="md">
            Sources
          </Title>
          <Card withBorder padding="lg">
            <SourceTable
              spaces={(Array.isArray(spaces) ? spaces : []).map((s: any) => ({
                id: s.id,
                name: s.name,
              }))}
              refreshToken={refreshToken}
            />
          </Card>
        </div>
      </Stack>
    </>
  );
}
