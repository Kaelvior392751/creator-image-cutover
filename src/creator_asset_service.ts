import { createServer } from "node:http";
import { z } from "zod";
import { InfraiError, infrai } from "./infrai.js";
import { publishCreatorImage } from "./creator_image_pipeline.js";

const uploadBody = z.object({
  creatorId: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  assetId: z.string().uuid(),
  filename: z.string().min(1).max(180),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  dataBase64: z.string().min(1),
  placement: z.enum(["feed", "storefront"]),
}).strict();

const bucket = process.env.CREATOR_ASSET_BUCKET ?? "creator-assets";
const port = Number(process.env.PORT ?? 3000);

function json(status: number, value: unknown) {
  return {
    status,
    body: JSON.stringify(value),
  };
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/creator-assets") {
    const result = json(404, { error: "route_not_found" });
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(result.body);
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const parsed = uploadBody.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) {
      const result = json(400, {
        error: "invalid_request",
        issues: parsed.error.flatten().fieldErrors,
      });
      response.writeHead(result.status, { "Content-Type": "application/json" });
      response.end(result.body);
      return;
    }

    // The injected pipeline call resolves its transform through infrai.image.resize.
    const result = json(201, await publishCreatorImage(infrai, bucket, parsed.data));
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(result.body);
  } catch (error) {
    const status = error instanceof SyntaxError
      ? 400
      : error instanceof InfraiError && error.status >= 400 && error.status < 500
        ? error.status
        : 500;
    const result = json(status, {
      error: error instanceof InfraiError ? error.code : "request_failed",
    });
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(result.body);
  }
});

server.listen(port, () => {
  console.log(`Creator asset service listening on http://localhost:${port}`);
});
