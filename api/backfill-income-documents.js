// api/backfill-income-documents.js
// One-time, idempotent backfill that creates missing application_documents rows
// for income-verification files already in Supabase Storage.
//
// Background: the application_documents table and upload-income-verification
// endpoint were added after some applications had already been submitted.  Those
// older applications may have files sitting in the "application-documents" bucket
// under  {applicationId}/income-verification/  but have no corresponding DB
// record — so the Admin review panel shows nothing.
//
// This endpoint is safe to run multiple times.  It skips any storage file that
// already has a matching application_documents row (matched by file_path).
//
// POST /api/backfill-income-documents
// Protected by ADMIN_SECRET (Authorization: Bearer <secret>  or  body.secret).
//
// Body (JSON):
//   {
//     secret?:     string   — alternative to Authorization header
//     action:      "preview" | "run" | "status"
//     cursor?:     string   — applicationId to continue from (pagination)
//     chunk_size?: number   — applications per page (default 50, max 200)
//   }
//
// Returns:
//   preview/run —
//     { action, counters, next_cursor, has_more, message }
//     counters: { applications_scanned, files_found, records_created,
//                 records_skipped, errors }
//   status —
//     { action, total_applications, total_documents }

import { isAdminAuthorized, extractAdminSecret } from "./_admin-auth.js";
import { getSupabaseAdmin } from "./_supabase.js";
import {
  INCOME_VERIFICATION_BUCKET,
  INCOME_VERIFICATION_DOC_TYPE,
  normalizeIncomeVerificationMime,
} from "./_income-verification.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];

const DEFAULT_CHUNK_SIZE = 50;
const MAX_CHUNK_SIZE = 200;

function normalizedLength(value) {
  if (typeof value !== "string") return 0;
  return value.trim().length;
}

function detectSecretSource(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  if (authHeader.startsWith("Bearer ")) return "authorization_bearer";
  if (authHeader) return "authorization_non_bearer";
  if (req.query?.secret) return "query.secret";
  if (req.body?.secret) return "body.secret";
  return "none";
}

function logAdminAuthDiagnostics(req, suppliedSecret, isAuthorized) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  console.info("backfill-income-documents auth diagnostics", {
    auth_header_present: Boolean(authHeader),
    auth_header_uses_bearer: authHeader.startsWith("Bearer "),
    secret_source: detectSecretSource(req),
    supplied_secret_length: normalizedLength(suppliedSecret),
    comparison_passed: Boolean(isAuthorized),
  });
}

// Extension → MIME fallback (kept local to avoid server-side DOM dep)
const EXT_TO_MIME = {
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  png:  "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf:  "application/pdf",
};

function mimeFromPath(filePath) {
  const ext = String(filePath || "").split(".").pop().toLowerCase();
  const raw = EXT_TO_MIME[ext] || "application/octet-stream";
  return normalizeIncomeVerificationMime(raw) || raw;
}

function fileNameFromPath(filePath) {
  return String(filePath || "").split("/").pop() || "upload";
}

// List all objects in storage under {applicationId}/income-verification/
async function listStorageFiles(sb, applicationId) {
  const prefix = `${applicationId}/income-verification`;
  const { data, error } = await sb.storage
    .from(INCOME_VERIFICATION_BUCKET)
    .list(prefix, { limit: 1000, sortBy: { column: "created_at", order: "asc" } });

  if (error) {
    const msg = String(error.message || "").toLowerCase();
    // Bucket / prefix not found is not an error — application just has no files.
    if (
      msg.includes("not found") ||
      msg.includes("does not exist") ||
      msg.includes("no such key")
    ) {
      return { files: [], error: null };
    }
    return { files: [], error };
  }

  // Filter out empty placeholder entries (Supabase creates a .emptyFolderPlaceholder)
  const files = (data || []).filter(
    (f) => f.name && !f.name.endsWith(".emptyFolderPlaceholder")
  );
  return { files, error: null };
}

// Return the set of file_paths already recorded in application_documents for
// this application, so we can skip them.
async function fetchExistingFilePaths(sb, applicationId) {
  const { data, error } = await sb
    .from("application_documents")
    .select("file_path")
    .eq("application_id", applicationId)
    .eq("doc_type", INCOME_VERIFICATION_DOC_TYPE);

  if (error) {
    // Table may not exist in older environments — treat as empty set.
    return { paths: new Set(), error };
  }
  const paths = new Set((data || []).map((r) => r.file_path).filter(Boolean));
  return { paths, error: null };
}

