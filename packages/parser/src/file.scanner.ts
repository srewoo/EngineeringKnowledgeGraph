/**
 * File scanner — walks a directory tree and returns files to parse.
 *
 * Respects ignore lists, blocklists binaries/lockfiles, and skips
 * any file larger than MAX_SOURCE_FILE_BYTES (typically a checked-in bundle).
 */

import { readdir, stat } from 'node:fs/promises';
import { join, extname, relative, basename } from 'node:path';
import { createLogger } from '@ekg/shared';
import {
  DEFAULT_IGNORE_DIRS,
  DEFAULT_SUPPORTED_EXTENSIONS,
  BINARY_AND_LIBRARY_EXTENSIONS,
  LOCKFILE_NAMES,
  MAX_SOURCE_FILE_BYTES,
} from '@ekg/shared';
import type { Logger } from '@ekg/shared';

export interface ScanOptions {
  readonly ignoreDirs?: readonly string[];
  readonly supportedExtensions?: readonly string[];
  readonly maxFileBytes?: number;
}

export interface ScannedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly extension: string;
  readonly sizeBytes: number;
}

export class FileScanner {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'file-scanner' });
  }

  /**
   * Scan a directory recursively and return all matching source files.
   */
  async scan(rootDir: string, options?: ScanOptions): Promise<readonly ScannedFile[]> {
    const ignoreDirs = new Set(options?.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
    const extensions = new Set(options?.supportedExtensions ?? DEFAULT_SUPPORTED_EXTENSIONS);
    const maxBytes = options?.maxFileBytes ?? MAX_SOURCE_FILE_BYTES;

    const files: ScannedFile[] = [];
    let skippedBinary = 0;
    let skippedLarge = 0;
    let skippedLock = 0;

    await this.walkDirectory(
      rootDir,
      rootDir,
      ignoreDirs,
      extensions,
      maxBytes,
      files,
      (reason) => {
        if (reason === 'binary') skippedBinary++;
        else if (reason === 'large') skippedLarge++;
        else if (reason === 'lockfile') skippedLock++;
      },
    );

    this.logger.info({
      rootDir,
      filesFound: files.length,
      skippedBinary,
      skippedLockfile: skippedLock,
      skippedLarge,
    }, 'Directory scan completed');

    return files;
  }

  private async walkDirectory(
    currentDir: string,
    rootDir: string,
    ignoreDirs: ReadonlySet<string>,
    extensions: ReadonlySet<string>,
    maxBytes: number,
    results: ScannedFile[],
    onSkip: (reason: 'binary' | 'large' | 'lockfile') => void,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      this.logger.warn({ dir: currentDir, error }, 'Failed to read directory');
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name) && !entry.name.startsWith('.')) {
          await this.walkDirectory(fullPath, rootDir, ignoreDirs, extensions, maxBytes, results, onSkip);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const name = entry.name;
      const ext = extname(name).toLowerCase();

      // Hard blocklist: binaries, archives, media — never parse, regardless of extension list
      if (BINARY_AND_LIBRARY_EXTENSIONS.has(ext)) {
        onSkip('binary');
        continue;
      }
      // Skip ".min.js" / ".min.css" composite extensions
      if (name.endsWith('.min.js') || name.endsWith('.min.css')) {
        onSkip('binary');
        continue;
      }
      if (LOCKFILE_NAMES.has(name)) {
        onSkip('lockfile');
        continue;
      }

      if (!extensions.has(ext)) continue;

      // Size guard — checked-in bundles, generated code, big JSONs
      let sizeBytes = 0;
      try {
        const st = await stat(fullPath);
        sizeBytes = st.size;
      } catch {
        continue;
      }
      if (sizeBytes > maxBytes) {
        onSkip('large');
        continue;
      }

      results.push({
        absolutePath: fullPath,
        relativePath: relative(rootDir, fullPath),
        extension: ext,
        sizeBytes,
      });
    }
  }
}
