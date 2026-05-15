/**
 * Service detector — identifies service boundaries within a repository.
 *
 * Uses a layered strategy:
 * 1. Config-based mapping (ekg.config.json)
 * 2. package.json heuristic (directory with own package.json)
 * 3. Dockerfile heuristic (directory with Dockerfile)
 * 4. Fallback: entire repo as single service
 */

import { readdir, access, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createLogger } from '@ekg/shared';
import type { Logger, GraphNode } from '@ekg/shared';

export interface DetectedService {
  readonly name: string;
  readonly directory: string;
  readonly detectionMethod: 'config' | 'package_json' | 'dockerfile' | 'fallback';
}

export class ServiceDetector {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'service-detector' });
  }

  /**
   * Detect service boundaries within a repository directory.
   */
  async detect(
    repoDir: string,
    repoUrl: string,
    configMappings?: Readonly<Record<string, string>>,
  ): Promise<readonly DetectedService[]> {
    // Strategy 1: config-based mapping
    if (configMappings && Object.keys(configMappings).length > 0) {
      const services = Object.entries(configMappings).map(([dir, name]) => ({
        name,
        directory: join(repoDir, dir),
        detectionMethod: 'config' as const,
      }));
      this.logger.info({ count: services.length, method: 'config' }, 'Services detected via config');
      return services;
    }

    // Strategy 2: package.json heuristic (monorepo detection)
    const packageJsonServices = await this.detectByPackageJson(repoDir);
    if (packageJsonServices.length > 1) {
      this.logger.info({ count: packageJsonServices.length, method: 'package_json' }, 'Services detected via package.json');
      return packageJsonServices;
    }

    // Strategy 3: Dockerfile heuristic
    const dockerfileServices = await this.detectByDockerfile(repoDir);
    if (dockerfileServices.length > 0) {
      this.logger.info({ count: dockerfileServices.length, method: 'dockerfile' }, 'Services detected via Dockerfile');
      return dockerfileServices;
    }

    // Strategy 4: fallback — treat entire repo as single service
    const repoName = this.extractRepoName(repoUrl);
    this.logger.info({ name: repoName, method: 'fallback' }, 'Using fallback single-service detection');
    return [{
      name: repoName,
      directory: repoDir,
      detectionMethod: 'fallback',
    }];
  }

  /**
   * Convert detected services into graph nodes.
   */
  toGraphNodes(
    services: readonly DetectedService[],
    repoUrl: string,
  ): readonly GraphNode[] {
    return services.map((svc) => ({
      id: `service:${svc.name}`,
      label: 'Service' as const,
      name: svc.name,
      properties: {
        repoUrl,
        directory: svc.directory,
        detectionMethod: svc.detectionMethod,
      },
    }));
  }

  private async detectByPackageJson(rootDir: string): Promise<DetectedService[]> {
    const services: DetectedService[] = [];

    // Check common monorepo patterns: apps/*, packages/*, services/*
    const monorepoPatterns = ['apps', 'packages', 'services', 'libs'];

    for (const pattern of monorepoPatterns) {
      const patternDir = join(rootDir, pattern);
      if (!(await this.exists(patternDir))) continue;

      let entries;
      try {
        entries = await readdir(patternDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const subDir = join(patternDir, entry.name);
        const pkgPath = join(subDir, 'package.json');

        if (await this.exists(pkgPath)) {
          const name = await this.readPackageName(pkgPath) ?? entry.name;
          services.push({
            name,
            directory: subDir,
            detectionMethod: 'package_json',
          });
        }
      }
    }

    return services;
  }

  private async detectByDockerfile(rootDir: string): Promise<DetectedService[]> {
    const services: DetectedService[] = [];

    let entries;
    try {
      entries = await readdir(rootDir, { withFileTypes: true });
    } catch {
      return services;
    }

    // Check root Dockerfile
    if (await this.exists(join(rootDir, 'Dockerfile'))) {
      services.push({
        name: basename(rootDir),
        directory: rootDir,
        detectionMethod: 'dockerfile',
      });
    }

    // Check subdirectories for Dockerfiles
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const subDir = join(rootDir, entry.name);
      if (await this.exists(join(subDir, 'Dockerfile'))) {
        services.push({
          name: entry.name,
          directory: subDir,
          detectionMethod: 'dockerfile',
        });
      }
    }

    return services;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async readPackageName(pkgPath: string): Promise<string | undefined> {
    try {
      const content = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content) as { name?: string };
      return pkg.name?.replace(/^@\w+\//, '');
    } catch {
      return undefined;
    }
  }

  private extractRepoName(repoUrl: string): string {
    // Handle both HTTPS and SSH git URLs
    const match = /\/([^/]+?)(?:\.git)?$/.exec(repoUrl);
    return match?.[1] ?? 'unknown-service';
  }
}
