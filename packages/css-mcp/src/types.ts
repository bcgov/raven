/** CSS integration environments a team can manage through the API. */
export type CssEnvironment = "dev" | "test" | "prod";

/** A Gold integration owned by the API account's team. */
export interface CssIntegration {
  id: number;
  projectName: string;
  authType?: string;
  environments?: string[];
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A client role defined on one integration environment. */
export interface CssRole {
  name: string;
  composite?: boolean;
}

/**
 * A user as CSS reports them. `username` is the federated form
 * `<guid>@<idp alias>`, which is what role assignment takes.
 */
export interface CssUser {
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, string[] | string>;
}

/** IDIR directory search criteria; at least one must be set. */
export interface IdirSearch {
  firstName?: string;
  lastName?: string;
  email?: string;
  guid?: string;
}

/** Connection settings for {@link CssClient}. */
export interface CssClientConfig {
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  tokenUrl: string;
}
