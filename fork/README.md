# Testing the `feat/unified-upload-routing` branch on another machine

The fork's `Fork Image Publish (GHCR)` workflow builds this branch into public, multi-architecture
images (linux/amd64 and linux/arm64):

| Image | Use with |
| --- | --- |
| `ghcr.io/usnavy13/librechat-dev:unified-upload-routing` | `docker-compose.yml` (single image, client included) |
| `ghcr.io/usnavy13/librechat-dev-api:unified-upload-routing` | `deploy-compose.yml` (api image behind nginx) |

Each build also tags both images with the short commit SHA of the `fork/image` branch, which is what
Settings → About shows as the build commit.

## Quick start

From a LibreChat checkout, or any folder holding the upstream `docker-compose.yml`:

```sh
curl -fsSLO https://raw.githubusercontent.com/usnavy13/LibreChat/fork/image/fork/docker-compose.override.yml
curl -fsSLO https://raw.githubusercontent.com/usnavy13/LibreChat/fork/image/fork/librechat.yaml
cp .env.example .env            # then add your provider keys as usual
docker compose pull && docker compose up -d
```

`librechat.yaml` here only sets `fileConfig.llmDeliveryPolicy: automatic`; merge that key into your
own configuration if you already have one. Run Code needs `LIBRECHAT_CODE_API_KEY` in `.env`, and
File Search needs the `rag_api` and `vectordb` services that the upstream compose file already defines.

## Rebuilding after new commits

```sh
git fetch fork
git switch fork/image
git merge feat/unified-upload-routing
git push fork fork/image           # triggers the workflow; ~6 minutes with a warm cache
```

To build a different branch, edit `SOURCE_BRANCH` and `IMAGE_TAG` in
`.github/workflows/fork-image.yml` on `fork/image`.
