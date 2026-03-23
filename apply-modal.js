// apply-modal.js
// Handles the "Apply Now" modal on index.html:
//   - Opens/closes the modal
//   - Validates the driver's license upload (type + size)
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
  const licenseInput = document.getElementById("applyLicense");
  const licenseInfo  = document.getElementById("applyLicenseInfo");

  let licenseFile = null;
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

  // ─── Phone OTP state ─────────────────────────────────────────────────────────
  let phoneOtpToken  = null;
  let phoneVerified  = false;
  let resendTimer    = null;

  // ─── Open / close ────────────────────────────────────────────────────────────

  function openModal() {
    overlay.style.display = "flex";
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    overlay.style.display = "none";
    document.body.style.overflow = "";
  }

  document.getElementById("applyNowBtn").addEventListener("click", openModal);
  closeBtn.addEventListener("click", closeModal);
  document.getElementById("applyBackBtn").addEventListener("click", closeModal);

  // Expose openModal globally so other scripts (e.g. chatbot) can trigger it.
  window.openApplyModal = openModal;

  // Close when clicking the dark backdrop
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeModal();
  });

  // Close on Escape key
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && overlay.style.display === "flex") closeModal();
  });

  // ─── License file validation ──────────────────────────────────────────────────

  licenseInput.addEventListener("change", function () {
    const file = this.files[0];
    licenseFile = null;
    licenseInfo.textContent = "";
    licenseInfo.style.color = "";

    if (!file) return;

    const allowed = ["image/jpeg", "image/png", "application/pdf"];
    if (!allowed.includes(file.type)) {
      licenseInfo.textContent = mt("applyModal.licenseTypeError", "Only JPG, PNG, or PDF files are accepted.");
      licenseInfo.style.color = "#f44336";
      this.value = "";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      licenseInfo.textContent = mt("applyModal.licenseSizeError", "File must be under 5\u00a0MB.");
      licenseInfo.style.color = "#f44336";
      this.value = "";
      return;
    }

    licenseFile = file;
    licenseInfo.textContent = "\u2713 " + file.name;
    licenseInfo.style.color = "#4caf50";
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
      const allowed = ["image/jpeg", "image/png", "application/pdf"];
      if (!allowed.includes(file.type)) {
        if (insFileInfo) { insFileInfo.textContent = mt("applyModal.insuranceTypeError", "Only JPG, PNG, or PDF files are accepted."); insFileInfo.style.color = "#f44336"; }
        this.value = "";
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        if (insFileInfo) { insFileInfo.textContent = mt("applyModal.insuranceSizeError", "File must be under 5\u00a0MB."); insFileInfo.style.color = "#f44336"; }
        this.value = "";
        return;
      }
      applyInsuranceFile = file;
      if (insFileInfo) { insFileInfo.textContent = "\u2713 " + file.name; insFileInfo.style.color = "#4caf50"; }
    });
  }

  // ─── Phone OTP wiring ────────────────────────────────────────────────────────

  var phoneInput          = document.getElementById("applyPhone");
  var sendPhoneOtpBtn     = document.getElementById("applySendPhoneOtpBtn");
  var phoneOtpGroup       = document.getElementById("applyPhoneOtpGroup");
  var phoneOtpInput       = document.getElementById("applyPhoneOtpInput");
  var resendPhoneOtpBtn   = document.getElementById("applyResendPhoneOtpBtn");
  var phoneVerifiedBadge  = document.getElementById("applyPhoneVerifiedBadge");

  function startResendCooldown() {
    resendPhoneOtpBtn.disabled = true;
    var secs = 30;
    resendPhoneOtpBtn.textContent = mfmt("applyModal.resendFmt", { secs: secs }, "Resend (" + secs + "s)");
    clearInterval(resendTimer);
    resendTimer = setInterval(function () {
      secs -= 1;
      if (secs <= 0) {
        clearInterval(resendTimer);
        resendPhoneOtpBtn.disabled = false;
        resendPhoneOtpBtn.textContent = mt("applyModal.resendBtn", "Resend");
      } else {
        resendPhoneOtpBtn.textContent = mfmt("applyModal.resendFmt", { secs: secs }, "Resend (" + secs + "s)");
      }
    }, 1000);
  }

  async function sendPhoneOtp() {
    var phone = phoneInput.value.trim();
    if (!phone) {
      statusEl.textContent = mt("applyModal.enterPhoneFirst", "Please enter your phone number first.");
      statusEl.className = "apply-status error";
      phoneInput.focus();
      return;
    }
    sendPhoneOtpBtn.disabled = true;
    sendPhoneOtpBtn.textContent = mt("applyModal.sendingCode", "Sending\u2026");
    statusEl.textContent = "";
    statusEl.className = "apply-status";

    try {
      var resp = await fetch(API_BASE + "/api/send-phone-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone }),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        statusEl.textContent = data.error || mt("applyModal.otpSentError", "Failed to send verification code. Please try again.");
        statusEl.className = "apply-status error";
        sendPhoneOtpBtn.disabled = false;
        sendPhoneOtpBtn.textContent = mt("applyModal.sendCode", "Send Code");
        return;
      }
      phoneOtpToken = data.token;
      phoneVerified = false;
      phoneOtpGroup.style.display = "block";
      phoneVerifiedBadge.style.display = "none";
      phoneOtpInput.value = "";
      phoneOtpInput.focus();
      sendPhoneOtpBtn.textContent = mt("applyModal.sentDone", "Sent \u2713");
      startResendCooldown();
      statusEl.textContent = mt("applyModal.codeSentPhone", "A 6-digit code was sent to your phone.");
      statusEl.className = "apply-status sending";
    } catch (err) {
      console.error("Send phone OTP error:", err);
      statusEl.textContent = mt("applyModal.networkError", "Network error. Please check your connection and try again.");
      statusEl.className = "apply-status error";
      sendPhoneOtpBtn.disabled = false;
      sendPhoneOtpBtn.textContent = mt("applyModal.sendCode", "Send Code");
    }
  }

  sendPhoneOtpBtn.addEventListener("click", sendPhoneOtp);

  resendPhoneOtpBtn.addEventListener("click", function () {
    sendPhoneOtpBtn.textContent = mt("applyModal.sendCode", "Send Code");
    sendPhoneOtpBtn.disabled = false;
    sendPhoneOtp();
  });

  // Mark phone as verified as soon as all 6 digits are entered
  phoneOtpInput.addEventListener("input", function () {
    var code = phoneOtpInput.value.trim();
    if (code.length === 6) {
      phoneVerified = true;
      phoneVerifiedBadge.style.display = "block";
      phoneOtpGroup.style.display = "none";
      statusEl.textContent = "";
      statusEl.className = "apply-status";
    } else {
      phoneVerified = false;
      phoneVerifiedBadge.style.display = "none";
    }
  });

  // Reset OTP state when the phone number is edited
  phoneInput.addEventListener("input", function () {
    phoneOtpToken = null;
    phoneVerified = false;
    phoneOtpGroup.style.display = "none";
    phoneVerifiedBadge.style.display = "none";
    phoneOtpInput.value = "";
    sendPhoneOtpBtn.disabled = false;
    sendPhoneOtpBtn.textContent = mt("applyModal.sendCode", "Send Code");
    clearInterval(resendTimer);
  });

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
    const apps       = Array.from(form.querySelectorAll('input[name="apps"]:checked')).map(function (cb) { return cb.value; });
    const agreeTerms      = document.getElementById("applyTerms").checked;
    const agreeSmsConsent = document.getElementById("applySmsConsent").checked;

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

    if (!licenseFile) {
      statusEl.textContent = mt("applyModal.uploadLicenseReq", "Please upload a copy of your driver\u2019s license.");
      statusEl.className = "apply-status error";
      return;
    }

    if (!phoneVerified || !phoneOtpToken) {
      statusEl.textContent = mt("applyModal.verifyPhoneFirst", "Please verify your phone number before submitting.");
      statusEl.className = "apply-status error";
      phoneInput.focus();
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = mt("applyModal.submitting", "Submitting your application\u2026");
    statusEl.className = "apply-status sending";

    try {
      // Encode license image as base64 for JSON transport
      const licenseBase64 = await new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () {
          // result is "data:<mime>;base64,<data>" — strip the prefix
          resolve(reader.result.split(",")[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(licenseFile);
      });

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

      const resp = await fetch(API_BASE + "/api/send-application-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone,
          email,
          age,
          experience,
          apps,
          agreeTerms,
          agreeSmsConsent,
          phoneOtpToken,
          phoneOtpCode: phoneOtpInput.value.trim(),
          licenseFileName: licenseFile.name,
          licenseMimeType: licenseFile.type,
          licenseBase64,
          hasInsurance,
          insuranceBase64,
          insuranceFileName: applyInsuranceFile ? applyInsuranceFile.name : null,
          insuranceMimeType: applyInsuranceFile ? applyInsuranceFile.type : null,
          protectionPlanPref,
        }),
      });

      const result = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        throw new Error(result.error || mt("applyModal.generalError", "Something went wrong. Please try again."));
      }

      // Read the pre-approval decision returned by the API.
      const decision = result.decision || "review";

      // Persist name, phone, approval decision, and protection preferences so
      // subsequent pages (cars.html, booking flow) can pre-populate the selections.
      // localStorage survives browser close/reopen.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, phone, decision, hasInsurance, protectionPlanPref }));
      } catch (_) { /* storage may be blocked in private mode */ }

      // Redirect to the thank-you page
      window.location.href = "thank-you.html?from=apply";

    } catch (err) {
      statusEl.textContent = err.message || mt("applyModal.generalError", "Something went wrong. Please try again.");
      statusEl.className = "apply-status error";
      submitBtn.disabled = false;
    }
  });

}());
