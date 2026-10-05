export declare const TOKEN_ENV: string;
export declare const ACCOUNT_ENV: string;
export declare const GATEWAY_VARS: string[];
export interface GatewayRoute {
  ready: boolean;
  missing: string[];
  gatewayId: string;
  baseUrl: string | null;
  host: string | null;
}
export declare function gatewayRoute(env?: Record<string, string | undefined>): GatewayRoute;
export declare function gatewayHeaders(role: string, env?: Record<string, string | undefined>): Record<string, string>;
export interface ProbeOperation {
  result: "passed" | "failed";
  status: number | null;
  resolvedModel: string | null;
  elapsedMs: number | null;
  reason: string | null;
}
export interface ProbeReport {
  gatewayId: string;
  gatewayHost: string | null;
  probedAt: string;
  profiles: { profileId: string; gatewayRoute: string | null; operations: Record<string, ProbeOperation> }[];
}
