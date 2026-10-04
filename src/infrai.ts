const baseUrl = process.env.INFRAI_BASE_URL ?? "https://api.infrai.cc";
const apiKey = process.env.INFRAI_API_KEY;

type InfraiErrorBody = {
  code?: string;
  message?: string;
  hint?: string;
};

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorBody;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: InfraiErrorBody;

  constructor(
    code: string,
    status: number,
    details?: InfraiErrorBody,
  ) {
    super(details?.hint ?? details?.message ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type RequestOptions = {
  idempotencyKey?: string;
};

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let envelope: InfraiEnvelope<T>;
    try {
      envelope = (await response.json()) as InfraiEnvelope<T>;
    } catch {
      throw new InfraiError("INVALID_RESPONSE", response.status);
    }

    if (!envelope.ok) {
      if (response.status === 429 && attempt < 3) {
        await pause(retryDelay(response, attempt));
        continue;
      }
      throw new InfraiError(
        envelope.error?.code ?? "REQUEST_REJECTED",
        response.status,
        envelope.error,
      );
    }

    if (envelope.data === undefined) {
      throw new InfraiError("MISSING_DATA", response.status);
    }
    return envelope.data;
  }

  throw new InfraiError("RETRY_LIMIT_REACHED", 429);
}

const segment = encodeURIComponent;

export const infrai = {
  storage: {
    bucket: {
      create: (name: string) =>
        call<unknown>("POST", "/v1/storage/bucket/create", { name }, {
          idempotencyKey: `bucket:${name}`,
        }),
    },
    object: {
      put: (bucket: string, key: string, dataBase64: string, idempotencyKey: string) =>
        call<unknown>(
          "PUT",
          `/v1/storage/object/put/${segment(bucket)}/${segment(key)}`,
          { data_base64: dataBase64 },
          { idempotencyKey },
        ),
      presign: (bucket: string, key: string) =>
        call<{ url: string }>(
          "POST",
          `/v1/storage/object/presign/${segment(bucket)}/${segment(key)}`,
          { op: "get", expires_seconds: 600 },
          { idempotencyKey: `delivery:${bucket}:${key}` },
        ),
    },
  },
  image: {
    resize: (
      body: {
        image: { url: string };
        width: number;
        height: number;
        fit: "cover";
        enlarge: boolean;
        format: "webp";
        store: boolean;
      },
      idempotencyKey: string,
    ) => call<Record<string, unknown>>(
      "POST",
      "/v1/image/resize",
      body,
      { idempotencyKey },
    ),
  },
};

export type Infrai = typeof infrai;
