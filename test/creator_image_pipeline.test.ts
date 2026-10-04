import assert from "node:assert/strict";
import test from "node:test";
import type { Infrai } from "../src/infrai.js";
import { publishCreatorImage } from "../src/creator_image_pipeline.js";

test("storefront uploads become square stored renditions and notify subscribers", async () => {
  const calls: Array<{ name: string; value: unknown }> = [];
  const client = {
    storage: {
      bucket: {
        create: async (name: string) => {
          calls.push({ name: "bucket.create", value: name });
          return {};
        },
      },
      object: {
        put: async (_bucket: string, key: string) => {
          calls.push({ name: "object.put", value: key });
          return {};
        },
        presign: async () => ({ url: "https://signed.example/source" }),
      },
    },
    image: {
      resize: async (body: Record<string, unknown>) => {
        calls.push({ name: "image.resize", value: body });
        return { url: "https://cdn.example/thumbnail.webp" };
      },
    },
  } as unknown as Infrai;

  const result = await publishCreatorImage(client, "creator-assets", {
    creatorId: "maya",
    assetId: "741c0d1a-61de-4b9d-9077-01ed0b010b2a",
    filename: "launch.png",
    contentType: "image/png",
    dataBase64: "aW1hZ2U=",
    placement: "storefront",
  });

  assert.equal(result.asset.state, "ready");
  assert.equal(result.asset.width, 1200);
  assert.equal(result.asset.height, 1200);
  assert.deepEqual(result.subscriberUpdate, {
    type: "subscriber.asset_available",
    creatorId: "maya",
    assetId: "741c0d1a-61de-4b9d-9077-01ed0b010b2a",
    placement: "storefront",
  });
  assert.deepEqual(calls.map((call) => call.name), [
    "bucket.create",
    "object.put",
    "image.resize",
  ]);
  assert.deepEqual(calls[2]?.value, {
    image: { url: "https://signed.example/source" },
    width: 1200,
    height: 1200,
    fit: "cover",
    enlarge: false,
    format: "webp",
    store: true,
  });
});
