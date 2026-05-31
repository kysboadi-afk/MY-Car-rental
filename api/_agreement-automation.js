import crypto from "crypto";

const TEMPLATE_KEY_DEFAULT = "rental_standard";
const AGREEMENT_TYPE_DEFAULT = "rental_initial";
const POSTGRES_UNDEFINED_TABLE_ERROR = "42P01";

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeSignatureForHash({
  signerRole,
  signerName,
  signatureMethod,
  signatureText,
  signedAt,
  identitySessionId,
}) {
  return {
    signer_role: normalizeText(signerRole).toLowerCase() || "renter",
    signer_name: normalizeText(signerName),
    signature_method: normalizeText(signatureMethod) || "typed_name",
    signature_text: normalizeText(signatureText),
    signed_at: normalizeText(signedAt),
    identity_session_id: normalizeText(identitySessionId),
  };
}

export function computeAgreementSignatureHash(payload) {
  const normalized = normalizeSignatureForHash(payload || {});
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function computePdfSha256(pdfBuffer) {
  if (!pdfBuffer) return null;
  try {
    return crypto.createHash("sha256").update(pdfBuffer).digest("hex");
  } catch {
    return null;
  }
}

async function resolveActiveTemplateId(sb, templateKey = TEMPLATE_KEY_DEFAULT) {
  if (!sb || !templateKey) return null;
  try {
    const now = nowIso();
    const { data, error } = await sb
      .from("agreement_templates")
      .select("id, template_key, version, status, effective_from, effective_to")
      .eq("template_key", templateKey)
      .eq("status", "active")
      .or(`effective_from.is.null,effective_from.lte.${now}`)
      .or(`effective_to.is.null,effective_to.gte.${now}`)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      if (error.code === POSTGRES_UNDEFINED_TABLE_ERROR) return null;
      throw error;
    }
    return data?.id || null;
  } catch {
    return null;
  }
}

