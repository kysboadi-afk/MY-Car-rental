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
      licenseInfo.textContent = "Only JPG, PNG, or PDF files are accepted.";
      licenseInfo.style.color = "#f44336";
      this.value = "";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      licenseInfo.textContent = "File must be under 5\u00a0MB.";
      licenseInfo.style.color = "#f44336";
      this.value = "";
      return;
    }

    licenseFile = file;
    licenseInfo.textContent = "\u2713 " + file.name;
    licenseInfo.style.color = "#4caf50";
  });

  // ─── Form submission ──────────────────────────────────────────────────────────

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "apply-status";

    const name       = document.getElementById("applyName").value.trim();
    const phone      = document.getElementById("applyPhone").value.trim();
    const age        = parseInt(document.getElementById("applyAge").value, 10);
    const experience = document.getElementById("applyExperience").value;
    const apps       = Array.from(form.querySelectorAll('input[name="apps"]:checked')).map(function (cb) { return cb.value; });
    const agreeTerms      = document.getElementById("applyTerms").checked;
    const agreeSmsConsent = document.getElementById("applySmsConsent").checked;

    if (isNaN(age) || age < 18 || age > 100) {
      statusEl.textContent = "Please enter a valid age.";
      statusEl.className = "apply-status error";
      return;
    }

    if (apps.length === 0) {
      statusEl.textContent = "Please select at least one delivery app.";
      statusEl.className = "apply-status error";
      return;
    }

    if (!agreeTerms) {
      statusEl.textContent = "You must agree to the Rental Terms & Conditions.";
      statusEl.className = "apply-status error";
      return;
    }

    if (!agreeSmsConsent) {
      statusEl.textContent = "You must agree to receive SMS booking notifications.";
      statusEl.className = "apply-status error";
      return;
    }

    if (!licenseFile) {
      statusEl.textContent = "Please upload a copy of your driver\u2019s license.";
      statusEl.className = "apply-status error";
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = "Submitting your application\u2026";
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

      const resp = await fetch(API_BASE + "/api/send-application-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone,
          age,
          experience,
          apps,
          agreeTerms,
          agreeSmsConsent,
          licenseFileName: licenseFile.name,
          licenseMimeType: licenseFile.type,
          licenseBase64,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(function () { return {}; });
        throw new Error(err.error || "Submission failed. Please try again.");
      }

      // Read the pre-approval decision returned by the API.
      const data = await resp.json().catch(function () { return {}; });
      const decision = data.decision || "review";

      // Persist name, phone & approval decision so that subsequent pages
      // (cars.html, booking flow) can gate access until the applicant is approved.
      // localStorage survives browser close/reopen.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, phone, decision }));
      } catch (_) { /* storage may be blocked in private mode */ }

      // Redirect to the thank-you page
      window.location.href = "thank-you.html?from=apply";

    } catch (err) {
      statusEl.textContent = err.message || "Something went wrong. Please try again.";
      statusEl.className = "apply-status error";
      submitBtn.disabled = false;
    }
  });


  // ─── Browse Cars nav gate ─────────────────────────────────────────────────
  // Intercept the "Browse Cars" nav link on index.html.  Only approved
  // applicants are allowed through.  Others see a toast or the apply modal.

  var browseLink = document.getElementById("browseCarsNavLink");
  if (browseLink) {
    browseLink.addEventListener("click", function (e) {
      var stored = null;
      try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (_) {}

      if (stored && stored.decision === "approved") return; // allow navigation

      e.preventDefault();

      if (!stored) {
        // No application submitted yet — open the apply modal
        openModal();
        return;
      }

      // Applied but not yet approved — show a non-intrusive toast message
      var existing = document.getElementById("browseGateToast");
      if (existing) existing.remove();

      var toast = document.createElement("div");
      toast.id = "browseGateToast";
      toast.className = "browse-gate-toast";
      toast.textContent = stored.decision === "review"
        ? "Your application is still under review. You\u2019ll receive an SMS once you\u2019re approved."
        : "Your application does not meet our rental requirements. Please call (213)\u00a0916-6606 for more information.";

      document.body.appendChild(toast);
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 5000);
    });
  }

}());
