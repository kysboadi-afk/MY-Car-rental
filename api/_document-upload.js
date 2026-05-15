const EXTENSION_TO_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const MIME_TYPE_ALIASES = {
  "image/jpg": "image/jpeg",
  "application/x-pdf": "application/pdf",
};

const MIME_TO_EXTENSION = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeFileName(fileName, fallback = "upload") {
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return safe || fallback;
}

export function inferMimeTypeFromFileName(fileName) {
  const safeName = sanitizeFileName(fileName, "");
  const match = safeName.match(/\.([a-z0-9]+)$/i);
  if (!match) return null;
  return EXTENSION_TO_MIME[match[1].toLowerCase()] || null;
}

export function normalizeDocumentMimeType(mimeType, fileName, fallback = "application/octet-stream") {
  const raw = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  if (raw) {
    return MIME_TYPE_ALIASES[raw] || raw;
  }
  return inferMimeTypeFromFileName(fileName) || fallback;
}

export function extensionForMimeType(mimeType, fileName, fallback = "bin") {
  const normalizedMimeType = normalizeDocumentMimeType(mimeType, fileName, "");
  if (normalizedMimeType && MIME_TO_EXTENSION[normalizedMimeType]) {
    return MIME_TO_EXTENSION[normalizedMimeType];
  }
  const inferredMimeType = inferMimeTypeFromFileName(fileName);
  if (inferredMimeType && MIME_TO_EXTENSION[inferredMimeType]) {
    return MIME_TO_EXTENSION[inferredMimeType];
  }
  return fallback;
}

export function isAllowedDocumentMimeType(mimeType) {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

export function normalizeBase64Payload(base64Value) {
  if (!base64Value || typeof base64Value !== "string") return "";
  return base64Value.replace(/\s+/g, "").replace(/^data:.*;base64,/i, "");
}

export function estimateBase64Bytes(base64Value) {
  const normalized = normalizeBase64Payload(base64Value);
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : (normalized.endsWith("=") ? 1 : 0);
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function hasBase64Payload(base64Value) {
  return normalizeBase64Payload(base64Value).length > 0;
}

export function decodeBase64Document({ base64Data, mimeType, fileName, maxBytes }) {
  const normalizedBase64 = normalizeBase64Payload(base64Data);
  const normalizedMimeType = normalizeDocumentMimeType(mimeType, fileName);
  const buffer = Buffer.from(normalizedBase64, "base64");
  if (!buffer.length && normalizedBase64) {
    throw new Error("Invalid base64 data");
  }
  if (maxBytes && buffer.length > maxBytes) {
    throw new Error(`File too large. Maximum size is ${maxBytes / 1024 / 1024} MB.`);
  }
  return {
    base64: normalizedBase64,
    buffer,
    mimeType: normalizedMimeType,
    fileName: sanitizeFileName(fileName),
    extension: extensionForMimeType(normalizedMimeType, fileName),
    bytes: buffer.length,
  };
}

export function buildUploadDiagnostics(req, docs = []) {
  const headers = req?.headers || {};
  return {
    origin: headers.origin || null,
    referer: headers.referer || headers.referrer || null,
    userAgent: headers["user-agent"] || null,
    forwardedFor: headers["x-forwarded-for"] || null,
    docs: docs.map((doc) => ({
      field: doc.field,
      fileName: doc.fileName || null,
      mimeType: normalizeDocumentMimeType(doc.mimeType, doc.fileName),
      bytes: estimateBase64Bytes(doc.base64),
      hasPayload: hasBase64Payload(doc.base64),
    })),
  };
}

export function summarizeSupabaseError(error) {
  if (!error) return { message: "unknown error", code: null };
  return {
    message: error.message || error.details || String(error),
    code: error.code || error.statusCode || null,
    details: error.details || null,
    hint: error.hint || null,
    statusCode: error.statusCode || null,
  };
}

export function isRetriableSupabaseError(error) {
  const { message = "", statusCode = null, code = "" } = summarizeSupabaseError(error);
  const haystack = `${message} ${code}`.toLowerCase();
  if (statusCode && statusCode >= 500) return true;
  return haystack.includes("timeout")
    || haystack.includes("timed out")
    || haystack.includes("network")
    || haystack.includes("fetch failed")
    || haystack.includes("temporarily unavailable")
    || haystack.includes("connection terminated")
    || haystack.includes("econnreset");
}

export async function retrySupabaseOperation(run, { attempts = 3, baseDelayMs = 250, label = "supabase-operation" } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await run(attempt);
      if (!result?.error) return result;
      lastError = result.error;
      if (!isRetriableSupabaseError(result.error) || attempt === attempts) {
        return result;
      }
      console.warn(`${label}: retrying transient Supabase error on attempt ${attempt}/${attempts}:`, summarizeSupabaseError(result.error));
    } catch (error) {
      lastError = error;
      if (!isRetriableSupabaseError(error) || attempt === attempts) {
        throw error;
      }
      console.warn(`${label}: retrying thrown transient error on attempt ${attempt}/${attempts}:`, summarizeSupabaseError(error));
    }
    await sleep(baseDelayMs * attempt);
  }
  return { error: lastError };
}

export async function uploadWithBucketRecovery(sb, bucket, filePath, buffer, uploadOptions = {}, bucketOptions = {}) {
  let result = await sb.storage.from(bucket).upload(filePath, buffer, uploadOptions);
  if (!result?.error) return result;

  const errorSummary = summarizeSupabaseError(result.error);
  const haystack = `${errorSummary.message || ""} ${errorSummary.code || ""}`.toLowerCase();
  if (!haystack.includes("bucket") || (!haystack.includes("not found") && !haystack.includes("does not exist"))) {
    return result;
  }

  console.warn(`uploadWithBucketRecovery: bucket ${bucket} missing, attempting to create it`);
  const createResult = await sb.storage.createBucket(bucket, bucketOptions);
  if (createResult?.error) {
    console.error(`uploadWithBucketRecovery: failed to create bucket ${bucket}:`, summarizeSupabaseError(createResult.error));
    return result;
  }

  result = await sb.storage.from(bucket).upload(filePath, buffer, uploadOptions);
  return result;
}
