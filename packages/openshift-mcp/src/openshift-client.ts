import { ApiException, CoreV1Api, KubeConfig, KubernetesObjectApi } from "@kubernetes/client-node";
import type { KubernetesObject, ResponseContext } from "@kubernetes/client-node";

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
  /** Whether the kind lives inside a namespace (false for cluster-scoped kinds such as Node). */
  isNamespaced(apiVersion: string, kind: string): Promise<boolean>;
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

/**
 * Generic object API that returns responses as plain JSON. The stock
 * deserializer maps list metadata of non-built-in kinds (RouteList, BuildList,
 * ProjectList, …) to V1ObjectMeta, which drops the `continue` pagination token.
 */
class RawObjectApi extends KubernetesObjectApi {
  static create(kc: KubeConfig): RawObjectApi {
    const api = kc.makeApiClient(RawObjectApi);
    api.setDefaultNamespace(kc);
    return api;
  }

  async isNamespaced(apiVersion: string, kind: string): Promise<boolean> {
    const resource = await this.resource(apiVersion, kind);
    if (!resource) throw new Error(`Unrecognized API version and kind: ${apiVersion} ${kind}`);
    return resource.namespaced;
  }

  protected override async processResponse<T extends KubernetesObject>(response: ResponseContext): Promise<T> {
    if (response.httpStatusCode >= 200 && response.httpStatusCode <= 299) {
      return JSON.parse(await response.body.text()) as T;
    }
    throw new ApiException(response.httpStatusCode, "Unsuccessful HTTP Request", await response.getBodyAsAny(), response.headers);
  }
}

export class KubeOpenShiftReader implements OpenShiftReader {
  private readonly objects: RawObjectApi;
  private readonly core: CoreV1Api;

  constructor(kc: KubeConfig = loadKubeConfig()) {
    this.objects = RawObjectApi.create(kc);
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
    const metadata = result.metadata as { continue?: string } | undefined;
    return { items: result.items ?? [], continueToken: metadata?.continue || undefined };
  }

  isNamespaced(apiVersion: string, kind: string): Promise<boolean> {
    return this.objects.isNamespaced(apiVersion, kind);
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
