import crypto from "crypto";

const TEMPLATE_KEY_DEFAULT = "rental_standard";
const AGREEMENT_TYPE_DEFAULT = "rental_initial";
const POSTGRES_UNDEFINED_TABLE_ERROR = "42P01";
const DELIVERY_STATUS_DEFAULT = "pending";
const DELIVERY_STATUS_ALLOWED = new Set(["pending", "sent", "delivered", "failed", "skipped"]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeDeliveryStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return DELIVERY_STATUS_ALLOWED.has(normalized) ? normalized : DELIVERY_STATUS_DEFAULT;
}

function normalizeIsoDatetime(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function payloadToComparableString(value) {
  try {
    return JSON.stringify(value && typeof value === "object" ? value : {});
  } catch {
    return "{}";
  }
}

function sameAgreementState(existing, next) {
  if (!existing || !next) return false;
  return (
    normalizeText(existing.template_id) === normalizeText(next.template_id) &&
    normalizeText(existing.agreement_type) === normalizeText(next.agreement_type) &&
    normalizeText(existing.status) === normalizeText(next.status) &&
    payloadToComparableString(existing.payload_snapshot) === payloadToComparableString(next.payload_snapshot) &&
    normalizeText(existing.pdf_storage_path) === normalizeText(next.pdf_storage_path) &&
    normalizeText(existing.pdf_sha256) === normalizeText(next.pdf_sha256) &&
    normalizeText(existing.signed_at) === normalizeText(next.signed_at) &&
    normalizeText(existing.owner_delivery_status) === normalizeText(next.owner_delivery_status) &&
    normalizeText(existing.renter_delivery_status) === normalizeText(next.renter_delivery_status) &&
    normalizeText(existing.sent_at) === normalizeText(next.sent_at) &&
    normalizeText(existing.delivered_at) === normalizeText(next.delivered_at)
  );
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
      .select("id, booking_ref, version_number, status, signed_at, created_at, pdf_storage_path, template_id, agreement_type, payload_snapshot, pdf_sha256, owner_delivery_status, renter_delivery_status, sent_at, delivered_at")
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
  ownerDeliveryStatus = DELIVERY_STATUS_DEFAULT,
  renterDeliveryStatus = DELIVERY_STATUS_DEFAULT,
  sentAt = null,
  deliveredAt = null,
  createdBy = "system",
}) {
  if (!sb || !bookingRef) return null;
  try {
    const templateId = await resolveActiveTemplateId(sb, templateKey);
    const latest = await loadLatestAgreement(sb, bookingRef);
    const updatedAt = nowIso();
    const pdfSha = computePdfSha256(pdfBuffer);
    const nextStatus = latest?.status === "signed" && status !== "voided" ? "signed" : status;

    const normalizedOwnerDeliveryStatus = normalizeDeliveryStatus(ownerDeliveryStatus);
    const normalizedRenterDeliveryStatus = normalizeDeliveryStatus(renterDeliveryStatus);
    const normalizedSentAt = normalizeIsoDatetime(sentAt);
    const normalizedDeliveredAt = normalizeIsoDatetime(deliveredAt);

    const basePayload = {
      template_id: templateId || latest?.template_id || null,
      agreement_type: agreementType,
      status: nextStatus,
      payload_snapshot: payloadSnapshot && typeof payloadSnapshot === "object" ? payloadSnapshot : {},
      updated_at: updatedAt,
      pdf_storage_path: pdfStoragePath || null,
      pdf_sha256: pdfSha || null,
      signed_at: nextStatus === "signed" ? (signedAt || updatedAt) : signedAt,
      owner_delivery_status: normalizedOwnerDeliveryStatus,
      renter_delivery_status: normalizedRenterDeliveryStatus,
      sent_at: normalizedSentAt,
      delivered_at: normalizedDeliveredAt,
    };

    if (latest?.id && sameAgreementState(latest, basePayload)) {
      return {
        id: latest.id,
        booking_ref: latest.booking_ref,
        version_number: latest.version_number,
        status: latest.status,
        signed_at: latest.signed_at,
        created_at: latest.created_at,
        pdf_storage_path: latest.pdf_storage_path,
      };
    }

    const insertPayload = {
      booking_ref: bookingRef,
      version_number: Number(latest?.version_number || 0) + 1,
      created_at: updatedAt,
      ...basePayload,
    };

    const { data, error } = await sb
      .from("booking_agreements")
      .insert(insertPayload)
      .select("id, booking_ref, version_number, status, signed_at, created_at, pdf_storage_path, owner_delivery_status, renter_delivery_status, sent_at, delivered_at")
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

    let signatureAgreementId = agreement.id;
    if (transitionAgreementToSigned) {
      const signedVersion = await upsertBookingAgreement({
        sb,
        bookingRef,
        templateKey,
        agreementType,
        status: "signed",
        payloadSnapshot,
        signedAt: signatureTimestamp,
        ownerDeliveryStatus: agreement.owner_delivery_status || DELIVERY_STATUS_DEFAULT,
        renterDeliveryStatus: agreement.renter_delivery_status || DELIVERY_STATUS_DEFAULT,
        sentAt: agreement.sent_at || null,
        deliveredAt: agreement.delivered_at || null,
        createdBy,
      });
      if (signedVersion?.id) signatureAgreementId = signedVersion.id;
    }

    const signaturePayload = {
      agreement_id: signatureAgreementId,
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
    owner_delivery_status: row?.owner_delivery_status || DELIVERY_STATUS_DEFAULT,
    renter_delivery_status: row?.renter_delivery_status || DELIVERY_STATUS_DEFAULT,
    sent_at: row?.sent_at || null,
    delivered_at: row?.delivered_at || null,
  };
}

export async function loadBookingAgreementSummary(sb, bookingRef) {
  if (!sb || !bookingRef) {
    return { currentAgreement: null, agreements: [] };
  }
  try {
    const { data, error } = await sb
      .from("booking_agreements")
      .select("id, booking_ref, version_number, status, signed_at, created_at, pdf_storage_path, owner_delivery_status, renter_delivery_status, sent_at, delivered_at")
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

export async function markBookingAgreementDelivery({
  sb,
  bookingRef,
  ownerDeliveryStatus = null,
  renterDeliveryStatus = null,
  sentAt = null,
  deliveredAt = null,
  createdBy = "system",
}) {
  if (!sb || !bookingRef) return null;
  const latest = await loadLatestAgreement(sb, bookingRef);
  if (!latest?.id) return null;

  const nextOwnerStatus = ownerDeliveryStatus
    ? normalizeDeliveryStatus(ownerDeliveryStatus)
    : normalizeDeliveryStatus(latest.owner_delivery_status || DELIVERY_STATUS_DEFAULT);
  const nextRenterStatus = renterDeliveryStatus
    ? normalizeDeliveryStatus(renterDeliveryStatus)
    : normalizeDeliveryStatus(latest.renter_delivery_status || DELIVERY_STATUS_DEFAULT);
  const autoSentAt =
    sentAt ||
    latest.sent_at ||
    ((nextOwnerStatus === "sent" || nextOwnerStatus === "delivered" || nextRenterStatus === "sent" || nextRenterStatus === "delivered")
      ? nowIso()
      : null);
  const autoDeliveredAt =
    deliveredAt ||
    latest.delivered_at ||
    ((nextOwnerStatus === "delivered" || nextRenterStatus === "delivered")
      ? nowIso()
      : null);

  return upsertBookingAgreement({
    sb,
    bookingRef,
    templateKey: TEMPLATE_KEY_DEFAULT,
    agreementType: latest.agreement_type || AGREEMENT_TYPE_DEFAULT,
    status: latest.status || "issued",
    payloadSnapshot: latest.payload_snapshot || {},
    pdfStoragePath: latest.pdf_storage_path || null,
    signedAt: latest.signed_at || null,
    ownerDeliveryStatus: nextOwnerStatus,
    renterDeliveryStatus: nextRenterStatus,
    sentAt: autoSentAt,
    deliveredAt: autoDeliveredAt,
    createdBy,
  });
}

export async function loadAgreementSummaryMap(sb, bookingRefs = []) {
  const map = new Map();
  if (!sb || !Array.isArray(bookingRefs) || bookingRefs.length === 0) return map;
  const refs = Array.from(new Set(bookingRefs.filter(Boolean)));
  if (refs.length === 0) return map;

  try {
    const { data, error } = await sb
      .from("booking_agreements")
      .select("id, booking_ref, version_number, status, signed_at, created_at, pdf_storage_path, owner_delivery_status, renter_delivery_status, sent_at, delivered_at")
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
