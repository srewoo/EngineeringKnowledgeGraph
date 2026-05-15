/**
 * K8sManifestExtractor — pure deterministic parser for Kubernetes manifests.
 *
 * Handles ConfigMap, Secret, Deployment, StatefulSet, Job, CronJob. Splits
 * multi-doc YAML on `---` and emits ConfigKey / SecretRef nodes per
 * data/env/envFrom entry.
 *
 * Confidence is HIGH — every emission comes from a structured K8s field.
 */
import { loadAll as yamlLoadAll } from 'js-yaml';
import {
  createLogger, type ConfigKeyNode, type SecretRefNode, type Logger,
} from '@ekg/shared';
import {
  isSecretLikeKey,
  makeConfigKeyNode,
  makeSecretRefNode,
  stringifyLeaf,
} from './config.helpers.js';

export interface K8sExtractionResult {
  readonly configKeys: readonly ConfigKeyNode[];
  readonly secretRefs: readonly SecretRefNode[];
}

const K8S_PATH_HINTS = ['/k8s/', '/manifests/', '/deploy/', '/kubernetes/'];
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod', 'ReplicaSet']);

interface ManifestRoot {
  readonly apiVersion?: unknown;
  readonly kind?: unknown;
  readonly metadata?: unknown;
  readonly data?: unknown;
  readonly stringData?: unknown;
  readonly spec?: unknown;
}

export class K8sManifestExtractor {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'k8s-manifest-extractor' });
  }

  /** Path hint match — used to short-circuit when filename alone is enough. */
  static handlesByPath(relativePath: string): boolean {
    const lower = relativePath.replace(/\\/g, '/').toLowerCase();
    if (!/\.ya?ml$/.test(lower)) return false;
    const padded = `/${lower}`;
    return K8S_PATH_HINTS.some((hint) => padded.includes(hint));
  }

  /** Cheap content sniff — true if any doc has both `apiVersion` and `kind`. */
  static sniff(content: string): boolean {
    if (!content || content.length === 0) return false;
    if (!/\bapiVersion\s*:/.test(content) || !/\bkind\s*:/.test(content)) return false;
    return true;
  }

  extract(content: string, relativePath: string, repoUrl: string): K8sExtractionResult {
    let docs: unknown[];
    try {
      docs = yamlLoadAll(content) as unknown[];
    } catch (err) {
      this.logger.warn({ err, path: relativePath }, 'Failed to parse K8s manifest YAML');
      return { configKeys: [], secretRefs: [] };
    }

    const configKeys: ConfigKeyNode[] = [];
    const secretRefs: SecretRefNode[] = [];

    for (const doc of docs) {
      if (!isObject(doc)) continue;
      const root = doc as ManifestRoot;
      const kind = typeof root.kind === 'string' ? root.kind : undefined;
      if (!kind) continue;

      const meta = isObject(root.metadata) ? root.metadata : undefined;
      const name = typeof meta?.['name'] === 'string' ? (meta['name'] as string) : 'unnamed';

      if (kind === 'ConfigMap') {
        emitDataEntries(root, name, relativePath, repoUrl, configKeys, /* secret */ false);
        continue;
      }
      if (kind === 'Secret') {
        emitSecretEntries(root, name, relativePath, repoUrl, secretRefs);
        continue;
      }
      if (WORKLOAD_KINDS.has(kind)) {
        walkPodSpec(root.spec, relativePath, repoUrl, configKeys, secretRefs);
      }
    }

    return { configKeys, secretRefs };
  }
}

// -- helpers ----------------------------------------------------------------

function emitDataEntries(
  root: ManifestRoot,
  cmName: string,
  filePath: string,
  repoUrl: string,
  out: ConfigKeyNode[],
  forceSecret: boolean,
): void {
  for (const field of ['data', 'stringData'] as const) {
    const data = root[field];
    if (!isObject(data)) continue;
    for (const [key, value] of Object.entries(data)) {
      out.push(makeConfigKeyNode({
        key: `${cmName}.${key}`,
        repoUrl,
        filePath,
        sourceLine: 0,
        kind: 'K8S',
        defaultValue: stringifyLeaf(value),
        isSecret: forceSecret || isSecretLikeKey(key),
      }));
    }
  }
}

