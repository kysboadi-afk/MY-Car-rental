// apply-modal.js
// Handles the "Apply Now" modal on index.html:
//   - Opens/closes the modal
//   - Submits the application to the Vercel API
//   - Stores applicant name & phone in localStorage so car.html can pre-fill them
//   - Redirects to thank-you.html?from=apply on success
(function () {
  "use strict";

  const API_BASE   = "https://sly-rides.vercel.app";
  const STORAGE_KEY = "slyApplicant";

  const overlay    = document.getElementById("applyModal");
  const closeBtn   = document.getElementById("applyModalClose");
  const form       = document.getElementById("applyForm");
  const submitBtn  = document.getElementById("applySubmitBtn");
  const statusEl   = document.getElementById("applyStatus");
  const termsCheckbox = document.getElementById("applyTerms");
  const smsConsentCheckbox = document.getElementById("applySmsConsent");
  const backgroundCheckCheckbox = document.getElementById("applyBackgroundCheck");

  let applyInsuranceFile = null;

  // i18n helper
  function mt(key, fallback) {
    return (window.slyI18n && window.slyI18n.t) ? window.slyI18n.t(key) : (fallback || key);
  }

  // Format helper with {placeholder} replacement
  function mfmt(key, vars, fallback) {
    var s = mt(key, fallback || key);
    if (vars) {
      Object.keys(vars).forEach(function(k) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
      });
    }
    return s;
  }

  // ─── Open / close ────────────────────────────────────────────────────────────

  function openModal() {
    overlay.style.display = "flex";
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    overlay.style.display = "none";
    document.body.style.overflow = "";
  }

  function allRequiredConsentsChecked() {
    return !!(termsCheckbox && termsCheckbox.checked)
      && !!(smsConsentCheckbox && smsConsentCheckbox.checked)
      && !!(backgroundCheckCheckbox && backgroundCheckCheckbox.checked);
  }

  function syncSubmitEnabledState() {
    submitBtn.disabled = !allRequiredConsentsChecked();
  }

  document.getElementById("applyNowBtn").addEventListener("click", openModal);
  closeBtn.addEventListener("click", closeModal);
  document.getElementById("applyBackBtn").addEventListener("click", closeModal);

  // Expose openModal globally so other scripts (e.g. chatbot) can trigger it.
  window.openApplyModal = openModal;

  if (termsCheckbox) termsCheckbox.addEventListener("change", syncSubmitEnabledState);
  if (smsConsentCheckbox) smsConsentCheckbox.addEventListener("change", syncSubmitEnabledState);
  if (backgroundCheckCheckbox) backgroundCheckCheckbox.addEventListener("change", syncSubmitEnabledState);
  syncSubmitEnabledState();

  // Close when clicking the dark backdrop
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeModal();
  });

  // Close on Escape key
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && overlay.style.display === "flex") closeModal();
  });

  // ─── Insurance & Protection Plan wiring ──────────────────────────────────────

  var insYesRadio     = document.getElementById("applyHasInsuranceYes");
  var insNoRadio      = document.getElementById("applyHasInsuranceNo");
  var insProofField   = document.getElementById("applyInsuranceProofField");
  var insUploadInput  = document.getElementById("applyInsuranceUpload");
  var insFileInfo     = document.getElementById("applyInsuranceFileInfo");
  var insNoneOption   = document.getElementById("applyProtectionNoneOption");
  var insNoneRadio    = document.getElementById("applyProtectionNone");
  var insStdRadio     = document.getElementById("applyProtectionStandard");

  function onInsuranceChange() {
    var hasIns = insYesRadio && insYesRadio.checked;
    // Show/hide proof of insurance upload
    if (insProofField) insProofField.style.display = hasIns ? "" : "none";
    if (!hasIns) {
      // When "No insurance" is selected, disable Decline option and reset to Standard if needed
      if (insNoneOption) insNoneOption.style.opacity = "0.4";
      if (insNoneOption) insNoneOption.title = "A protection plan is required when you have no insurance.";
      if (insNoneRadio && insNoneRadio.checked && insStdRadio) {
        insStdRadio.checked = true;
      }
    } else {
      if (insNoneOption) insNoneOption.style.opacity = "";
      if (insNoneOption) insNoneOption.title = "";
    }
  }

  if (insYesRadio) insYesRadio.addEventListener("change", onInsuranceChange);
  if (insNoRadio)  insNoRadio.addEventListener("change", onInsuranceChange);

  // Prevent selecting Decline when No insurance is chosen
  if (insNoneRadio) {
    insNoneRadio.addEventListener("change", function() {
      if (insNoRadio && insNoRadio.checked) {
        if (insStdRadio) insStdRadio.checked = true;
        statusEl.textContent = mt("applyModal.declineNotAllowed", "A protection plan is required when you have no personal auto insurance.");
        statusEl.className = "apply-status error";
      }
    });
  }

  // Insurance proof file validation
  if (insUploadInput) {
    insUploadInput.addEventListener("change", function() {
      const file = this.files[0];
      applyInsuranceFile = null;
      if (insFileInfo) { insFileInfo.textContent = ""; insFileInfo.style.color = ""; }

      if (!file) return;
      const allowedExts = /\.(jpe?g|jpg|png|pdf|heic|heif|webp|bmp|gif|tiff?|avif)$/i;
      const validInsType = file.type.startsWith('image/') || file.type === 'application/pdf'
        || (file.type === '' && allowedExts.test(file.name));
      if (!validInsType) {
        if (insFileInfo) { insFileInfo.textContent = mt("applyModal.insuranceTypeError", "Please upload a photo or image of your insurance card (JPG, PNG, HEIC, WebP, etc.) or a PDF."); insFileInfo.style.color = "#f44336"; }
        this.value = "";
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        if (insFileInfo) { insFileInfo.textContent = mt("applyModal.insuranceSizeError", "File is too large. Please upload an image under 8 MB."); insFileInfo.style.color = "#f44336"; }
        this.value = "";
        return;
      }
      applyInsuranceFile = file;
      if (insFileInfo) { insFileInfo.textContent = "\u2713 " + file.name; insFileInfo.style.color = "#4caf50"; }
    });
  }

  // ─── Form submission ──────────────────────────────────────────────────────────

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "apply-status";

    const name       = document.getElementById("applyName").value.trim();
    const phone      = document.getElementById("applyPhone").value.trim();
    const email      = document.getElementById("applyEmail").value.trim();
    const age        = parseInt(document.getElementById("applyAge").value, 10);
    const experience = document.getElementById("applyExperience").value;
    const driverLicenseNumber = document.getElementById("applyDriverLicenseNumber").value.trim();
    const driverLicenseState = document.getElementById("applyDriverLicenseState").value.trim().toUpperCase();
    const zipcode = document.getElementById("applyZipcode").value.trim();
    const apps       = Array.from(form.querySelectorAll('input[name="apps"]:checked')).map(function (cb) { return cb.value; });
    const agreeTerms      = document.getElementById("applyTerms").checked;
    const agreeSmsConsent = document.getElementById("applySmsConsent").checked;
    const agreeBackgroundCheck = document.getElementById("applyBackgroundCheck").checked;

    // Insurance & protection plan
    const insChecked  = form.querySelector('input[name="applyInsuranceCoverage"]:checked');
    const hasInsurance = insChecked ? insChecked.value : null;
    const planChecked  = form.querySelector('input[name="applyProtectionPlan"]:checked');
    const protectionPlanPref = planChecked ? planChecked.value : "standard";

    if (isNaN(age) || age < 18 || age > 100) {
      statusEl.textContent = mt("applyModal.invalidAge", "Please enter a valid age.");
      statusEl.className = "apply-status error";
      return;
    }

    if (apps.length === 0) {
      statusEl.textContent = mt("applyModal.selectApp", "Please select at least one delivery app.");
      statusEl.className = "apply-status error";
      return;
    }

    if (!driverLicenseNumber || !/^[A-Z0-9-]{4,64}$/i.test(driverLicenseNumber)) {
      statusEl.textContent = "Please enter a valid driver license number.";
      statusEl.className = "apply-status error";
      return;
    }

    if (!/^[A-Z]{2}$/.test(driverLicenseState)) {
      statusEl.textContent = "Please enter a valid 2-letter driver license state.";
      statusEl.className = "apply-status error";
      return;
    }

    if (zipcode && !/^\d{5}(?:-\d{4})?$/.test(zipcode)) {
      statusEl.textContent = "Please enter a valid ZIP code.";
      statusEl.className = "apply-status error";
      return;
    }

    if (!hasInsurance) {
      statusEl.textContent = mt("applyModal.insuranceRequired", "Please answer the insurance question.");
      statusEl.className = "apply-status error";
      return;
    }

    if (hasInsurance === "yes" && !applyInsuranceFile) {
      statusEl.textContent = mt("applyModal.uploadInsuranceReq", "Please upload your proof of insurance.");
      statusEl.className = "apply-status error";
      return;
    }

    if (hasInsurance === "no" && protectionPlanPref === "none") {
      statusEl.textContent = mt("applyModal.declineNotAllowed", "A protection plan is required when you have no personal auto insurance.");
      statusEl.className = "apply-status error";
      return;
    }

    if (!agreeTerms) {
      statusEl.textContent = mt("applyModal.agreeTermsRequired", "You must agree to the Rental Terms & Conditions.");
      statusEl.className = "apply-status error";
      return;
    }

    if (!agreeSmsConsent) {
      statusEl.textContent = mt("applyModal.agreeSmsRequired", "You must agree to receive SMS booking notifications.");
      statusEl.className = "apply-status error";
      return;
    }

    if (!agreeBackgroundCheck) {
      statusEl.textContent = "You must authorize the background check disclosure.";
      statusEl.className = "apply-status error";
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = mt("applyModal.submitting", "Submitting your application\u2026");
    statusEl.className = "apply-status sending";

    try {
      let applicationId = null;
      try {
        console.info("[apply] submitting create-renter-application request");
        const createResp = await fetch(API_BASE + "/api/create-renter-application", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            phone,
            email,
            age,
            experience,
            agreeBackgroundCheck,
            driverLicenseNumber,
            driverLicenseState,
            zipcode,
            apps,
            agreeTerms,
            agreeSmsConsent,
            hasInsurance,
            protectionPlanPref,
            insuranceFileName: applyInsuranceFile ? applyInsuranceFile.name : null,
            insuranceMimeType: applyInsuranceFile ? applyInsuranceFile.type : null,
          }),
        });
        const createResult = await createResp.json().catch(function () { return {}; });
        console.info("[apply] create-renter-application response", {
          ok: createResp.ok,
          status: createResp.status,
          applicationId: createResult.applicationId || null,
          error: createResult.error || null,
        });
        if (createResp.ok && createResult.applicationId) {
          applicationId = createResult.applicationId;
        }
      } catch (_) {
        // Backward-compatible fallback: continue with legacy apply email endpoint
      }

      // Encode insurance proof if provided
      let insuranceBase64 = null;
      if (applyInsuranceFile) {
        insuranceBase64 = await new Promise(function (resolve, reject) {
          const reader = new FileReader();
          reader.onload = function () { resolve(reader.result.split(",")[1]); };
          reader.onerror = reject;
          reader.readAsDataURL(applyInsuranceFile);
        });
      }

      console.info("[apply] submitting send-application-email request", {
        hasApplicationId: !!applicationId,
      });
      const resp = await fetch(API_BASE + "/api/send-application-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicationId,
          name,
          phone,
          email,
          age,
          experience,
          agreeBackgroundCheck,
          driverLicenseNumber,
          driverLicenseState,
          zipcode,
          apps,
          agreeTerms,
          agreeSmsConsent,
          hasInsurance,
          insuranceBase64,
          insuranceFileName: applyInsuranceFile ? applyInsuranceFile.name : null,
          insuranceMimeType: applyInsuranceFile ? applyInsuranceFile.type : null,
          protectionPlanPref,
        }),
      });

      const result = await resp.json().catch(function () { return {}; });
      console.info("[apply] send-application-email response", {
        ok: resp.ok,
        status: resp.status,
        applicationId: result.applicationId || applicationId || null,
        applicationStatus: result.applicationStatus || null,
        identityStatus: result.identityStatus || null,
        error: result.error || null,
      });
      if (!resp.ok) {
        var errMsg = result.error || mt("applyModal.generalError", "Something went wrong. Please try again.");
        throw new Error(errMsg);
      }

      const resolvedApplicationId = result.applicationId || applicationId || null;

      // Persist name, phone, lifecycle state, and protection preferences so
      // subsequent pages (cars.html, booking flow) can pre-populate the selections.
      // localStorage survives browser close/reopen.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          applicationId: resolvedApplicationId,
          name,
          phone,
          email,
          agreeBackgroundCheck,
          decision: result.decision || null,
          precheckDecision: result.precheckDecision || result.decision || null,
          applicationStatus: result.applicationStatus || "submitted",
          identityStatus: result.identityStatus || "not_started",
          driverLicenseNumber,
          driverLicenseState,
          zipcode,
          hasInsurance,
          protectionPlanPref,
        }));
      } catch (_) { /* storage may be blocked in private mode */ }

      // Redirect to the thank-you page
      window.location.href = "thank-you.html?from=apply" + (resolvedApplicationId ? "&applicationId=" + encodeURIComponent(resolvedApplicationId) : "");

    } catch (err) {
      statusEl.textContent = err.message || mt("applyModal.generalError", "Something went wrong. Please try again.");
      statusEl.className = "apply-status error";
      submitBtn.disabled = false;
    }
  });

}());
