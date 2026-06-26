# syntax=docker/dockerfile:1

# ---- builder: install all deps (compiles better-sqlite3), build dist/, drop devDeps ----
FROM node:22-bookworm AS builder
WORKDIR /app

# Full bookworm image carries python3/make/g++ so node-gyp can build better-sqlite3.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip devDeps (tsc/tsx/vitest/rimraf/@types) — runtime ships dist/, so the
# ingest skills run `node dist/ingest/*.js` and never need tsx. Keeps the
# compiled better-sqlite3 binary and the agent SDK (which bundles the CLI).
RUN npm prune --omit=dev

# ---- runtime: slim image with the build, prod deps, and the document toolchain ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Document skills (skills/documents/<fmt>) need the full office toolchain:
#   libreoffice (soffice) — .doc->.docx, ->pdf, render; pandoc — docx->markdown;
#   qpdf — pdf repair/split/merge; fonts-liberation — sane default fonts for
#   rendering; unzip — unpacking ooxml. git + ca-certificates for the agent's
#   tooling and TLS. python3-venv keeps pip off Debian's managed system env
#   (PEP 668). NO tesseract/OCR by design — images go to model vision; PDFs use
#   pypdfium2's bundled engine.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git \
      libreoffice-calc libreoffice-writer libreoffice-impress \
      pandoc qpdf fonts-liberation unzip \
      python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Python venv for the document skills, isolated from system Python. Putting
# /opt/venv/bin first on PATH makes `python`/`python3`/`pip` resolve to it, so
# the vendored skills' `python scripts/...` calls hit these libraries.
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
RUN pip install --no-cache-dir \
      python-docx openpyxl python-pptx pdfplumber pypdf pypdfium2

# App: pruned node_modules + compiled build, plus the runtime-read files
# (skills are copied into the hub at boot; sources.config.json is read by ingest).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY skills ./skills
COPY sources.config.json ./

# PROJECT_ROOT = process.cwd() = /app; HUB_DIR defaults to /app/hub (bind-mounted).
ENV NODE_ENV=production

# The bundled Claude Code CLI refuses --dangerously-skip-permissions (which the
# SDK passes for bypassPermissions mode) when running as root — UNLESS it knows
# it's in a sandbox. A container is exactly that; IS_SANDBOX=1 is the sanctioned
# escape hatch. We stay root (not the `node` user) on purpose: the hub is a
# Windows bind mount where non-root uid mapping is unreliable, so root avoids
# EACCES on the hub. Isolation comes from the container, not the in-container uid.
ENV IS_SANDBOX=1
CMD ["node", "dist/index.js"]
