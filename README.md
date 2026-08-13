# Obsidian Immich Uploader

Obsidian plugin for uploading pasted/local note images to Immich with a user-configured Immich URL and dedicated API key.

## Features

- Configure Immich URL and API key in the plugin settings.
- Upload clipboard image to Immich.
- Upload local image embeds from the current note to Immich.
- Migrate current-note Imgur markdown image links to Immich.
- Default migration keeps local Obsidian embeds and appends an `immich-asset-id` HTML comment, because Immich photo URLs usually require authentication and may not render like public Imgur URLs.

## Security

- Do not commit plugin `data.json`; it may contain the Immich API key.
- Use a dedicated Immich account/API key with only the permissions needed for upload.
- The API key is stored in Obsidian's plugin data file, not in notes.

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
- `Upload current note local images to Immich`
- `Migrate current note Imgur links to Immich (dry run)`
- `Migrate current note Imgur links to Immich`

## Imgur migration behavior

Default replacement:

```md
![[Attachments/Immich Migrated/imgur-abc123.jpg]] <!-- immich-asset-id=<asset-id> source=https://i.imgur.com/abc123.jpg -->
```

Optional Immich-link replacement:

```md
![alt](https://immich.example.com/photos/<asset-id>) <!-- immich-asset-id=<asset-id> source=https://i.imgur.com/abc123.jpg -->
```

The local-embed mode is recommended for reliable Obsidian rendering.