async function loadLatestAgreement(sb, bookingRef) {
  if (!sb || !bookingRef) return null;
  try {
    const { data, error } = await sb
      .from("booking_agreements")
      .select("id, booking_ref, version_number, status, signed_at, created_at, pdf_storage_path, template_id")
      .eq("booking_ref", bookingRef)
      .order("version_number", { ascending: false })
      .limit(1);
    if (error) {
      if (error.code === POSTGRES_UNDEFINED_TABLE_ERROR) return null;
      throw error;
    }
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch {
    return null;
  }
}

export async function upsertBookingAgreement({
  sb,
  bookingRef,
  templateKey = TEMPLATE_KEY_DEFAULT,
  agreementType = AGREEMENT_TYPE_DEFAULT,
  status = "draft",
  payloadSnapshot = {},
  pdfStoragePath = null,
  pdfBuffer = null,
  signedAt = null,
  createdBy = "system",
}) {
  if (!sb || !bookingRef) return null;
  try {
    const templateId = await resolveActiveTemplateId(sb, templateKey);
    const latest = await loadLatestAgreement(sb, bookingRef);
    const updatedAt = nowIso();
    const pdfSha = computePdfSha256(pdfBuffer);
    const nextStatus = latest?.status === "signed" && status !== "voided" ? "signed" : status;

    const basePayload = {
      template_id: templateId || latest?.template_id || null,
      agreement_type: agreementType,
      status: nextStatus,
      payload_snapshot: payloadSnapshot && typeof payloadSnapshot === "object" ? payloadSnapshot : {},
      updated_at: updatedAt,
      pdf_storage_path: pdfStoragePath || null,
      pdf_sha256: pdfSha || null,
      signed_at: nextStatus === "signed" ? (signedAt || updatedAt) : signedAt,
    };

    if (latest?.id) {
      const { data, error } = await sb
        .from("booking_agreements")
        .update(basePayload)
        .eq("id", latest.id)
        .select("id, booking_ref, version_number, status, signed_at, created_at, pdf_storage_path")
        .maybeSingle();
      if (error) {
        if (error.code === POSTGRES_UNDEFINED_TABLE_ERROR) return null;
        throw error;
      }
      return data || null;
    }

    const insertPayload = {
      booking_ref: bookingRef,
      version_number: 1,
      created_at: updatedAt,
      ...basePayload,
    };

    const { data, error } = await sb
      .from("booking_agreements")
      .insert(insertPayload)
      .select("id, booking_ref, version_number, status, signed_at, created_at, pdf_storage_path")
      .maybeSingle();
    if (error) {
      if (error.code === POSTGRES_UNDEFINED_TABLE_ERROR) return null;
      throw error;
    }

    if (data?.id) return data;

    return await loadLatestAgreement(sb, bookingRef);
  } catch (err) {
    console.warn("[agreement-automation] agreement upsert skipped:", err?.message || err);
    return null;
  }
}

export async function upsertBookingAgreementSignature({
  sb,
  bookingRef,
  signatureText,
  signerRole = "renter",
  signerName = "",
  signatureMethod = "typed_name",
  ipAddress = null,
  userAgent = null,
  identitySessionId = null,
  signedAt = null,
  agreementStatusBeforeSign = "issued",
  transitionAgreementToSigned = true,
  payloadSnapshot = {},
  templateKey = TEMPLATE_KEY_DEFAULT,
  agreementType = AGREEMENT_TYPE_DEFAULT,
  createdBy = "system",
}) {
  const signatureValue = normalizeText(signatureText);
  if (!sb || !bookingRef || !signatureValue) return null;
  try {
    const signatureTimestamp = signedAt || nowIso();
    const agreement = await upsertBookingAgreement({
      sb,
      bookingRef,
      templateKey,
      agreementType,
      status: agreementStatusBeforeSign,
      payloadSnapshot,
      signedAt: null,
      createdBy,
    });
    if (!agreement?.id) return null;

    const signaturePayload = {
      agreement_id: agreement.id,
      signer_role: normalizeText(signerRole).toLowerCase() || "renter",
      signer_name: normalizeText(signerName) || signatureValue,
      signature_method: normalizeText(signatureMethod) || "typed_name",
      signature_text: signatureValue,
      signature_hash: computeAgreementSignatureHash({
        signerRole,
        signerName: normalizeText(signerName) || signatureValue,
        signatureMethod,
        signatureText: signatureValue,
        signedAt: signatureTimestamp,
        identitySessionId: identitySessionId || "",
      }),
      ip_address: normalizeText(ipAddress) || null,
      user_agent: normalizeText(userAgent) || null,
      identity_session_id: normalizeText(identitySessionId) || null,
      signed_at: signatureTimestamp,
      created_at: nowIso(),
    };

    const { error: signatureError } = await sb
      .from("booking_agreement_signatures")
      .upsert(signaturePayload, { onConflict: "agreement_id,signer_role" });
    if (signatureError) {
      if (signatureError.code === POSTGRES_UNDEFINED_TABLE_ERROR) return null;
      throw signatureError;
    }

    if (transitionAgreementToSigned) {
      const { error: agreementUpdateError } = await sb
        .from("booking_agreements")
        .update({
          status: "signed",
          signed_at: signatureTimestamp,
          updated_at: nowIso(),
        })
        .eq("id", agreement.id);
      if (agreementUpdateError && agreementUpdateError.code !== POSTGRES_UNDEFINED_TABLE_ERROR) {
        throw agreementUpdateError;
      }
    }

    return signaturePayload;
  } catch (err) {
    console.warn("[agreement-automation] signature upsert skipped:", err?.message || err);
    return null;
  }
}

function mapAgreementSummaryRow(row) {
  const version = Number(row?.version_number || 0);
  return {
    id: row?.id || null,
    version,
    versionNumber: version,
    status: row?.status || "draft",
    signed_at: row?.signed_at || null,
    created_at: row?.created_at || null,
    downloadAvailable: !!row?.pdf_storage_path,
    pdfStoragePath: row?.pdf_storage_path || null,
  };
}

export async function loadBookingAgreementSummary(sb, bookingRef) {
  if (!sb || !bookingRef) {
    return { currentAgreement: null, agreements: [] };
  }
  try {
    const { data, error } = await sb
      .from("booking_agreements")
      .select("id, booking_ref, version_number, status, signed_at, created_at, pdf_storage_path")
      .eq("booking_ref", bookingRef)
      .neq("status", "voided")
      .order("version_number", { ascending: false });
    if (error && error.code !== POSTGRES_UNDEFINED_TABLE_ERROR) throw error;

    const agreements = (Array.isArray(data) ? data : []).map(mapAgreementSummaryRow);
    if (agreements.length > 0) {
      return {
        currentAgreement: agreements[0],
        agreements,
      };
    }
  } catch (err) {
    console.warn("[agreement-automation] summary query skipped:", err?.message || err);
  }

  try {
    const { data: legacyDoc, error: legacyError } = await sb
      .from("pending_booking_docs")
      .select("agreement_pdf_url")
      .eq("booking_id", bookingRef)
      .maybeSingle();
    if (legacyError && legacyError.code !== POSTGRES_UNDEFINED_TABLE_ERROR) throw legacyError;
    if (!legacyDoc?.agreement_pdf_url) {
      return { currentAgreement: null, agreements: [] };
    }
    const legacy = {
      id: null,
      version: 1,
      versionNumber: 1,
      status: "signed",
      signed_at: null,
      created_at: null,
      downloadAvailable: true,
      pdfStoragePath: legacyDoc.agreement_pdf_url,
      source: "legacy",
    };
    return {
      currentAgreement: legacy,
      agreements: [legacy],
    };
  } catch {
    return { currentAgreement: null, agreements: [] };
  }
}

export async function loadAgreementPathForDownload(sb, bookingRef) {
  const summary = await loadBookingAgreementSummary(sb, bookingRef);
  if (summary.currentAgreement?.pdfStoragePath) {
    return {
      path: summary.currentAgreement.pdfStoragePath,
      currentAgreement: summary.currentAgreement,
      agreements: summary.agreements,
    };
  }
  return {
    path: null,
    currentAgreement: summary.currentAgreement,
    agreements: summary.agreements,
  };
}

export async function loadAgreementSummaryMap(sb, bookingRefs = []) {
  const map = new Map();
  if (!sb || !Array.isArray(bookingRefs) || bookingRefs.length === 0) return map;
  const refs = Array.from(new Set(bookingRefs.filter(Boolean)));
  if (refs.length === 0) return map;

  try {
    const { data, error } = await sb
      .from("booking_agreements")
      .select("id, booking_ref, version_number, status, signed_at, created_at, pdf_storage_path")
      .in("booking_ref", refs)
      .neq("status", "voided")
      .order("version_number", { ascending: false });
    if (error && error.code !== POSTGRES_UNDEFINED_TABLE_ERROR) throw error;

    for (const row of Array.isArray(data) ? data : []) {
      const bookingRef = row?.booking_ref;
      if (!bookingRef) continue;
      if (!map.has(bookingRef)) map.set(bookingRef, []);
      map.get(bookingRef).push(mapAgreementSummaryRow(row));
    }
  } catch (err) {
    console.warn("[agreement-automation] summary map query skipped:", err?.message || err);
  }

  const missingRefs = refs.filter((ref) => !map.has(ref));
  if (missingRefs.length === 0) return map;

  try {
    const { data: legacyRows, error: legacyError } = await sb
      .from("pending_booking_docs")
      .select("booking_id, agreement_pdf_url")
      .in("booking_id", missingRefs);
    if (legacyError && legacyError.code !== POSTGRES_UNDEFINED_TABLE_ERROR) throw legacyError;
    for (const legacy of Array.isArray(legacyRows) ? legacyRows : []) {
      if (!legacy?.booking_id || !legacy?.agreement_pdf_url) continue;
      map.set(legacy.booking_id, [{
        id: null,
        version: 1,
        versionNumber: 1,
        status: "signed",
        signed_at: null,
        created_at: null,
        downloadAvailable: true,
        pdfStoragePath: legacy.agreement_pdf_url,
        source: "legacy",
      }]);
    }
  } catch {
    // best-effort
  }

  return map;
}
