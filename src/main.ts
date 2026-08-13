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
  appendAssetComment: boolean;
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
  appendAssetComment: true,
};

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?)$/i;
const IMGUR_MARKDOWN_RE = /!\[([^\]]*)\]\((https?:\/\/(?:i\.)?imgur\.com\/[^\s)]+)\)/g;
const IMGUR_URL_RE = /^https?:\/\/(?:i\.)?imgur\.com\//i;
const IMMICH_ASSET_RE = /^immich:\/\/asset\/([0-9a-f-]{36})$/i;
const IMMICH_HTML_IMG_RE = /<img\b([^>]*?)\bdata-immich-asset-id=["']([0-9a-f-]{36})["']([^>]*)>/gi;

export default class ImmichUploaderPlugin extends Plugin {
  settings: ImmichUploaderSettings;
  private observer: MutationObserver | null = null;
  private pendingRender = false;
  private blobUrls = new Set<string>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ImmichUploaderSettingTab(this.app, this));
    this.registerMarkdownPostProcessor((element) => this.renderImmichImages(element));
    this.startImmichImageObserver();
    this.register(() => this.revokeImmichBlobUrls());
    this.registerDomEvent(document, 'paste', (event: ClipboardEvent) => this.handlePaste(event), true);
    this.registerDomEvent(document, 'drop', (event: DragEvent) => this.handleDrop(event), true);

    this.addCommand({
      id: 'upload-clipboard-image-to-immich',
      name: 'Upload clipboard image to Immich',
      editorCallback: async (editor) => this.uploadClipboardImage(editor),
    });

    this.addCommand({
      id: 'upload-current-note-local-images-to-immich',
      name: 'Upload and replace current note local images with Immich links',
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
      id: 'rewrite-current-note-immich-html-embeds',
      name: 'Rewrite current note Immich HTML image embeds',
      editorCallback: (editor) => this.rewriteCurrentNoteImmichHtml(editor),
    });

    this.addCommand({
      id: 'rewrite-vault-immich-html-embeds',
      name: 'Rewrite all vault Immich HTML image embeds',
      callback: async () => this.rewriteVaultImmichHtml(),
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
        const embed = await this.uploadBlobToImmichEmbed(blob, `obsidian-clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.${mimeToExt(imageType)}`, 'clipboard image');
        editor.replaceSelection(embed);
        new Notice('Uploaded clipboard image to Immich.');
        return;
      }
      new Notice('No image found in clipboard.');
    } catch (error) {
      console.error(error);
      new Notice(`Immich upload failed: ${messageOf(error)}`);
    }
  }

  async handlePaste(event: ClipboardEvent) {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = active?.editor;
    if (!editor || !event.clipboardData?.files?.length) return;
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    try {
      this.assertConfigured();
      const embeds: string[] = [];
      for (const file of files) {
        embeds.push(await this.uploadBlobToImmichEmbed(file, file.name || `pasted-image.${mimeToExt(file.type)}`, 'pasted image'));
      }
      editor.replaceSelection(embeds.join('\n'));
      new Notice(`Uploaded ${embeds.length} pasted image(s) to Immich.`);
    } catch (error) {
      console.error(error);
      new Notice(`Immich paste upload failed: ${messageOf(error)}`);
    }
  }

  async handleDrop(event: DragEvent) {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = active?.editor;
    if (!editor || !event.dataTransfer?.files?.length) return;
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/') || IMAGE_EXT_RE.test(file.name));
    if (!files.length) return;
    event.preventDefault();
    try {
      this.assertConfigured();
      const embeds: string[] = [];
      for (const file of files) {
        embeds.push(await this.uploadBlobToImmichEmbed(file, file.name || `dropped-image.${mimeToExt(file.type)}`, 'dropped image'));
      }
      editor.replaceSelection(embeds.join('\n'));
      new Notice(`Uploaded ${embeds.length} dropped image(s) to Immich.`);
    } catch (error) {
      console.error(error);
      new Notice(`Immich drop upload failed: ${messageOf(error)}`);
    }
  }

  async uploadBlobToImmichEmbed(blob: Blob, fileName: string, originalPath: string): Promise<string> {
    const type = blob.type || guessMime(fileName);
    const file = new File([blob], fileName, { type, lastModified: Date.now() });
    const bytes = await file.arrayBuffer();
    const result = await this.uploadFileToImmich(file, originalPath, undefined, undefined, await sha256Hex(bytes));
    return this.renderUploadedEmbed(fileName, result);
  }

  async uploadCurrentNoteLocalImages(view: MarkdownView) {
    try {
      this.assertConfigured();
      const file = view.file;
      if (!file) throw new Error('No active note.');
      const text = await this.app.vault.read(file);
      const localEmbeds = [...text.matchAll(/!\[\[([^\]]+\.(?:png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?)(?:\|[^\]]*)?)\]\]/gi)];
      let next = text;
      let uploaded = 0;
      for (const match of localEmbeds) {
        const rawTarget = match[1].split('|')[0];
        const linked = this.app.metadataCache.getFirstLinkpathDest(rawTarget, file.path);
        if (!(linked instanceof TFile)) continue;
        const result = await this.uploadVaultFileToImmich(linked);
        next = next.replace(match[0], this.renderImmichEmbed(linked.basename, result, null));
        uploaded++;
      }
      if (next !== text) await this.app.vault.modify(file, next);
      new Notice(`Uploaded and replaced ${uploaded} local image embed(s) with Immich links. Original local files were not deleted.`);
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
        const replacement = this.renderImmichEmbed(candidate.alt, upload.result, candidate.url);
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

  rewriteCurrentNoteImmichHtml(editor: Editor) {
    const content = editor.getValue();
    const next = rewriteImmichHtmlImageSrc(content);
    if (next === content) {
      new Notice('No Immich HTML image embeds needed rewriting in current note.');
      return;
    }
    editor.setValue(next);
    new Notice('Rewrote current note Immich image embeds.');
  }

  async rewriteVaultImmichHtml() {
    try {
      const result = await rewriteVaultImmichHtmlImageSrc(this.app);
      new Notice(`Rewrote ${result.embeds} Immich image embed(s) in ${result.files} note(s).`);
    } catch (error) {
      console.error(error);
      new Notice(`Immich embed rewrite failed: ${messageOf(error)}`);
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
          const replacement = this.renderImmichEmbed(candidate.alt, upload.result, candidate.url);
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

  async downloadImgurAndUpload(candidate: ImgurCandidate): Promise<{ result: ImmichUploadResponse }> {
    const resp = await requestUrl({ url: candidate.url, method: 'GET', throw: false });
    if (resp.status >= 400) throw new Error(`Failed to download ${candidate.url}: HTTP ${resp.status}`);
    const contentType = header(resp.headers, 'content-type') || guessMime(candidate.url);
    const ext = extFromUrl(candidate.url) || mimeToExt(contentType);
    const fileName = safeFileName(`imgur-${basenameWithoutQuery(candidate.url) || crypto.randomUUID()}.${ext}`);
    const arrayBuffer = resp.arrayBuffer;
    const file = new File([arrayBuffer], fileName, { type: contentType, lastModified: Date.now() });
    const result = await this.uploadFileToImmich(file, fileName, undefined, undefined, await sha256Hex(arrayBuffer));
    return { result };
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

  renderUploadedEmbed(fileName: string, result: ImmichUploadResponse): string {
    return this.renderImmichEmbed(fileName, result, null);
  }

  renderImmichEmbed(alt: string, result: ImmichUploadResponse, sourceUrl: string | null): string {
    if (!result.id) throw new Error('Immich upload response did not include an asset id.');
    const escapedAlt = escapeHtmlAttr(alt);
    const assetSrc = `immich://asset/${result.id}`;
    return `<img src="${assetSrc}" data-immich-asset-id="${result.id}" alt="${escapedAlt}">${this.renderAssetComment(result, sourceUrl)}`;
  }

  renderAssetComment(result: ImmichUploadResponse, sourceUrl: string | null): string {
    if (!this.settings.appendAssetComment || !result.id) return '';
    const source = sourceUrl ? ` source=${sourceUrl}` : '';
    return ` <!-- immich-asset-id=${result.id}${source} -->`;
  }

  async renderImmichImages(element: HTMLElement) {
    const selector = 'img[data-immich-asset-id], img[src^="immich://asset/"]';
    const images = [
      ...(element.matches(selector) ? [element as HTMLImageElement] : []),
      ...Array.from(element.querySelectorAll<HTMLImageElement>(selector)),
    ];
    for (const image of images) {
      if (image.hasClass('immich-uploader-image')) continue;
      const explicitAssetId = image.getAttribute('data-immich-asset-id');
      const src = image.getAttribute('src') || '';
      const match = src.match(IMMICH_ASSET_RE);
      const assetId = explicitAssetId || match?.[1];
      if (!assetId) continue;
      image.setAttribute('data-immich-asset-id', assetId);
      image.setAttribute('alt', image.getAttribute('alt') || `Immich asset ${assetId}`);
      image.addClass('immich-uploader-image');
      try {
        const blobUrl = await this.fetchImmichThumbnailBlobUrl(assetId);
        if (!image.isConnected) {
          URL.revokeObjectURL(blobUrl);
          continue;
        }
        this.blobUrls.add(blobUrl);
        image.setAttribute('src', blobUrl);
      } catch (error) {
        console.error(error);
        if (image.isConnected) {
          image.replaceWith(createEl('span', { text: `Immich image failed to load: ${assetId}` }));
        }
      }
    }
  }

  revokeImmichBlobUrls() {
    for (const blobUrl of this.blobUrls) {
      URL.revokeObjectURL(blobUrl);
    }
    this.blobUrls.clear();
  }

  startImmichImageObserver() {
    this.observer?.disconnect();
    const schedule = () => {
      if (this.pendingRender) return;
      this.pendingRender = true;
      window.setTimeout(async () => {
        this.pendingRender = false;
        await this.renderImmichImages(document.body);
      }, 100);
    };
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches?.('img[data-immich-asset-id], img[src^="immich://asset/"]') || node.querySelector?.('img[data-immich-asset-id], img[src^="immich://asset/"]')) {
            schedule();
            return;
          }
        }
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.register(() => this.observer?.disconnect());
    schedule();
  }

  async fetchImmichThumbnailBlobUrl(assetId: string): Promise<string> {
    this.assertConfigured();
    const resp = await requestUrl({
      url: `${this.normalizedImmichApiBase()}/assets/${assetId}/thumbnail?size=preview`,
      method: 'GET',
      headers: { 'x-api-key': this.settings.apiKey.trim() },
      throw: false,
    });
    if (resp.status >= 400) throw new Error(`Immich thumbnail HTTP ${resp.status}: ${resp.text?.slice(0, 200)}`);
    const contentType = header(resp.headers, 'content-type') || 'image/jpeg';
    const blob = new Blob([resp.arrayBuffer], { type: contentType });
    return URL.createObjectURL(blob);
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
      .setName('Append Immich asset comment')
      .setDesc('Adds an HTML comment with the Immich asset ID after migrated/uploaded embeds.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.appendAssetComment)
        .onChange(async (value) => {
          this.plugin.settings.appendAssetComment = value;
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

function rewriteImmichHtmlImageSrc(markdown: string): string {
  return markdown.replace(IMMICH_HTML_IMG_RE, (full, before: string, assetId: string, after: string) => {
    const attrs = `${before || ''}${after || ''}`;
    if (/\bsrc\s*=\s*["']immich:\/\/asset\//i.test(full)) return full;
    const cleanedAttrs = attrs.replace(/\s*\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '');
    return `<img src="immich://asset/${assetId}" data-immich-asset-id="${assetId}"${cleanedAttrs}>`;
  });
}

async function rewriteVaultImmichHtmlImageSrc(app: App): Promise<{ files: number; embeds: number }> {
  let files = 0;
  let embeds = 0;
  for (const file of app.vault.getMarkdownFiles()) {
    const content = await app.vault.read(file);
    let replaced = 0;
    const next = content.replace(IMMICH_HTML_IMG_RE, (full, before: string, assetId: string, after: string) => {
      if (/\bsrc\s*=\s*["']immich:\/\/asset\//i.test(full)) return full;
      replaced += 1;
      const attrs = `${before || ''}${after || ''}`;
      const cleanedAttrs = attrs.replace(/\s*\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '');
      return `<img src="immich://asset/${assetId}" data-immich-asset-id="${assetId}"${cleanedAttrs}>`;
    });
    if (next !== content) {
      await app.vault.modify(file, next);
      files += 1;
      embeds += replaced;
    }
  }
  return { files, embeds };
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

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
