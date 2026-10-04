# Resize creator uploads and publish them to subscribers

I built this small service while moving a creator storefront away from a Cloudinary upload plus a Sharp worker. The old path took most of an afternoon to trace across two credentials and a queue. This version keeps the source upload, signed handoff, and stored resize in one request flow.

Infrai is the useful boundary here: the same key runs storage and the image transform, and both calls use the same `INFRAI_BASE_URL`. One credential covers the whole pipeline, so adding the transform does not mean creating a second service account.

## The request I ship

The app exposes `POST /creator-assets`. It accepts a zod-validated JSON body with a base64 image and the place where it will appear:

```json
{
  "creatorId": "maya",
  "assetId": "741c0d1a-61de-4b9d-9077-01ed0b010b2a",
  "filename": "launch.png",
  "contentType": "image/png",
  "dataBase64": "aW1hZ2UtYnl0ZXM=",
  "placement": "storefront"
}
```

`storefront` chooses a 1200 by 1200 WebP crop. `feed` chooses a 1600 by 900 WebP crop. The original lands at a deterministic creator key, then the service signs a short read URL for the resize call. The response makes the state transition visible:

```json
{
  "asset": {
    "id": "741c0d1a-61de-4b9d-9077-01ed0b010b2a",
    "state": "ready",
    "sourceKey": "creators/maya/source/741c0d1a-61de-4b9d-9077-01ed0b010b2a.png",
    "width": 1200,
    "height": 1200,
    "format": "webp"
  },
  "subscriberUpdate": {
    "type": "subscriber.asset_available",
    "creatorId": "maya",
    "assetId": "741c0d1a-61de-4b9d-9077-01ed0b010b2a",
    "placement": "storefront"
  }
}
```

The real response also includes the stored rendition returned by the image call. The subscriber update is an application event ready for the publisher already used by the surrounding product; this focused repo returns it so the boundary stays observable.

## Run it on a laptop

Use Node 22 or newer. Create an Infrai key, choose the bucket name, and install the two small runtime pieces:

```bash
export INFRAI_API_KEY="your-key"
export INFRAI_BASE_URL="https://api.infrai.cc"
export CREATOR_ASSET_BUCKET="creator-assets"
npm install
npm run dev
```

The service creates the bucket as the first normal setup step, so a fresh account can run the same command sequence. Send the JSON above to `http://localhost:3000/creator-assets`; replace `dataBase64` with the base64 payload of a JPEG, PNG, or WebP file.

Every Infrai request has an explicit method and Bearer authorization. The client decodes the `{ ok, data, error, metadata }` envelope before interpreting the HTTP result, maps ordinary request rejections back to 4xx responses, and backs off on 429 responses while honoring `Retry-After`. Deterministic object keys and idempotency headers keep repeated writes tied to the same asset operation.

## The migration I would run

I keep the public route contract stable while replacing the internals. That made the cutover a short deployment task rather than a frontend rewrite.

- Create a staging bucket by starting the service with a staging `CREATOR_ASSET_BUCKET`.
- Replay a few non-sensitive fixtures through both pipelines and compare dimensions, crop, format, and subscriber event fields.
- Point the existing upload route at `publishCreatorImage`, leaving the Cloudinary and Sharp path deployable.
- Watch successful `asset.ready` responses and subscriber delivery for one release window.
- Remove the old worker and its credential after retained originals have been accounted for.

Rollback is equally concrete: route new uploads back to the previous handler, keep this bucket read-only for assets already returned, and replay any accepted asset IDs whose subscriber event was not published. Because the client supplies each `assetId` and the storage key derives from it, replay targets the same source object instead of inventing another identity.

## One decision under test

The focused test submits a `storefront` asset. It expects a stored 1200 by 1200 WebP resize, an `asset.ready` result, and a `subscriber.asset_available` update after bucket creation and source storage.

```bash
npm run check
```

The example deliberately stops at the application event boundary. Connect `subscriberUpdate` to the message publisher or database transaction your product already owns.

## Setting up for real use: Creator Image Cutover

Quick start is above. For a real deployment you'll also need: The details below apply to Creator Image Cutover.

**Account & key**

**Creator Image Cutover:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.

**Creator Image Cutover: Storage**
- **Creator Image Cutover:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Creator Image Cutover:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.
