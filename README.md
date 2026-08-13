# Obsidian Immich Uploader

Obsidian plugin for uploading pasted, dropped, and migrated images to Immich with a user-configured Immich URL and dedicated API key.

## Features

- Configure Immich URL and API key in plugin settings.
- Automatically intercept image copy/paste and upload to Immich.
- Automatically intercept image drag/drop and upload to Immich.
- Insert `![](immich://asset/<asset-id>)` links instead of writing image files into the Vault.
- Render `immich://asset/<asset-id>` images in reading/preview mode by fetching Immich thumbnails with the configured API key.
- Upload and replace current-note local image embeds with Immich links.
- Migrate current-note or whole-vault Imgur markdown image links to Immich links.

## Security

- Do not commit plugin `data.json`; it contains the Immich API key.
- Use a dedicated Immich account/API key with only the permissions needed for upload/read thumbnails.
- The API key is stored in Obsidian's plugin data file and is never written to notes, Markdown image URLs, or migration comments.
- Markdown uses `immich://asset/<asset-id>`, not public `/photos/<asset-id>` URLs and not `?apiKey=` URLs.

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

## Link behavior

Stored Markdown:

```md
![](immich://asset/<asset-id>) <!-- immich-asset-id=<asset-id> source=https://i.imgur.com/abc123.jpg -->
```

The plugin renders this by requesting:

```text
GET /api/assets/<asset-id>/thumbnail?size=preview
x-api-key: <configured key>
```

No image copy is kept in the Vault for new paste/drop uploads or Imgur migrations.
