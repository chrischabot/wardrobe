import type { App } from "../app.ts";
import { consentRoutes } from "../mcp/consent.ts";
import { AppRouter, type RouteDef } from "../router.ts";
import { connectionRoutes } from "./connections.ts";
import { conversationRoutes } from "./conversation.ts";
import { coreRoutes } from "./core.ts";
import { dailyRoutes } from "./daily.ts";
import { exportRoutes } from "./export.ts";
import { identityRoutes } from "./identity.ts";
import { mediaRoutes } from "./media.ts";

/** Every application route. Protocol endpoints of the MCP authorization server are served by the OAuth provider. */
export function allRoutes(): RouteDef[] {
  return [...coreRoutes(), ...identityRoutes(), ...dailyRoutes(), ...conversationRoutes(), ...mediaRoutes(), ...connectionRoutes(), ...exportRoutes(), ...consentRoutes()];
}

let router: AppRouter | null = null;

export function appRouter(): AppRouter {
  router ??= new AppRouter(allRoutes());
  return router;
}

export type { App };
