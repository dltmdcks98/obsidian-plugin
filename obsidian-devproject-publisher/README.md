# DevProject Publisher 0.1.0

Candidate-only Obsidian plugin, minimum app 1.11.4; compiled against official API 1.13.1. No vault installation or real publication was performed.

## Workflow
Set an HTTPS origin (only explicit loopback development HTTP is accepted). Paste the administrator-issued BlogGrant, either the complete `BlogGrant selector.secret` or its bare credential. This is not an ADMIN JWT. Persistent grant storage requires `app.secretStorage`; no plaintext fallback exists. The 15-minute publisher session remains in memory. Logout verifies empty-string overwrite, drops its settings reference and clears memory; this is best-effort API behavior, not a promise of OS keychain deletion/encryption.

Run **선택한 노트 정적 미리보기 / 초안 저장**, choose public title/slug/summary and opt in to individual PNG/JPEG/static GIF/static WebP images. Animated GIF/WebP is deliberately rejected until a bounded animation decoder is implemented; it is not an accepted preview or upload format. Confirm local preview, explicitly save a draft, then inspect authenticated server preview. Only exact uppercase `PUBLISH` plus the separate publish button can publish. No create/editor/background publication hooks. UUID source mapping stays private in plugin data, survives rename, and is not written to note bodies. No original note modification or deletion.

Supported static elements: headings/emphasis/lists/tables/disabled task states/callouts/code/safe HTTPS links/local anchors/selected raster attachments. Frontmatter and private wiki links are stripped before invoking the official renderer in an owned component. Transclusions, dynamic fences/widgets, math/SVG/Mermaid, authored HTML and remote images are placeholders with warnings. No dependency note body reads, theme stylesheet scraping, arbitrary blob fetching or pixel-identical promise. Installed postprocessors may still execute locally inside the official renderer; tests use its signature mock, not the live application.

Asset uploads use original selected bytes and require authenticated GET hash/type/length verification. Draft/publish require UUID idempotency keys, CAS revisions and exact-target GET readback. Unknown outcomes retain private pending keys; there is no automatic retry. Explicit source-state lookup clears unknown state and requires a fresh modal/preview before further action. Concurrent vault/editor text, selection, path, settings or identity changes invalidate publication.

## Browser transport
The approved preview architecture uses internally generated, verified selected-byte `data:image/{png,jpeg,gif,webp};base64,...` URLs only inside the local opaque `sandbox=""` srcdoc, whose CSP permits `img-src data:` only and keeps scripts/connect disabled. `blob:` is never permitted. API export HTML and authenticated server previews retain canonical `/api/blog/assets/<UUID>` references under `img-src 'self'`; stored and public HTML never carries data URLs. Only static single-frame GIF/WebP is supported, and animation fails closed. Synthetic Chromium coverage verifies the transport boundary, but actual Obsidian desktop rendering remains unverified. Never enable scripts or same-origin to work around this.

## Reproduce
`npm ci --ignore-scripts --no-audit --no-fund`
`npm run build`
`npm test`

The VM tests execute real CommonJS `main.js` and generated module bundles with mocked Obsidian and denied unmocked networking. Chromium tests route a synthetic HTTPS origin wholly in memory and abort all other requests. Synthetic fixtures/screenshots are not live Obsidian Reading View, backend execution or physical mobile evidence; `isDesktopOnly:false` is not a mobile compatibility claim.

Install is a separate approval gate. `npm run install:plugin -- --destination <vault/.obsidian/plugins> --dry-run` lists intended copies only. An explicit `--approved-install` is required to copy built manifest/main/versions; existing data.json is never copied or overwritten. Do not run against a real vault until parent/user approval and exact-hash independent review.
