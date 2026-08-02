import "@mantine/core/styles.css";
import "@mantine/spotlight/styles.css";
import "@mantine/notifications/styles.css";
import '@mantine/dates/styles.css';
import "@/styles/a11y-overrides.css";

import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { mantineCssResolver, theme } from "@/theme";
import { MantineProvider } from "@mantine/core";
import { BrowserRouter } from "react-router-dom";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HelmetProvider } from "react-helmet-async";
import "./i18n";
import { PostHogProvider } from "posthog-js/react";
import {
  getPostHogHost,
  getPostHogKey,
  isCloud,
  isPostHogEnabled,
} from "@/lib/config.ts";
import posthog from "posthog-js";
import { appendR2Token, startR2TokenRefresh } from "@/lib/r2-token.ts";
import { setFileUrlTransformer } from "@docmost/editor-ext";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

if (isCloud() && isPostHogEnabled) {
  posthog.init(getPostHogKey(), {
    api_host: getPostHogHost(),
    defaults: "2025-05-24",
    disable_session_recording: true,
    capture_pageleave: false,
  });
}

const container = document.getElementById("root") as HTMLElement;
const root = (container as any).__reactRoot ??= ReactDOM.createRoot(container);

// The token is appended synchronously while rendering and nothing re-renders
// when one arrives late, so the first token has to be resolved before anything
// paints. The fetch inside is time-bounded, so an unreachable token endpoint
// delays startup by seconds rather than blanking the app. Resolves immediately
// when R2 protection is disabled.
await startR2TokenRefresh();

// Editor media (image/video/audio/drawio/excalidraw) is rendered by plain DOM
// node views in editor-ext, which build their src through normalizeFileUrl —
// not through getFileUrl. Without this the token reaches only the upload
// placeholder's React view, i.e. no real image ever gets one.
setFileUrlTransformer(appendR2Token);

root.render(
  <BrowserRouter>
    <MantineProvider theme={theme} cssVariablesResolver={mantineCssResolver}>
      <ModalsProvider>
        <QueryClientProvider client={queryClient}>
          <Notifications position="bottom-center" limit={3} zIndex={10000} />
          <HelmetProvider>
            <PostHogProvider client={posthog}>
              <App />
            </PostHogProvider>
          </HelmetProvider>
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>
  </BrowserRouter>,
);
