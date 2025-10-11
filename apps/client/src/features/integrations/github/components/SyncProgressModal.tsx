import { useEffect, useState } from "react";
import {
  Modal,
  Stack,
  Text,
  Progress,
  Group,
  ThemeIcon,
  Alert,
  Loader,
  Box,
  Center,
  RingProgress,
} from "@mantine/core";
import {
  IconCheck,
  IconAlertCircle,
  IconBrandGithub,
  IconDownload,
  IconCloudUpload,
} from "@tabler/icons-react";

type ProgressEvent = {
  type:
    | "init"
    | "fetching_tree"
    | "tree_fetched"
    | "syncing_files"
    | "file_synced"
    | "completed"
    | "error";
  message: string;
  progress?: {
    current: number;
    total: number;
  };
  data?: any;
};

type StepStatus = "pending" | "loading" | "completed" | "error";

type ProgressStep = {
  label: string;
  status: StepStatus;
  icon: React.ReactNode;
};

export default function SyncProgressModal({
  opened,
  onClose,
  jobId,
}: {
  opened: boolean;
  onClose: () => void;
  jobId: string | null;
}) {
  const [steps, setSteps] = useState<ProgressStep[]>([
    {
      label: "Initializing sync",
      status: "pending",
      icon: <IconBrandGithub size={18} />,
    },
    {
      label: "Fetching repository tree",
      status: "pending",
      icon: <IconDownload size={18} />,
    },
    {
      label: "Syncing files",
      status: "pending",
      icon: <IconCloudUpload size={18} />,
    },
  ]);
  const [currentMessage, setCurrentMessage] = useState("Waiting to start...");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    if (!jobId || !opened) {
      console.log("[SyncProgressModal] Not opening SSE:", { jobId, opened });
      return;
    }

    console.log("[SyncProgressModal] Opening SSE connection for jobId:", jobId);

    const eventSource = new EventSource(
      `/api/integrations/github/sources/progress/${jobId}`,
      {
        withCredentials: true,
      },
    );

    eventSource.onmessage = (event) => {
      try {
        console.log("[SSE] Raw event:", event.data);

        // NestJS SSE format: data field contains our event object
        const parsed = JSON.parse(event.data);
        console.log("[SSE] Parsed:", parsed);

        // Extract the actual data (NestJS wraps it in { data: ... })
        const data: ProgressEvent = parsed.data || parsed;
        console.log("[SSE] Event data:", data);

        setCurrentMessage(data.message);

        switch (data.type) {
          case "init":
            setSteps((prev) => [
              { ...prev[0], status: "loading" },
              prev[1],
              prev[2],
            ]);
            break;

          case "fetching_tree":
            setSteps((prev) => [
              { ...prev[0], status: "completed" },
              { ...prev[1], status: "loading" },
              prev[2],
            ]);
            break;

          case "tree_fetched":
            setSteps((prev) => [
              prev[0],
              { ...prev[1], status: "completed" },
              prev[2],
            ]);
            if (data.data?.totalFiles !== undefined) {
              setProgress({ current: 0, total: data.data.totalFiles });
            }
            break;

          case "syncing_files":
          case "file_synced":
            setSteps((prev) => [
              { ...prev[0], status: "completed" },
              { ...prev[1], status: "completed" },
              { ...prev[2], status: "loading" },
            ]);
            if (data.progress) {
              setProgress(data.progress);
            }
            break;

          case "completed":
            setSteps((prev) => [
              { ...prev[0], status: "completed" },
              { ...prev[1], status: "completed" },
              { ...prev[2], status: "completed" },
            ]);
            setCompleted(true);
            // Auto close after 2 seconds
            setTimeout(() => {
              eventSource.close();
              onClose();
            }, 2000);
            break;

          case "error":
            setSteps((prev) =>
              prev.map((step) =>
                step.status === "loading" ? { ...step, status: "error" } : step,
              ),
            );
            setError(data.message);
            eventSource.close();
            break;
        }
      } catch (err) {
        console.error("Failed to parse SSE event:", err);
      }
    };

    eventSource.onerror = () => {
      console.error("SSE connection error");
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [jobId, opened, onClose]);

  const getStepStatusColor = (status: StepStatus) => {
    switch (status) {
      case "completed":
        return "teal";
      case "loading":
        return "blue";
      case "error":
        return "red";
      default:
        return "gray";
    }
  };

  const progressPercentage =
    progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
  const currentStepIndex = steps.findIndex((s) => s.status === "loading");

  console.log("[SyncProgressModal] Render:", {
    opened,
    jobId,
    progress,
    completed,
    error,
  });

  return (
    <Modal.Root
      opened={opened}
      onClose={completed || error ? onClose : () => {}}
      size={520}
      padding="xl"
      closeOnClickOutside={completed || !!error}
      closeOnEscape={completed || !!error}
    >
      <Modal.Overlay blur={2} />
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>
            <Group gap="xs">
              <IconBrandGithub size={20} />
              <Text fw={500}>GitHub Sync</Text>
            </Group>
          </Modal.Title>
          {(completed || error) && <Modal.CloseButton />}
        </Modal.Header>

        <Modal.Body>
          <Stack gap="xl">
            {/* Progress Ring */}
            {!error && (
              <Center>
                <Box pos="relative">
                  <RingProgress
                    size={140}
                    thickness={12}
                    roundCaps
                    sections={[
                      {
                        value: completed ? 100 : progressPercentage,
                        color: completed ? "teal" : "blue",
                      },
                    ]}
                    label={
                      <Center>
                        {completed ? (
                          <ThemeIcon
                            color="teal"
                            size={50}
                            radius="xl"
                            variant="light"
                          >
                            <IconCheck size={28} />
                          </ThemeIcon>
                        ) : (
                          <Stack gap={4} align="center">
                            <Loader size="sm" />
                            <Text size="xs" c="dimmed" fw={500}>
                              {progress.total > 0
                                ? `${progress.current}/${progress.total}`
                                : "Starting..."}
                            </Text>
                          </Stack>
                        )}
                      </Center>
                    }
                  />
                </Box>
              </Center>
            )}

            {/* Error Alert */}
            {error && (
              <Alert
                icon={<IconAlertCircle size={18} />}
                title="Sync Failed"
                color="red"
                variant="light"
              >
                {error}
              </Alert>
            )}

            {/* Steps */}
            <Stack gap="sm">
              {steps.map((step, index) => {
                const isActive = step.status === "loading";
                const isCompleted = step.status === "completed";
                const color = getStepStatusColor(step.status);

                return (
                  <Group key={index} gap="sm" wrap="nowrap">
                    <ThemeIcon
                      size={32}
                      radius="xl"
                      variant={
                        isCompleted ? "light" : isActive ? "filled" : "outline"
                      }
                      color={color}
                    >
                      {isCompleted ? (
                        <IconCheck size={16} />
                      ) : isActive ? (
                        <Loader size={16} color="white" />
                      ) : (
                        step.icon
                      )}
                    </ThemeIcon>
                    <Box style={{ flex: 1 }}>
                      <Text
                        size="sm"
                        fw={isActive ? 500 : 400}
                        c={isCompleted ? "dimmed" : undefined}
                      >
                        {step.label}
                      </Text>
                      {isActive && progress.total > 0 && (
                        <Text size="xs" c="dimmed" mt={2}>
                          {currentMessage}
                        </Text>
                      )}
                    </Box>
                  </Group>
                );
              })}
            </Stack>

            {/* Progress Bar (only during file sync) */}
            {progress.total > 0 && !completed && !error && (
              <Stack gap="xs">
                <Progress
                  value={progressPercentage}
                  size="sm"
                  radius="xl"
                  animated
                  striped
                  color="blue"
                />
              </Stack>
            )}

            {/* Success Message */}
            {completed && (
              <Alert
                icon={<IconCheck size={18} />}
                color="teal"
                variant="light"
              >
                <Text size="sm">
                  Successfully synced {progress.total} files to Docmost
                </Text>
              </Alert>
            )}
          </Stack>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