// Insert a single backfill document record.
async function insertDocumentRecord(sb, { applicationId, filePath, fileName, mimeType, fileSizeBytes }) {
  const { error } = await sb.from("application_documents").insert({
    application_id:      applicationId,
    doc_type:            INCOME_VERIFICATION_DOC_TYPE,
    file_name:           fileName,
    mime_type:           mimeType,
    file_path:           filePath,
    file_size_bytes:     fileSizeBytes ?? null,
    verification_status: "pending",
  });
  return error || null;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const suppliedSecret = extractAdminSecret(req);
  const isAuthorized = isAdminAuthorized(suppliedSecret);
  logAdminAuthDiagnostics(req, suppliedSecret, isAuthorized);
  if (!isAuthorized) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Supabase not configured." });

  const body = req.body || {};
  const action = String(body.action || "preview");
  const isDryRun = action === "preview";

  if (!["preview", "run", "status"].includes(action)) {
    return res.status(400).json({ error: 'action must be "preview", "run", or "status"' });
  }

  // ── Action: status ───────────────────────────────────────────────────────────
  if (action === "status") {
    const [appCount, docCount] = await Promise.all([
      sb.from("renter_applications").select("id", { count: "exact", head: true }),
      sb
        .from("application_documents")
        .select("id", { count: "exact", head: true })
        .eq("doc_type", INCOME_VERIFICATION_DOC_TYPE),
    ]);
    return res.status(200).json({
      action: "status",
      total_applications: appCount.count ?? null,
      total_income_documents: docCount.count ?? null,
    });
  }

  // ── Action: preview / run ────────────────────────────────────────────────────
  const chunkSize = Math.min(
    parseInt(body.chunk_size ?? DEFAULT_CHUNK_SIZE, 10) || DEFAULT_CHUNK_SIZE,
    MAX_CHUNK_SIZE
  );
  const cursor = body.cursor ?? null; // last applicationId processed (for resume)

  // Fetch a page of applications (ordered by id so cursor is stable)
  let query = sb
    .from("renter_applications")
    .select("id, created_at")
    .order("id")
    .limit(chunkSize);

  if (cursor) query = query.gt("id", cursor);

  const { data: applications, error: fetchErr } = await query;
  if (fetchErr) {
    return res.status(500).json({ error: `Failed to fetch applications: ${fetchErr.message}` });
  }

  const counters = {
    applications_scanned: 0,
    files_found:          0,
    records_created:      0,
    records_skipped:      0,
    errors:               0,
  };
  const errors = [];
  let lastCursor = cursor;

  for (const app of applications ?? []) {
    counters.applications_scanned++;

    // List files in storage for this application
    const { files, error: listErr } = await listStorageFiles(sb, app.id);
    if (listErr) {
      counters.errors++;
      errors.push({ applicationId: app.id, stage: "list_storage", message: listErr.message });
      lastCursor = app.id;
      continue;
    }

    if (!files.length) {
      lastCursor = app.id;
      continue;
    }

    counters.files_found += files.length;

    // Fetch existing DB paths for this application (idempotency guard)
    const { paths: existingPaths, error: pathsErr } = await fetchExistingFilePaths(sb, app.id);
    if (pathsErr) {
      // If table doesn't exist yet, continue — we'll attempt inserts anyway and
      // let the insert report any error
      console.warn(
        `backfill-income-documents: could not fetch existing paths for ${app.id}:`,
        pathsErr.message
      );
    }

    for (const file of files) {
      const filePath = `${app.id}/income-verification/${file.name}`;

      if (existingPaths.has(filePath)) {
        counters.records_skipped++;
        continue;
      }

      const mimeType    = mimeFromPath(file.name);
      const fileName    = fileNameFromPath(file.name);
      const fileSizeBytes =
        file.metadata?.size ?? file.metadata?.contentLength ?? null;

      if (!isDryRun) {
        const insertErr = await insertDocumentRecord(sb, {
          applicationId: app.id,
          filePath,
          fileName,
          mimeType,
          fileSizeBytes,
        });

        if (insertErr) {
          const msg = String(insertErr.message || "");
          // Unique-constraint violation means it was already inserted concurrently — OK
          if (insertErr.code === "23505" || msg.includes("duplicate")) {
            counters.records_skipped++;
          } else {
            counters.errors++;
            errors.push({
              applicationId: app.id,
              filePath,
              stage:         "insert",
              message:       msg,
            });
          }
          continue;
        }
      }

      counters.records_created++;
    }

    lastCursor = app.id;
  }

  const hasMore = (applications?.length ?? 0) === chunkSize;

  if (errors.length) {
    console.error("backfill-income-documents: errors encountered", errors);
  }

  return res.status(200).json({
    action,
    dry_run:     isDryRun,
    counters,
    next_cursor: hasMore ? lastCursor : null,
    has_more:    hasMore,
    ...(errors.length ? { sample_errors: errors.slice(0, 10) } : {}),
    message: hasMore
      ? `Chunk complete. Pass next_cursor="${lastCursor}" to continue.`
      : isDryRun
        ? `Preview complete. ${counters.files_found} storage files found; ${counters.records_created} would be created.`
        : `Backfill complete. ${counters.records_created} records created, ${counters.records_skipped} already existed.`,
  });
}
