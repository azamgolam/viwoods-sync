// services/one-to-one-importer.ts - Simplified one-to-one import service

import { App, TFile, normalizePath, moment } from 'obsidian';
import type { ViwoodsSettings, BookResult } from '../types.js';
import { ensureFolder } from '../utils/file-utils.js';
import { log } from '../utils/logger.js';

/**
 * Result of a one-to-one import operation
 */
export interface ImportResult {
    success: boolean;
    filename: string;
    pagesImported: number;
    attachments: string[];
    error?: string;
}

/**
 * Simplified importer that creates one .md file per .note file
 * with all pages as sections and attachments in a subfolder
 */
export class OneToOneImporter {
    private app: App;
    private settings: ViwoodsSettings;

    constructor(app: App, settings: ViwoodsSettings) {
        this.app = app;
        this.settings = settings;
    }

    /**
     * Import a note file as a single markdown document
     * @param book - The book data to import
     * @param relativePath - Relative path from source folder (e.g., "subfolder/file.note" or "file.note")
     */
    async importNote(book: BookResult, relativePath?: string): Promise<ImportResult> {
        try {
            // Determine the target folder structure based on relative path
            // e.g., "subfolder/file.note" -> "subfolder"
            // e.g., "file.note" -> "" (root of notes folder)
            const relativeDir = relativePath
                ? relativePath.substring(0, relativePath.lastIndexOf('/') + 1).replace(/\.note$|\.zip$/, '')
                : '';

            // Create the target folder structure
            const targetFolder = relativeDir
                ? `${this.settings.notesFolder}/${relativeDir}`.replace(/\/$/, '')
                : this.settings.notesFolder;

            await ensureFolder(this.app, targetFolder);

            // Get Obsidian's configured attachment folder path and resolve it
            // relative to the note being written (Obsidian supports several modes,
            // e.g. "./attachments" = subfolder next to the note).
            const attachmentConfig = (this.app.vault as { config?: { attachmentFolderPath?: string } }).config?.attachmentFolderPath;
            const attachmentFolder = this.resolveAttachmentFolder(attachmentConfig, targetFolder);

            // Save all attachments and get their filenames with relative paths
            const attachments = await this.saveAttachments(book, attachmentFolder, relativeDir);

            // Build the single markdown content with proper relative attachment paths
            const markdown = this.buildSingleMarkdown(book, attachments);

            // Save the markdown file
            const filename = `${book.bookName}.md`;
            // targetFolder already includes relativeDir structure, pass just filename
            await this.saveMarkdown(markdown, filename, targetFolder);

            // Embed the page image(s) into the matching Obsidian daily note.
            await this.addToDailyNote(book, relativePath, attachments);

            // Build the full path for the return value (for display/logging)
            const fullPath = `${targetFolder}/${filename}`.replace(/\/\//g, '/');

            return {
                success: true,
                filename: fullPath,
                pagesImported: book.pages.length,
                attachments: attachments.map(a => a.filename)
            };
        } catch (error: unknown) {
            log.error('Error importing note:', error);
            return {
                success: false,
                filename: book.bookName + '.md',
                pagesImported: 0,
                attachments: [],
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Build a single markdown file with all pages
     */
    private buildSingleMarkdown(
        book: BookResult,
        attachments: Array<{ filename: string; relativePath: string }>
    ): string {
        const lines: string[] = [];

        // Frontmatter
        if (this.settings.includeMetadata) {
            lines.push('---');
            lines.push(`title: ${book.bookName}`);
            lines.push(`source: ${book.bookName}.note`);
            lines.push(`total_pages: ${book.pages.length}`);
            lines.push(`viwoods: true`);

            if (this.settings.includeTimestamps) {
                lines.push(`created: ${new Date().toISOString()}`);
                lines.push(`modified: ${new Date().toISOString()}`);
            }

            lines.push('---');
            lines.push('');
        }

        // Table of Contents
        lines.push('# Table of Contents');
        lines.push('');
        for (const page of book.pages) {
            lines.push(`- [[#Page ${page.pageNum}]]`);
        }
        lines.push('');
        lines.push('---');
        lines.push('');

        // Pages as sections
        for (const page of book.pages) {
            lines.push(`## Page ${page.pageNum}`);
            lines.push('');

            // Find the attachment for this page
            const pageImage = attachments.find(a => a.filename.includes(`_page_${page.pageNum}.`));
            if (pageImage) {
                // Use angle brackets for paths with spaces (Obsidian-compatible)
                lines.push(`![Page ${page.pageNum}](<${pageImage.relativePath}>)`);
                lines.push('');
            }

            // Audio link if present
            if (page.audio) {
                const audioBaseName = page.audio.originalName.split('.')[0];
                const audioFile = attachments.find(a => a.filename.includes(audioBaseName));
                if (audioFile) {
                    lines.push(`🎵 [[${audioFile.relativePath}]]`);
                    lines.push('');
                }
            }

            lines.push('---');
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Resolve Obsidian's configured attachment location into a concrete vault path.
     *
     * Obsidian supports several attachment-folder modes:
     *   ''  or '/'   -> vault root
     *   '.' or './'  -> same folder as the note
     *   './sub'      -> subfolder under the note's folder
     *   'folder/sub' -> fixed folder relative to the vault root
     *
     * @param configPath - Raw value of app.vault.config.attachmentFolderPath
     * @param noteFolder - Folder the markdown note is being written to
     */
    private resolveAttachmentFolder(configPath: string | undefined, noteFolder: string): string {
        const raw = (configPath ?? '').trim();

        // Vault root
        if (raw === '' || raw === '/') {
            return '';
        }
        // Same folder as the note
        if (raw === '.' || raw === './') {
            return normalizePath(noteFolder);
        }
        // Subfolder relative to the note's folder
        if (raw.startsWith('./')) {
            const sub = raw.slice(2);
            return normalizePath(noteFolder ? `${noteFolder}/${sub}` : sub);
        }
        // Fixed folder relative to the vault root
        return normalizePath(raw);
    }

    /**
     * Write a binary attachment, creating it or overwriting an existing one,
     * and return the actual filename that was written so callers can link to it.
     *
     * Obsidian's path index is case-sensitive even on case-insensitive
     * filesystems (macOS/iCloud), so a plain getAbstractFileByPath() can miss a
     * file that physically exists under different folder/name casing. When that
     * happens createBinary() fails with "already exists" and the page silently
     * loses its image. We look the file up case-insensitively and modify it
     * in place instead.
     */
    private async writeBinaryAttachment(filepath: string, buffer: ArrayBuffer): Promise<string> {
        const existing = this.findFileCaseInsensitive(filepath);
        if (existing) {
            await this.app.vault.modifyBinary(existing, buffer);
            return existing.name;
        }
        await this.app.vault.createBinary(filepath, buffer);
        return filepath.split('/').pop() as string;
    }

    /**
     * Find an existing vault file at the given path, tolerant of case
     * differences (returns null if none exists).
     */
    private findFileCaseInsensitive(filepath: string): TFile | null {
        const direct = this.app.vault.getAbstractFileByPath(filepath);
        if (direct instanceof TFile) {
            return direct;
        }
        const lower = filepath.toLowerCase();
        const match = this.app.vault.getFiles().find(f => f.path.toLowerCase() === lower);
        return match ?? null;
    }

    /**
     * Save all attachments to Obsidian's attachment folder
     * @param book - The book data
     * @param attachmentFolder - Obsidian's configured attachment folder
     * @param relativeDir - Relative directory for unique naming (e.g., "folder1/" or "")
     */
    private async saveAttachments(
        book: BookResult,
        attachmentFolder: string,
        relativeDir: string
    ): Promise<Array<{ filename: string; relativePath: string }>> {
        const savedFiles: Array<{ filename: string; relativePath: string }> = [];

        // Sanitize relative directory for filename:
        // 1. Remove leading/trailing slashes first
        // 2. Replace remaining slashes with underscores
        // 3. Remove any resulting duplicate underscores
        let dirPrefix = relativeDir.replace(/^\/+|\/+$/g, ''); // Remove leading/trailing slashes
        dirPrefix = dirPrefix.replace(/\/+/g, '_'); // Replace internal slashes with single underscore
        dirPrefix = dirPrefix.replace(/_+/g, '_'); // Collapse multiple underscores to single
        dirPrefix = dirPrefix.replace(/^_+|_+$/g, ''); // Remove leading/trailing underscores again

        // Build name prefix: viwoods_[optional_folder_structure]_[notebook_name]
        // If no folder structure, just: viwoods_[notebook_name]
        const namePrefix = dirPrefix ? `viwoods_${dirPrefix}_${book.bookName}` : `viwoods_${book.bookName}`;

        log.debug('Attachment naming:', { relativeDir, dirPrefix, namePrefix });

        // Save images
        for (const page of book.pages) {
            const ext = this.settings.outputFormat === 'svg' ? 'svg' : 'png';
            const filename = `${namePrefix}_page_${page.pageNum}.${ext}`;
            const filepath = normalizePath(attachmentFolder ? `${attachmentFolder}/${filename}` : filename);

            try {
                // Create folder if it doesn't exist (root needs no folder)
                if (attachmentFolder) {
                    await ensureFolder(this.app, attachmentFolder);
                }

                // Convert blob to buffer
                const buffer = await page.image.blob.arrayBuffer();

                // Write (create or overwrite) and link by the file's real name.
                const savedName = await this.writeBinaryAttachment(filepath, buffer);
                savedFiles.push({ filename: savedName, relativePath: this.calculateRelativePath(savedName) });
            } catch (error) {
                log.error(`Failed to save attachment ${filename}:`, error);
            }
        }

        // Save audio files
        for (const page of book.pages) {
            if (page.audio) {
                const filename = `${namePrefix}_${page.audio.originalName}`;
                const filepath = normalizePath(attachmentFolder ? `${attachmentFolder}/${filename}` : filename);

                try {
                    if (attachmentFolder) {
                        await ensureFolder(this.app, attachmentFolder);
                    }
                    const buffer = await page.audio.blob.arrayBuffer();

                    const savedName = await this.writeBinaryAttachment(filepath, buffer);
                    savedFiles.push({ filename: savedName, relativePath: this.calculateRelativePath(savedName) });
                } catch (error) {
                    log.error(`Failed to save audio ${filename}:`, error);
                }
            }
        }

        return savedFiles;
    }

    /**
     * Embed this note's page image(s) into the Obsidian daily note for the
     * note's date. Daily notes (day_YYYY_M_D) map to their own date; any other
     * note maps to the daily note for the date it was created on the device.
     * The embed is inserted at the top of the daily note (after frontmatter, if
     * present), and the daily note is created from scratch if it doesn't exist.
     */
    private async addToDailyNote(
        book: BookResult,
        relativePath: string | undefined,
        attachments: Array<{ filename: string; relativePath: string }>
    ): Promise<void> {
        try {
            // Only image pages are embedded (not audio).
            const pageImages = attachments
                .map(a => {
                    const m = a.filename.match(/_page_(\d+)\./);
                    return m ? { pageNum: parseInt(m[1], 10), relativePath: a.relativePath } : null;
                })
                .filter((x): x is { pageNum: number; relativePath: string } => x !== null)
                .sort((a, b) => a.pageNum - b.pageNum);
            if (pageImages.length === 0) {
                return;
            }

            const date = this.resolveNoteDate(book, relativePath);
            if (!date) {
                log.debug('Could not resolve a date for note; skipping daily-note embed', book.bookName);
                return;
            }

            const { folder, format } = this.getDailyNotesConfig();
            const dailyName = moment(date).format(format);
            const dailyPath = normalizePath(folder ? `${folder}/${dailyName}.md` : `${dailyName}.md`);

            // Resolve (or create) the daily note.
            let file = this.app.vault.getAbstractFileByPath(dailyPath);
            if (!(file instanceof TFile)) {
                const dir = dailyPath.substring(0, dailyPath.lastIndexOf('/'));
                if (dir) {
                    await ensureFolder(this.app, dir);
                }
                file = await this.app.vault.create(dailyPath, '');
                log.debug(`Created daily note ${dailyPath}`);
            }

            const content = await this.app.vault.read(file as TFile);

            // Build embed lines, skipping any image already present (idempotent
            // across re-syncs).
            const linesToAdd = pageImages
                .filter(p => !content.includes(p.relativePath))
                .map(p => `![Page ${p.pageNum}](<${p.relativePath}>)`);
            if (linesToAdd.length === 0) {
                return;
            }

            const block = linesToAdd.join('\n') + '\n';

            // Insert after a leading YAML frontmatter block if there is one,
            // otherwise at the very top.
            const fmMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
            let newContent: string;
            if (fmMatch) {
                const idx = fmMatch[0].length;
                newContent = content.slice(0, idx) + '\n' + block + content.slice(idx);
            } else {
                newContent = block + (content.length ? '\n' + content : '');
            }

            await this.app.vault.modify(file as TFile, newContent);
            log.debug(`Embedded ${linesToAdd.length} page image(s) into ${dailyPath}`);
        } catch (error) {
            // Never let daily-note embedding break the main import.
            log.error('Failed to add note to daily note:', error);
        }
    }

    /**
     * Determine the calendar date a note belongs to.
     * - "day_YYYY_M_D" notes map to that explicit date.
     * - Otherwise fall back to the note's creation timestamp from metadata.
     */
    private resolveNoteDate(book: BookResult, relativePath: string | undefined): Date | null {
        const candidates = [relativePath?.split('/').pop() ?? '', book.bookName];
        for (const candidate of candidates) {
            const m = candidate.match(/day_(\d{4})_(\d{1,2})_(\d{1,2})/i);
            if (m) {
                return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
            }
        }

        const meta = book.metadata as Record<string, unknown>;
        const epoch = [meta.createTime, meta.creationTime, meta.lastModifiedTime, meta.upTime]
            .map(v => (typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN))
            .find(v => Number.isFinite(v) && v > 0);
        if (epoch !== undefined) {
            // Viwoods timestamps are in milliseconds.
            return new Date(epoch);
        }
        return null;
    }

    /**
     * Read Obsidian's core Daily Notes configuration (folder + filename format).
     * Falls back to sensible defaults when it isn't configured.
     */
    private getDailyNotesConfig(): { folder: string; format: string } {
        try {
            const dn = (this.app as unknown as {
                internalPlugins?: {
                    getPluginById?: (id: string) => { instance?: { options?: { folder?: string; format?: string } } } | null;
                };
            }).internalPlugins?.getPluginById?.('daily-notes');
            const opts = dn?.instance?.options;
            if (opts) {
                return {
                    folder: (opts.folder ?? '').replace(/\/+$/, ''),
                    format: opts.format || 'YYYY-MM-DD'
                };
            }
        } catch (error) {
            log.debug('Could not read daily-notes config, using defaults', error);
        }
        return { folder: '', format: 'YYYY-MM-DD' };
    }

    /**
     * Calculate the relative path from a markdown file location to an attachment
     * Obsidian will handle this, but we return just the attachment filename for the link
     */
    private calculateRelativePath(filename: string): string {
        // Obsidian automatically resolves attachment paths from configured folder
        // We return just the filename, Obsidian will handle the path resolution
        return filename;
    }

    /**
     * Save the markdown file
     * @param content - Markdown content
     * @param filename - Just the filename (e.g., "subfolder/file.md" or "file.md")
     * @param targetFolder - Target folder path (e.g., "Viwoods Notes/subfolder" or "Viwoods Notes")
     */
    private async saveMarkdown(content: string, filename: string, targetFolder: string): Promise<void> {
        const filepath = `${targetFolder}/${filename}`.replace(/\/\//g, '/');

        // If the note was already imported (e.g. a page was added and the .note
        // re-exported under the same name), overwrite it instead of throwing
        // "File already exists" from vault.create().
        const existingFile = this.app.vault.getAbstractFileByPath(filepath);
        if (existingFile instanceof TFile) {
            await this.app.vault.modify(existingFile, content);
        } else {
            await this.app.vault.create(filepath, content);
        }
    }

    /**
     * Check if a note file already exists
     */
    noteExists(bookName: string): boolean {
        const filepath = `${this.settings.notesFolder}/${bookName}.md`;
        return this.app.vault.getAbstractFileByPath(filepath) instanceof TFile;
    }
}
