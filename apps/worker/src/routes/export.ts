import { DownloadQuery, ExportRequest } from "@garderobe/contracts/ext/api";
import { ApiException } from "../errors.ts";
import { getImport, importPackage } from "../export/import.ts";
import { downloadExport, getExport, issueDownloadTicket, listExports, requestExport } from "../export/job.ts";
import { json, readBytes, readJson, readQuery } from "../http.ts";
import { owner, selfAuthenticated, type RouteDef } from "../router.ts";

const MAX_IMPORT_BYTES = 95 * 1024 * 1024;

export function exportRoutes(): RouteDef[] {
  return [
    owner("POST", "/v1/exports", "admin", async ({ app, session, request }) => json(await requestExport(app, session, await readJson(request, ExportRequest)))),

    owner("GET", "/v1/exports", "admin", async ({ app, session }) => json({ exports: await listExports(app, session) })),

    owner("GET", "/v1/exports/{id}", "admin", async ({ app, session, params, exec }) => json(await getExport(app, session, params.id!, exec))),

    owner("POST", "/v1/exports/{id}/ticket", "admin", async ({ app, session, params }) => json(await issueDownloadTicket(app, session, params.id!))),

    /* Authenticated by the single-use ticket an authenticated owner was just given. */
    selfAuthenticated("GET", "/v1/exports/{id}/download", "ticket", async ({ app, params, url }) => downloadExport(app, params.id!, readQuery(url, DownloadQuery).ticket)),

    owner("POST", "/v1/imports", "admin", async ({ app, session, request }) => {
      const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/zip" && type !== "application/octet-stream") throw new ApiException("unsupported_media_type", "send the export package as application/zip or application/octet-stream");
      const body = await readBytes(request, MAX_IMPORT_BYTES);
      if (body.length === 0) throw new ApiException("invalid_command", "the request has no package");
      return json(await importPackage(app, session, body, request.headers.get("X-Garderobe-Passphrase")));
    }),

    owner("GET", "/v1/imports/{id}", "admin", async ({ app, session, params }) => json(await getImport(app, session, params.id!))),
  ];
}
