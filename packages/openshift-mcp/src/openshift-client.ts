import { CoreV1Api, KubeConfig, KubernetesObjectApi } from "@kubernetes/client-node";
import type { KubernetesObject } from "@kubernetes/client-node";

export type KubeObject = KubernetesObject & Record<string, unknown>;

export interface ListOptions {
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  continueToken?: string;
}

export interface ListResult {
  items: KubeObject[];
  continueToken?: string;
}

export interface PodLogOptions {
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
  previous?: boolean;
  limitBytes?: number;
}

/**
 * Read-only view of an OpenShift cluster. Every method maps to an HTTP GET;
 * nothing here may create, patch, delete, exec or attach.
 */
export interface OpenShiftReader {
  list(apiVersion: string, kind: string, options: ListOptions): Promise<ListResult>;
  get(apiVersion: string, kind: string, name: string, namespace?: string): Promise<KubeObject>;
  podLog(namespace: string, name: string, options: PodLogOptions): Promise<string>;
}

/**
 * Load the kubeconfig the same way `oc`/`kubectl` do (KUBECONFIG, then
 * ~/.kube/config, then in-cluster), optionally pinning OPENSHIFT_CONTEXT.
 */
export function loadKubeConfig(context = process.env["OPENSHIFT_CONTEXT"]): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  if (context) {
    if (!kc.getContexts().some((c) => c.name === context)) {
      throw new Error(`OPENSHIFT_CONTEXT '${context}' is not defined in the kubeconfig.`);
    }
    kc.setCurrentContext(context);
  }
  if (!kc.getCurrentCluster()) {
    throw new Error("No OpenShift cluster is configured. Run `oc login` or set KUBECONFIG.");
  }
  if (kc.getCurrentCluster()?.skipTLSVerify && process.env["OPENSHIFT_ALLOW_INSECURE_TLS"] !== "true") {
    throw new Error(
      "The kubeconfig disables TLS verification (insecure-skip-tls-verify). Use the cluster CA instead, " +
        "or set OPENSHIFT_ALLOW_INSECURE_TLS=true to accept this explicitly.",
    );
  }
  return kc;
}

export class KubeOpenShiftReader implements OpenShiftReader {
  private readonly objects: KubernetesObjectApi;
  private readonly core: CoreV1Api;

  constructor(kc: KubeConfig = loadKubeConfig()) {
    this.objects = KubernetesObjectApi.makeApiClient(kc);
    this.core = kc.makeApiClient(CoreV1Api);
  }

  async list(apiVersion: string, kind: string, options: ListOptions): Promise<ListResult> {
    const result = await this.objects.list<KubeObject>(
      apiVersion,
      kind,
      options.namespace,
      undefined,
      undefined,
      undefined,
      options.fieldSelector,
      options.labelSelector,
      options.limit,
      options.continueToken,
    );
    return { items: result.items, continueToken: result.metadata?._continue || undefined };
  }

  async get(apiVersion: string, kind: string, name: string, namespace?: string): Promise<KubeObject> {
    return this.objects.read<KubeObject>({
      apiVersion,
      kind,
      metadata: namespace ? { name, namespace } : { name },
    });
  }

  async podLog(namespace: string, name: string, options: PodLogOptions): Promise<string> {
    return this.core.readNamespacedPodLog({ namespace, name, ...options });
  }
}