function emitSecretEntries(
  root: ManifestRoot,
  secretName: string,
  filePath: string,
  repoUrl: string,
  out: SecretRefNode[],
): void {
  for (const field of ['data', 'stringData'] as const) {
    const data = root[field];
    if (!isObject(data)) continue;
    for (const key of Object.keys(data)) {
      out.push(makeSecretRefNode({
        vendor: 'K8S_SECRET',
        ref: `k8s:${secretName}#${key}`,
        repoUrl,
        filePath,
        sourceLine: 0,
      }));
    }
  }
}

function walkPodSpec(
  spec: unknown,
  filePath: string,
  repoUrl: string,
  configOut: ConfigKeyNode[],
  secretOut: SecretRefNode[],
): void {
  // Deployment/StatefulSet/Job/CronJob → spec.template.spec.containers
  // CronJob nests one level deeper: spec.jobTemplate.spec.template.spec.containers
  const containers = collectContainers(spec);
  for (const c of containers) {
    if (!isObject(c)) continue;
    handleContainerEnv(c['env'], filePath, repoUrl, configOut, secretOut);
    handleContainerEnvFrom(c['envFrom'], filePath, repoUrl, configOut, secretOut);
  }
}

function collectContainers(spec: unknown): unknown[] {
  if (!isObject(spec)) return [];
  // Direct: spec.containers (Pod)
  if (Array.isArray(spec['containers'])) return spec['containers'];
  // PodTemplate: spec.template.spec.containers
  const template = isObject(spec['template']) ? spec['template'] : undefined;
  if (template && isObject(template['spec']) && Array.isArray((template['spec'] as Record<string, unknown>)['containers'])) {
    return (template['spec'] as Record<string, unknown>)['containers'] as unknown[];
  }
  // CronJob: spec.jobTemplate.spec.template.spec.containers
  const jobTemplate = isObject(spec['jobTemplate']) ? spec['jobTemplate'] : undefined;
  if (jobTemplate) {
    return collectContainers(jobTemplate['spec']);
  }
  return [];
}

function handleContainerEnv(
  envField: unknown,
  filePath: string,
  repoUrl: string,
  configOut: ConfigKeyNode[],
  secretOut: SecretRefNode[],
): void {
  if (!Array.isArray(envField)) return;
  for (const entry of envField) {
    if (!isObject(entry)) continue;
    const name = typeof entry['name'] === 'string' ? entry['name'] : undefined;
    if (!name) continue;
    const valueFrom = isObject(entry['valueFrom']) ? entry['valueFrom'] : undefined;
    const secretKeyRef = valueFrom && isObject(valueFrom['secretKeyRef']) ? valueFrom['secretKeyRef'] : undefined;
    if (secretKeyRef) {
      const secretName = typeof secretKeyRef['name'] === 'string' ? secretKeyRef['name'] : 'unknown';
      const secretKey = typeof secretKeyRef['key'] === 'string' ? secretKeyRef['key'] : name;
      secretOut.push(makeSecretRefNode({
        vendor: 'K8S_SECRET',
        ref: `k8s:${secretName}#${secretKey}`,
        repoUrl,
        filePath,
        sourceLine: 0,
      }));
      continue;
    }
    const defaultValue = typeof entry['value'] === 'string' ? entry['value'] : stringifyLeaf(entry['value']);
    configOut.push(makeConfigKeyNode({
      key: name,
      repoUrl,
      filePath,
      sourceLine: 0,
      kind: 'K8S',
      defaultValue,
      isSecret: isSecretLikeKey(name),
    }));
  }
}

function handleContainerEnvFrom(
  envFromField: unknown,
  filePath: string,
  repoUrl: string,
  configOut: ConfigKeyNode[],
  secretOut: SecretRefNode[],
): void {
  if (!Array.isArray(envFromField)) return;
  for (const entry of envFromField) {
    if (!isObject(entry)) continue;
    const cmRef = isObject(entry['configMapRef']) ? entry['configMapRef'] : undefined;
    const secRef = isObject(entry['secretRef']) ? entry['secretRef'] : undefined;
    if (cmRef && typeof cmRef['name'] === 'string') {
      configOut.push(makeConfigKeyNode({
        key: `${cmRef['name']}.*`,
        repoUrl,
        filePath,
        sourceLine: 0,
        kind: 'K8S',
        defaultValue: '',
        isSecret: false,
      }));
    }
    if (secRef && typeof secRef['name'] === 'string') {
      secretOut.push(makeSecretRefNode({
        vendor: 'K8S_SECRET',
        ref: `k8s:${secRef['name']}#*`,
        repoUrl,
        filePath,
        sourceLine: 0,
      }));
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
