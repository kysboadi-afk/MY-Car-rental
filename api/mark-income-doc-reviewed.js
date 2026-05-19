// api/mark-income-doc-reviewed.js
// Admin endpoint: mark an income-verification document as reviewed or flagged.
//
// POST /api/mark-income-doc-reviewed
// Body (JSON): {
//   secret:     string  — ADMIN_SECRET
//   documentId: string  — UUID of the application_documents row
//   status:     string  — "reviewed" | "flagged"
//   notes:      string  — optional reviewer notes
//   reviewedBy: string  — optional reviewer name (defaults to "Admin")
// }
//
// Returns: { success: true, documentId, reviewStatus }

import { getSupabaseAdmin } from "./_supabase.js";
import { isAdminAuthorized, extractAdminSecret } from "./_admin-auth.js";
import { summarizeSupabaseError } from "./_document-upload.js";
import { adminErrorMessage } from "./_error-helpers.js";

const ALLOWED_ORIGINS = ["https://www.slytrans.com", "https://slytrans.com", "https://slycarrentals.com", "https://www.slycarrentals.com", "https://admin.slycarrentals.com"];
const ALLOWED_STATUSES = new Set(["reviewed", "flagged", "pending"]);

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  if (!isAdminAuthorized(extractAdminSecret(req))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { documentId, status, notes, reviewedBy } = req.body || {};

  if (!documentId || typeof documentId !== "string" || !documentId.trim()) {
    return res.status(400).json({ error: "documentId is required." });
  }
  if (!status || !ALLOWED_STATUSES.has(status)) {
    return res.status(400).json({
      error: `status must be one of: ${[...ALLOWED_STATUSES].join(", ")}`,
    });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: "Database not configured." });

  try {
    const { data, error } = await sb
      .from("application_documents")
      .update({
        review_status: status,
        reviewed_by: (typeof reviewedBy === "string" && reviewedBy.trim()) ? reviewedBy.trim().slice(0, 200) : "Admin",
        reviewed_at: new Date().toISOString(),
        notes: (typeof notes === "string" && notes.trim()) ? notes.trim().slice(0, 2000) : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId.trim())
      .select("id, review_status, reviewed_by, reviewed_at")
      .single();

    if (error) {
      console.error("mark-income-doc-reviewed: update failed", {
        documentId: documentId.trim(),
        error: summarizeSupabaseError(error),
      });
      return res.status(500).json({ error: "Failed to update document status." });
    }

    return res.status(200).json({
      success: true,
      documentId: data.id,
      reviewStatus: data.review_status,
      reviewedBy: data.reviewed_by,
      reviewedAt: data.reviewed_at,
    });
  } catch (err) {
    console.error("mark-income-doc-reviewed: unexpected error", adminErrorMessage(err));
    return res.status(500).json({ error: "Unexpected server error." });
  }
}
