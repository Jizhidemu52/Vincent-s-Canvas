import { Router } from "express";
import { streamAssetContent } from "../asset-delivery";
import { AssetObjectError } from "../asset-object-error";
import type { ObjectStorage } from "../object-storage";
import { ProviderImageAccess, ProviderImageAccessError } from "../provider-image-access";

/** Only unguessable grants are public; no asset lookup, listing or issuance. */
export function createProviderImagesRouter(access: ProviderImageAccess, storage: ObjectStorage,
  report: (receipt: { event: "provider_reference.read"; taskId: string; method: string; status: number; queueToRequestMs: number; grantAgeMs: number }) => void = receipt => console.info(JSON.stringify(receipt))) {
  const router = Router();
  router.use((_request, response, next) => {
    response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    next();
  });
  // Express GET also implements HEAD; both use the same current-state checks.
  router.get(["/:token/image", "/:token/media"], async (request, response) => {
    const receivedAt = Date.now();
    try {
      const token = request.params.token;
      if (typeof token !== "string") throw new ProviderImageAccessError(404);
      const resolved = await access.resolve(token);
      const { taskId, queuedAt, issuedAt } = resolved.timing;
      response.once("finish", () => report({ event: "provider_reference.read", taskId, method: request.method,
        status: response.statusCode, queueToRequestMs: receivedAt - queuedAt, grantAgeMs: receivedAt - issuedAt }));
      await streamAssetContent(request, response, storage, resolved.asset, {
        cacheControl: "no-store", expectedObject: resolved.expectedObject,
        beforeSend: async () => { await access.resolve(token); },
      });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      response.removeHeader("Content-Length");
      response.removeHeader("Content-Range");
      response.removeHeader("Content-Type");
      response.removeHeader("Content-Disposition");
      response.removeHeader("Accept-Ranges");
      response.removeHeader("ETag");
      response.removeHeader("Last-Modified");
      const status = error instanceof ProviderImageAccessError || error instanceof AssetObjectError ? error.status : 503;
      // No object key, token, employee identity or storage diagnostics reach the
      // response or generic HTTP logger through an exception.
      response.status(status).end();
    }
  });
  return router;
}
