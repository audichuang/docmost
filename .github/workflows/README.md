# GitHub Actions

## docker-build.yml

Push to `dev` (or trigger manually) → build the image, push to
`ghcr.io/<owner>/<repo>`, then tell the k3s manager to roll the deployment.

Tags produced: `<branch>` (sanitised — `feat/x` becomes `feat-x`),
`<branch>-<short-sha>`, and `latest` **only on `dev`** so a manually built
feature branch cannot overwrite what production pulls.

Manual builds of any branch other than `dev` skip the deploy job entirely —
building an image should never redeploy a running environment.

### Required secrets

`Settings → Secrets and variables → Actions`

| Secret | Value |
|---|---|
| `K8S_MANAGER_URL` | Base URL of the k3s manager that accepts the deploy webhook |
| `WEBHOOK_TOKEN` | Bearer token for that webhook |

The registry needs no secret — `GITHUB_TOKEN` is issued automatically and the
job requests `packages: write`.

### Package visibility — the one manual step

A package published to ghcr is **private on first publish**, even from a public
repo. Anything pulling it then needs credentials, which defeats the point.

After the first successful build: profile → Packages → `docmost` → Package
settings → Change visibility → Public. It stays public from then on.

Verify anonymously before wiring up any deployment:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:<owner>/<repo>:pull" | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  https://ghcr.io/v2/<owner>/<repo>/manifests/<tag>
```

`200` means any host can pull with no login. `401` means it is still private.

### Configuration

The `env:` block at the top of the workflow holds everything else — image name,
target platform, namespace, deployment name. `PLATFORMS` is `linux/amd64`
only; add `linux/arm64` there if you ever add arm nodes, but expect the build
to get significantly slower since it cross-builds under QEMU.
