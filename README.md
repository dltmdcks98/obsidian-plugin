# Obsidian Immich Uploader

Obsidian plugin for uploading pasted, dropped, local, and migrated images to Immich with a user-configured Immich URL and dedicated API key.

## Features

- Configure Immich URL and API key in plugin settings.
- Automatically intercept image copy/paste and upload to Immich.
- Automatically intercept image drag/drop and upload to Immich.
- Upload and replace current-note local image embeds with Immich embeds.
- Migrate current-note or whole-vault Imgur markdown image links to Immich embeds.
- Store only Immich asset IDs in Markdown; no uploaded image copy is kept in the Vault.
- Render Immich embeds in Reading/Preview mode by fetching Immich thumbnails with the configured API key.

## Security

- Do not commit plugin `data.json`; it contains the Immich API key.
- Use a dedicated Immich account/API key with only the permissions needed for upload/read thumbnails.
- The API key is stored in Obsidian's plugin data file and is never written to notes, Markdown image URLs, or migration comments.
- Markdown stores `immich://asset/<asset-id>` only as a local custom scheme in an HTML `img` tag; it does not contain public `/photos/<asset-id>` URLs or `?apiKey=` URLs.

## Development

```bash
npm install
npm run build
```

## Install into the local vault

```bash
npm run install:vault
```

Target vault plugin directory:

```text
/Users/iseungchan/Library/Mobile Documents/iCloud~md~obsidian/Documents/Note/.obsidian/plugins/obsidian-immich-uploader
```

## Commands

- `Upload clipboard image to Immich`
- `Upload and replace current note local images with Immich links`
- `Migrate current note Imgur links to Immich (dry run)`
- `Migrate current note Imgur links to Immich`
- `Migrate all vault Imgur links to Immich (dry run)`
- `Migrate all vault Imgur links to Immich`
- `Rewrite current note Immich HTML image embeds`
- `Rewrite all vault Immich HTML image embeds`

## Link behavior

Stored Markdown:

```md
<img src="immich://asset/<asset-id>" data-immich-asset-id="<asset-id>" alt="image" /> <!-- immich-asset-id=<asset-id> source=https://i.imgur.com/abc123.jpg -->
```

The plugin detects the `data-immich-asset-id` or `src="immich://asset/<asset-id>"` value, then renders it by requesting:

```text
GET /api/assets/<asset-id>/thumbnail?size=preview
x-api-key: ***
```

The rendered element uses an in-memory `blob:app://obsidian...` URL. The API key is not written to Markdown, and no image copy is kept in the Vault for new paste/drop uploads or Imgur migrations.

## Display modes

- Reading/Preview mode: rendered through the Markdown postprocessor and DOM observer.
- Source mode, and the active editing line in Live Preview: shows raw Markdown/HTML by Obsidian design, so images are not expected to render there.
