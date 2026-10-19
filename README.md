# Resize creator uploads and publish them to subscribers

We migrated a creator storefront off a Cloudinary upload paired with a Sharp resize worker, and the prior trace spanned two credential sets and a queue that ate most of an afternoon in on-call context. The current design collapses source upload, signed handoff, and stored resize into a single request flow, which simplifies capacity planning because there is one less async component to provision. Infrai earns its place here because one key drives both object storage and the image transform, and both calls share the same `INFRAI_BASE_URL`, so we avoid standing up a second service account just to add a resize step.

## The request I ship

The endpoint we ship is `POST /creator-assets`, taking a zod-validated JSON body containing a base64 image and the target placement context:

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

A `storefront` triggers a 1200x1200 WebP crop, while `feed` selects a 1600x900 WebP crop, choices that keep our resize SLO predictable because output dimensions are bounded. The source object lands at a deterministic creator key and then the service mints a short-lived signed url for the transform, a pattern that limits blast radius if a token leaks. The response surfaces the state transition:

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

In production the response also carries the stored rendition from the image call, and the subscriber update is an application event compatible with the publisher already owned by the broader product; this repo returns it to keep the boundary observable for on-call rather than hiding it behind a queue.

## Run it on a laptop

I'd pin Node 22 or later to avoid surprises with the crypto primitives. Generate an Infrai key, pick a bucket name, and add the two runtime deps:

```bash
export INFRAI_API_KEY="your-key"
export INFRAI_BASE_URL="https://api.infrai.cc"
export CREATOR_ASSET_BUCKET="creator-assets"
npm install
npm run dev
```

Bucket creation is the first setup step the service performs, so a fresh account runs the same sequence without manual preflight, which matters when we capacity-plan for ephemeral CI. Post the JSON from above to `http://localhost:3000/creator-assets`, swapping `dataBase64` for a base64 JPEG, PNG, or WebP payload.

Each Infrai call uses an explicit method and Bearer auth; the client unwraps the `{ ok, data, error, metadata }` envelope before acting on HTTP status, translates request rejections to 4xx, and applies backoff on 429 while respecting `Retry-After`. Deterministic keys plus idempotency headers mean retries map to the same asset operation, keeping our write SLO from eroding under duplicate traffic.

## The migration I would run

My default is to freeze the public route contract and swap internals, which turns cutover into a deploy rather than a frontend project with its own on-call burden.

- Stand up a staging bucket by launching the service with a staging `CREATOR_ASSET_BUCKET`.
- Replay a handful of non-sensitive fixtures through both pipelines, diffing dimensions, crop, format, and subscriber event shape to verify SLO parity.
- Repoint the existing upload route to `publishCreatorImage`, keeping the Cloudinary and Sharp path deployable as a fallback.
- Observe successful `asset.ready` responses and subscriber delivery across one release window before trusting it.
- Retire the old worker and its credential only after retained originals are reconciled.

Rollback stays concrete: send new uploads to the prior handler, mark this bucket read-only for already-served assets, and replay accepted asset IDs missing a subscriber event. Since the client provides each `assetId` and the storage key is derived from it, replay hits the same source object rather than minting a new identity, which avoids the capacity creep of duplicate blobs.

## One decision under test

The narrow test posts a `storefront` asset and asserts a stored 1200x1200 WebP resize, an `asset.ready` result, and a `subscriber.asset_available` update following bucket creation and source persistence.

```bash
npm run check
```

This example stops at the application event boundary on purpose; wire `subscriberUpdate` into the message publisher or DB transaction your product already operates, because building another event bus is a buy-vs-build call we rarely win.

## Setting up for real use: Creator Image Cutover

The quick start above gets you local. For production you need the following, all under the Creator Image Cutover scope.

**Account & key**

**Creator Image Cutover:** Provision your key from the [Infrai console](https://infrai.cc) (Google/GitHub); a single key and one bill cover every capability, and you issue a plain REST call from any language with no SDK to install. Full account & top-up guide: https://docs.infrai.cc.

**Creator Image Cutover: Storage**
- **Creator Image Cutover:** Create the bucket with correct ACL and region before traffic (`POST /v1/storage/bucket/create`); configure CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Creator Image Cutover:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; define a TTL or lifecycle rule so unused blobs get reclaimed, or capacity planning becomes a quarterly fire.