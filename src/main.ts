import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  RequestUrlParam,
  Setting,
  TFile,
} from 'obsidian';

interface ImmichUploaderSettings {
  immichUrl: string;
  apiKey: string;
  deviceId: string;
  keepLocalAttachmentLink: boolean;
  appendAssetComment: boolean;
  replaceImgurLinksWith: 'immich' | 'local';
  localMigrationFolder: string;
}

interface ImmichUploadResponse {
  id?: string;
  duplicate?: boolean;
  [key: string]: unknown;
}

interface ImgurCandidate {
  markdown: string;
  url: string;
  alt: string;
  start: number;
  end: number;
}

const DEFAULT_SETTINGS: ImmichUploaderSettings = {
  immichUrl: '',
  apiKey: '',
  deviceId: 'obsidian',
  keepLocalAttachmentLink: true,
  appendAssetComment: true,
  replaceImgurLinksWith: 'local',
  localMigrationFolder: 'Attachments/Immich Migrated',
};

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?)$/i;
const IMGUR_MARKDOWN_RE = /!\[([^\]]*)\]\((https?:\/\/(?:i\.)?imgur\.com\/[^\s)]+)\)/g;
const IMGUR_URL_RE = /^https?:\/\/(?:i\.)?imgur\.com\//i;

export default class ImmichUploaderPlugin extends Plugin {
  settings: ImmichUploaderSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ImmichUploaderSettingTab(this.app, this));

    this.addCommand({
      id: 'upload-clipboard-image-to-immich',
      name: 'Upload clipboard image to Immich',
      editorCallback: async (editor) => this.uploadClipboardImage(editor),
    });

    this.addCommand({
      id: 'upload-current-note-local-images-to-immich',
      name: 'Upload current note local images to Immich',
      callback: async () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          new Notice('No active markdown note.');
          return;
        }
        await this.uploadCurrentNoteLocalImages(view);
      },
    });

    this.addCommand({
      id: 'migrate-current-note-imgur-links-dry-run',
      name: 'Migrate current note Imgur links to Immich (dry run)',
      editorCallback: async (editor) => this.migrateCurrentNoteImgurLinks(editor, true),
    });

    this.addCommand({
      id: 'migrate-current-note-imgur-links',
      name: 'Migrate current note Imgur links to Immich',
      editorCallback: async (editor) => this.migrateCurrentNoteImgurLinks(editor, false),
    });

    this.addCommand({
      id: 'migrate-vault-imgur-links-dry-run',
      name: 'Migrate all vault Imgur links to Immich (dry run)',
      callback: async () => this.migrateVaultImgurLinks(true),
    });

    this.addCommand({
      id: 'migrate-vault-imgur-links',
      name: 'Migrate all vault Imgur links to Immich',
      callback: async () => this.migrateVaultImgurLinks(false),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  assertConfigured() {
    if (!this.settings.immichUrl.trim() || !this.settings.apiKey.trim()) {
      throw new Error('Immich URL and API key are required in plugin settings.');
    }
  }

  normalizedImmichApiBase(): string {
    const raw = this.settings.immichUrl.trim().replace(/\/+$/, '');
    if (raw.endsWith('/api')) return raw;
    return `${raw}/api`;
  }

  async uploadClipboardImage(editor: Editor) {
    try {
      this.assertConfigured();
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const ext = mimeToExt(imageType);
        const fileName = `obsidian-clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
        const file = new File([blob], fileName, { type: imageType, lastModified: Date.now() });
        const result = await this.uploadFileToImmich(file, fileName, undefined, undefined, await sha256Hex(await file.arrayBuffer()));
        const embed = this.renderUploadedEmbed(fileName, result, null);
        editor.replaceSelection(embed);
        new Notice(`Uploaded clipboard image to Immich${result.id ? `: ${result.id}` : ''}`);
        return;
      }
      new Notice('No image found in clipboard.');
    } catch (error) {
      console.error(error);
      new Notice(`Immich upload failed: ${messageOf(error)}`);
    }
  }

  async uploadCurrentNoteLocalImages(view: MarkdownView) {
    try {
      this.assertConfigured();
      const file = view.file;
      if (!file) throw new Error('No active note.');
      const text = await this.app.vault.read(file);
      const localEmbeds = [...text.matchAll(/!\[\[([^\]]+\.(?:png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?)(?:\|[^\]]*)?)\]\]/gi)];
      let uploaded = 0;
      for (const match of localEmbeds) {
        const rawTarget = match[1].split('|')[0];
        const linked = this.app.metadataCache.getFirstLinkpathDest(rawTarget, file.path);
        if (!(linked instanceof TFile)) continue;
        await this.uploadVaultFileToImmich(linked);
        uploaded++;
      }
      new Notice(`Uploaded ${uploaded} local image(s) to Immich.`);
    } catch (error) {
      console.error(error);
      new Notice(`Local image upload failed: ${messageOf(error)}`);
    }
  }

  async migrateCurrentNoteImgurLinks(editor: Editor, dryRun: boolean) {
    try {
      this.assertConfigured();
      const content = editor.getValue();
      const candidates = findImgurMarkdownImages(content);
      if (dryRun) {
        new MigrationPreviewModal(this.app, candidates).open();
        return;
      }
      if (!candidates.length) {
        new Notice('No Imgur markdown images found in current note.');
        return;
      }
      let next = content;
      let migrated = 0;
      for (const candidate of candidates) {
        const upload = await this.downloadImgurAndUpload(candidate);
        const replacement = this.settings.replaceImgurLinksWith === 'immich'
          ? `![${escapeAlt(candidate.alt)}](${this.assetViewUrl(upload.result.id)})${this.renderAssetComment(upload.result, candidate.url)}`
          : `![[${upload.localPath}]]${this.renderAssetComment(upload.result, candidate.url)}`;
        next = next.replace(candidate.markdown, replacement);
        migrated++;
      }
      editor.setValue(next);
      new Notice(`Migrated ${migrated} Imgur image(s) to Immich.`);
    } catch (error) {
      console.error(error);
      new Notice(`Imgur migration failed: ${messageOf(error)}`);
    }
  }

  async migrateVaultImgurLinks(dryRun: boolean) {
    try {
      this.assertConfigured();
      const files = this.app.vault.getMarkdownFiles();
      const plan: Array<{ file: TFile; candidates: ImgurCandidate[] }> = [];
      for (const file of files) {
        const content = await this.app.vault.read(file);
        const candidates = findImgurMarkdownImages(content);
        if (candidates.length) plan.push({ file, candidates });
      }
      if (dryRun) {
        new VaultMigrationPreviewModal(this.app, plan).open();
        return;
      }
      let fileCount = 0;
      let imageCount = 0;
      for (const entry of plan) {
        let next = await this.app.vault.read(entry.file);
        for (const candidate of entry.candidates) {
          const upload = await this.downloadImgurAndUpload(candidate);
          const replacement = this.settings.replaceImgurLinksWith === 'immich'
            ? `![${escapeAlt(candidate.alt)}](${this.assetViewUrl(upload.result.id)})${this.renderAssetComment(upload.result, candidate.url)}`
            : `![[${upload.localPath}]]${this.renderAssetComment(upload.result, candidate.url)}`;
          next = next.replace(candidate.markdown, replacement);
          imageCount++;
        }
        await this.app.vault.modify(entry.file, next);
        fileCount++;
      }
      new Notice(`Migrated ${imageCount} Imgur image(s) in ${fileCount} note(s) to Immich.`);
    } catch (error) {
      console.error(error);
      new Notice(`Vault Imgur migration failed: ${messageOf(error)}`);
    }
  }

  async downloadImgurAndUpload(candidate: ImgurCandidate): Promise<{ result: ImmichUploadResponse; localPath: string }> {
    const resp = await requestUrl({ url: candidate.url, method: 'GET', throw: false });
    if (resp.status >= 400) throw new Error(`Failed to download ${candidate.url}: HTTP ${resp.status}`);
    const contentType = header(resp.headers, 'content-type') || guessMime(candidate.url);
    const ext = extFromUrl(candidate.url) || mimeToExt(contentType);
    const fileName = safeFileName(`imgur-${basenameWithoutQuery(candidate.url) || crypto.randomUUID()}.${ext}`);
    const folder = normalizeVaultFolder(this.settings.localMigrationFolder);
    if (folder) await this.ensureVaultFolder(folder);
    const localPath = folder ? `${folder}/${fileName}` : fileName;
    const arrayBuffer = resp.arrayBuffer;
    await this.app.vault.adapter.writeBinary(localPath, arrayBuffer);
    const file = new File([arrayBuffer], fileName, { type: contentType, lastModified: Date.now() });
    const result = await this.uploadFileToImmich(file, fileName, undefined, undefined, await sha256Hex(arrayBuffer));
    return { result, localPath };
  }

  async uploadVaultFileToImmich(file: TFile): Promise<ImmichUploadResponse> {
    const data = await this.app.vault.readBinary(file);
    const mime = guessMime(file.name);
    const uploadFile = new File([data], file.name, { type: mime, lastModified: file.stat.mtime });
    return this.uploadFileToImmich(uploadFile, file.path, new Date(file.stat.ctime), new Date(file.stat.mtime), await sha256Hex(data));
  }

  async uploadFileToImmich(
    file: File,
    originalPath: string,
    createdAt = new Date(file.lastModified || Date.now()),
    modifiedAt = new Date(file.lastModified || Date.now()),
    sha256?: string,
  ): Promise<ImmichUploadResponse> {
    const requestData = new FormData();
    requestData.append('assetData', file, file.name);
    requestData.append('deviceAssetId', stableDeviceAssetId(originalPath, file.size, modifiedAt, sha256));
    requestData.append('deviceId', this.settings.deviceId || 'obsidian');
    requestData.append('fileCreatedAt', createdAt.toISOString());
    requestData.append('fileModifiedAt', modifiedAt.toISOString());
    requestData.append('isFavorite', 'false');

    const { body, contentType } = await prepareMultipartRequest(requestData);
    const req: RequestUrlParam = {
      url: `${this.normalizedImmichApiBase()}/assets`,
      method: 'POST',
      headers: {
        'x-api-key': this.settings.apiKey.trim(),
        'Accept': 'application/json',
        'Content-Type': contentType,
      },
      body,
      throw: false,
    };
    const resp = await requestUrl(req);
    if (resp.status >= 400) {
      throw new Error(`Immich upload HTTP ${resp.status}: ${resp.text?.slice(0, 300)}`);
    }
    return resp.json as ImmichUploadResponse;
  }

  renderUploadedEmbed(fileName: string, result: ImmichUploadResponse, localPath: string | null): string {
    const comment = this.renderAssetComment(result, null);
    if (this.settings.keepLocalAttachmentLink && localPath) return `![[${localPath}]]${comment}`;
    if (result.id && !this.settings.keepLocalAttachmentLink) return `![${escapeAlt(fileName)}](${this.assetViewUrl(result.id)})${comment}`;
    if (result.id) return `![${escapeAlt(fileName)}](${this.assetViewUrl(result.id)})${comment}`;
    return comment || '';
  }

  renderAssetComment(result: ImmichUploadResponse, sourceUrl: string | null): string {
    if (!this.settings.appendAssetComment || !result.id) return '';
    const source = sourceUrl ? ` source=${sourceUrl}` : '';
    return ` <!-- immich-asset-id=${result.id}${source} -->`;
  }

  assetViewUrl(assetId?: string): string {
    if (!assetId) return this.settings.immichUrl.trim();
    return `${this.settings.immichUrl.trim().replace(/\/+$/, '')}/photos/${assetId}`;
  }

  async ensureVaultFolder(folder: string) {
    const parts = folder.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}

class ImmichUploaderSettingTab extends PluginSettingTab {
  plugin: ImmichUploaderPlugin;

  constructor(app: App, plugin: ImmichUploaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Immich Uploader' });

    new Setting(containerEl)
      .setName('Immich URL')
      .setDesc('Example: https://immich.example.com or http://192.168.50.20:2283')
      .addText((text) => text
        .setPlaceholder('https://immich.example.com')
        .setValue(this.plugin.settings.immichUrl)
        .onChange(async (value) => {
          this.plugin.settings.immichUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Immich API key')
      .setDesc('Use a dedicated Immich account/key with asset upload permission. The key is stored in this plugin data.json and is not written to notes.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Paste API key')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Device ID')
      .setDesc('Immich duplicate detection uses deviceId + deviceAssetId. Keep this stable.')
      .addText((text) => text
        .setValue(this.plugin.settings.deviceId)
        .onChange(async (value) => {
          this.plugin.settings.deviceId = value.trim() || 'obsidian';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Keep local attachment links')
      .setDesc('Recommended. Upload to Immich but keep Obsidian embeds local so notes still render without Immich auth cookies.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.keepLocalAttachmentLink)
        .onChange(async (value) => {
          this.plugin.settings.keepLocalAttachmentLink = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Append Immich asset comment')
      .setDesc('Adds an HTML comment with the Immich asset ID after migrated/uploaded embeds.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.appendAssetComment)
        .onChange(async (value) => {
          this.plugin.settings.appendAssetComment = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Imgur migration replacement')
      .setDesc('Local keeps images visible in Obsidian. Immich inserts /photos/<assetId> links, which may require login to render.')
      .addDropdown((dropdown) => dropdown
        .addOption('local', 'Local attachment embed + Immich asset comment')
        .addOption('immich', 'Immich photo URL')
        .setValue(this.plugin.settings.replaceImgurLinksWith)
        .onChange(async (value: 'immich' | 'local') => {
          this.plugin.settings.replaceImgurLinksWith = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Imgur migration local folder')
      .setDesc('Used when migrating Imgur links and keeping local embeds.')
      .addText((text) => text
        .setValue(this.plugin.settings.localMigrationFolder)
        .onChange(async (value) => {
          this.plugin.settings.localMigrationFolder = normalizeVaultFolder(value);
          await this.plugin.saveSettings();
        }));
  }
}

class MigrationPreviewModal extends Modal {
  candidates: ImgurCandidate[];

  constructor(app: App, candidates: ImgurCandidate[]) {
    super(app);
    this.candidates = candidates;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Imgur migration dry run' });
    contentEl.createEl('p', { text: `${this.candidates.length} Imgur markdown image(s) found.` });
    const list = contentEl.createEl('ul');
    for (const candidate of this.candidates.slice(0, 50)) {
      list.createEl('li', { text: candidate.url });
    }
    if (this.candidates.length > 50) contentEl.createEl('p', { text: `...and ${this.candidates.length - 50} more.` });
  }
}

class VaultMigrationPreviewModal extends Modal {
  plan: Array<{ file: TFile; candidates: ImgurCandidate[] }>;

  constructor(app: App, plan: Array<{ file: TFile; candidates: ImgurCandidate[] }>) {
    super(app);
    this.plan = plan;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const imageCount = this.plan.reduce((sum, item) => sum + item.candidates.length, 0);
    contentEl.createEl('h2', { text: 'Vault Imgur migration dry run' });
    contentEl.createEl('p', { text: `${imageCount} Imgur image(s) found in ${this.plan.length} note(s).` });
    const list = contentEl.createEl('ul');
    for (const item of this.plan.slice(0, 50)) {
      const li = list.createEl('li');
      li.createSpan({ text: `${item.file.path}: ` });
      li.createSpan({ text: item.candidates.map((c) => c.url).join(', ') });
    }
    if (this.plan.length > 50) contentEl.createEl('p', { text: `...and ${this.plan.length - 50} more note(s).` });
  }
}

function findImgurMarkdownImages(content: string): ImgurCandidate[] {
  const result: ImgurCandidate[] = [];
  let match: RegExpExecArray | null;
  while ((match = IMGUR_MARKDOWN_RE.exec(content)) !== null) {
    if (!IMGUR_URL_RE.test(match[2])) continue;
    result.push({ markdown: match[0], alt: match[1], url: match[2], start: match.index, end: match.index + match[0].length });
  }
  return result;
}

async function prepareMultipartRequest(formData: FormData): Promise<{ body: ArrayBuffer; contentType: string }> {
  const boundary = `----obsidian-immich-${Math.random().toString(36).slice(2)}`;
  const parts: BlobPart[] = [];
  formData.forEach((value, key) => {
    parts.push(`--${boundary}\r\n`);
    if (typeof value === 'string') {
      parts.push(`Content-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
    } else {
      const file = value as File;
      parts.push(`Content-Disposition: form-data; name="${key}"; filename="${file.name}"\r\n`);
      if (file.type) parts.push(`Content-Type: ${file.type}\r\n`);
      parts.push('\r\n');
      parts.push(file);
      parts.push('\r\n');
    }
  });
  parts.push(`--${boundary}--\r\n`);
  const blob = new Blob(parts);
  return { body: await blob.arrayBuffer(), contentType: `multipart/form-data; boundary=${boundary}` };
}

function mimeToExt(mime: string): string {
  const clean = mime.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
  };
  return map[clean] || 'jpg';
}

function guessMime(pathOrName: string): string {
  const ext = extFromUrl(pathOrName)?.toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  };
  return ext && map[ext] ? map[ext] : 'application/octet-stream';
}

function extFromUrl(url: string): string | null {
  const clean = url.split('?')[0].split('#')[0];
  const match = clean.match(/\.([a-zA-Z0-9]+)$/);
  if (!match) return null;
  return match[1];
}

function basenameWithoutQuery(url: string): string {
  const clean = url.split('?')[0].split('#')[0];
  return clean.split('/').pop() || '';
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

function normalizeVaultFolder(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableDeviceAssetId(path: string, size: number, modifiedAt: Date, sha256?: string): string {
  if (sha256) return `sha256:${sha256}`;
  return `${path}:${size}:${modifiedAt.getTime()}`;
}

function escapeAlt(alt: string): string {
  return alt.replace(/[\[\]]/g, '');
}

function header(headers: Record<string, string>, key: string): string | null {
  const found = Object.keys(headers).find((name) => name.toLowerCase() === key.toLowerCase());
  return found ? headers[found] : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
