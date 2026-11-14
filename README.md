# Tacview ACMI Web Viewer

A browser-only viewer and analyser for Tacview `.acmi` recordings. Recordings are opened and analysed
entirely in the browser; nothing is uploaded anywhere.

It has two pages that link to each other:

- **`index.html`: single-file viewer.** Open one recording to see a map, the kill log, shots and
  optional missile analytics for that recording.
- **`analytics.html`: multi-file analytics.** Load many recordings (or a saved dataset bundle) for
  missile statistics, fitted missile flyout models and the BVR timeline validator.

## Requirements

- [Node.js](https://nodejs.org/) 24 or newer
- [pnpm](https://pnpm.io/) 12 (`corepack enable` picks the version pinned in `package.json`)

## Development

```bash
pnpm install
```

```bash
pnpm dev
```

The dev server prints a local URL; the analytics page is at `/analytics.html` (or run `pnpm dev:analytics`).

Checks:

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm lint
```

## Making a release

1. Start from a clean checkout of the commit you want to release and install exactly the locked
   dependencies:

   ```bash
   pnpm install --frozen-lockfile
   ```

2. Run the tests, then build. `pnpm build` type-checks first and stops if that fails.

   ```bash
   pnpm test
   ```

   ```bash
   pnpm build
   ```

3. **Upload the contents of the `dist/` folder.** That folder is the whole website:

   ```text
   dist/
   ├── index.html        single-file viewer (the page visitors land on)
   ├── analytics.html    multi-file analytics
   ├── assets/           scripts, workers and styles (file names carry a content hash)
   └── samples/          the sample recordings behind the "Load sample" buttons (copied from public/)
   ```

   Copy everything *inside* `dist/` to the folder on your web server where the viewer should live,
   for example `https://example.com/` or `https://example.com/tools/tacview/`.

   To check a build locally before uploading, run `pnpm preview`.

### Hosting notes

- **Any subfolder works.** All links and asset paths are relative (`base: "./"` in
  `vite.config.ts`), so the same `dist/` works at a site's root or at any depth of subfolder, with no
  rebuild or configuration.
- **Any static web server works.** There is no server-side code, and the site makes no requests to
  other sites. The server only needs to send `.js` files as JavaScript, which every common server does.
- **It must be served over HTTP(S).** Opening `dist/index.html` straight from disk (`file://`) does
  not work, because browsers block the module scripts and web workers it uses.
- **Replace the old files on each release.** Asset names change with every build, so delete the
  previous release's `assets/` folder when uploading (or upload into an empty folder) to avoid
  leaving stale files behind.
- **Removing the sample files.** `samples/` is about 9 MB. If you don't want to host it, delete
  `dist/samples/` before uploading; only the "Load sample" buttons stop working.
