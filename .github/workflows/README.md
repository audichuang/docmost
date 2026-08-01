# GitHub Actions

## docker-build.yml

Push to `dev` (or trigger manually) → build the image, push to Docker Hub, then
tell the k3s manager to roll the deployment.

Image tags produced: `latest`, `<branch>`, `<branch>-<sha>`.

### Required secrets

`Settings → Secrets and variables → Actions`

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub username — also the image namespace (`<username>/docmost`) |
| `DOCKERHUB_TOKEN` | Docker Hub access token (`Account Settings → Personal access tokens`, Read & Write) |
| `K8S_MANAGER_URL` | Base URL of the k3s manager that accepts the deploy webhook |
| `WEBHOOK_TOKEN` | Bearer token for that webhook |

### Configuration

The `env:` block at the top of the workflow holds everything else — image name,
target platform, namespace, deployment name. `PLATFORMS` is `linux/amd64`
only; add `linux/arm64` there if you ever add arm nodes, but expect the build
to get significantly slower since it cross-builds under QEMU.
