import type { Infrai } from "./infrai.js";

export type CreatorImageInput = {
  creatorId: string;
  assetId: string;
  filename: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
  placement: "feed" | "storefront";
};

type ThumbnailPlan = {
  width: number;
  height: number;
  fit: "cover";
};

export function chooseThumbnailPlan(
  placement: CreatorImageInput["placement"],
): ThumbnailPlan {
  return placement === "storefront"
    ? { width: 1200, height: 1200, fit: "cover" }
    : { width: 1600, height: 900, fit: "cover" };
}

export async function publishCreatorImage(
  client: Infrai,
  bucket: string,
  input: CreatorImageInput,
) {
  const extension = input.filename.split(".").pop()?.toLowerCase() ?? "bin";
  const sourceKey = `creators/${input.creatorId}/source/${input.assetId}.${extension}`;
  const operationId = `creator-asset:${input.creatorId}:${input.assetId}`;
  const plan = chooseThumbnailPlan(input.placement);

  await client.storage.bucket.create(bucket);
  await client.storage.object.put(
    bucket,
    sourceKey,
    input.dataBase64,
    `${operationId}:source`,
  );
  const source = await client.storage.object.presign(bucket, sourceKey);
  const processed = await client.image.resize(
    {
      image: { url: source.url },
      width: plan.width,
      height: plan.height,
      fit: plan.fit,
      enlarge: false,
      format: "webp",
      store: true,
    },
    `${operationId}:thumbnail`,
  );

  return {
    asset: {
      id: input.assetId,
      state: "ready" as const,
      sourceKey,
      rendition: processed,
      width: plan.width,
      height: plan.height,
      format: "webp" as const,
    },
    subscriberUpdate: {
      type: "subscriber.asset_available" as const,
      creatorId: input.creatorId,
      assetId: input.assetId,
      placement: input.placement,
    },
  };
}
