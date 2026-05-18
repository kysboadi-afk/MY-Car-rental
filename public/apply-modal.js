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

  function hasReadyIncomeFile() {
    return incomeFileEntries.some(function(e) {
      return e.state === 'ready' || e.state === 'uploaded';
    });
  }

  function allRequiredConsentsChecked() {
    return !!(termsCheckbox && termsCheckbox.checked)
      && !!(smsConsentCheckbox && smsConsentCheckbox.checked)
      && !!(backgroundCheckCheckbox && backgroundCheckCheckbox.checked);
  }

  function syncSubmitEnabledState() {
    submitBtn.disabled = !allRequiredConsentsChecked() || !hasReadyIncomeFile();
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

  // ─── Income Verification Upload ───────────────────────────────────────────────

  var incomeUploadInput  = document.getElementById("applyIncomeUpload");
  var incomeFileListEl   = document.getElementById("applyIncomeFileList");
  var incomeStatusEl     = document.getElementById("applyIncomeStatus");

  // Each entry: { id, file, state, label, base64, mimeType, compressedSize }
  var incomeFileEntries = [];
  var INCOME_MAX_FILES  = 5;
  var INCOME_MAX_BYTES  = 15 * 1024 * 1024; // 15 MB
  // Compress images larger than this threshold
  var INCOME_COMPRESS_THRESHOLD = 3 * 1024 * 1024; // 3 MB
  var INCOME_MAX_DIMENSION = 2048; // px
  var incomeFileIdSeq = 0;

  var INCOME_ALLOWED_EXTS = /\.(jpe?g|jpg|png|webp|heic|heif|pdf)$/i;

  /** Escape a string for safe insertion into an HTML attribute or text node. */
  // eslint-disable-next-line no-unused-vars -- reserved for future HTML interpolation
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtBytes(bytes) {
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function isImageMime(mime) {
    return typeof mime === 'string' && mime.startsWith('image/');
  }

  function isCompressibleImage(mime) {
    // Can compress JPEG, PNG, WEBP via Canvas; not HEIC/HEIF (no Canvas support in non-Safari)
    return isImageMime(mime) && !mime.includes('heic') && !mime.includes('heif');
  }

  /**
   * Compress an image File using Canvas. Returns a Blob of the compressed image.
   * Falls back to the original Blob if Canvas is unavailable.
   */
  function compressImageFile(file, onProgress) {
    return new Promise(function(resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function() {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (w <= INCOME_MAX_DIMENSION && h <= INCOME_MAX_DIMENSION && file.size <= INCOME_COMPRESS_THRESHOLD) {
          // No resize needed — still encode as JPEG to normalise EXIF/format
          resolve(file.slice(0));
          return;
        }
        // Scale down proportionally
        var scale = Math.min(1, INCOME_MAX_DIMENSION / Math.max(w, h));
        var tw = Math.round(w * scale), th = Math.round(h * scale);
        if (onProgress) onProgress('compressing');
        var canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, tw, th);
        canvas.toBlob(function(blob) {
          resolve(blob || file.slice(0));
        }, 'image/jpeg', 0.82);
      };
      img.onerror = function() {
        URL.revokeObjectURL(url);
        resolve(file.slice(0)); // Can't decode, upload original
      };
      img.src = url;
    });
  }

  function renderIncomeFileList() {
    if (!incomeFileListEl) return;
    // Clear previous content
    while (incomeFileListEl.firstChild) {
      incomeFileListEl.removeChild(incomeFileListEl.firstChild);
    }
    if (!incomeFileEntries.length) { syncSubmitEnabledState(); return; }

    incomeFileEntries.forEach(function(entry) {
      var stateClass = '';
      var icon = '📄';
      var stateSuffix = '';
      if (entry.state === 'compressing') { stateClass = 'compressing'; icon = '⏳'; stateSuffix = ' — Compressing…'; }
      else if (entry.state === 'ready')  { stateClass = 'ready'; icon = '✅'; stateSuffix = entry.compressedSize ? ' — Compressed (' + fmtBytes(entry.compressedSize) + ')' : ''; }
      else if (entry.state === 'error')  { stateClass = 'error'; icon = '❌'; stateSuffix = ' — ' + (entry.errorMsg || 'Error'); }
      else if (entry.state === 'uploading') { stateClass = 'uploading'; icon = '⬆️'; stateSuffix = ' — Uploading…'; }
      else if (entry.state === 'uploaded')  { stateClass = 'uploaded'; icon = '✅'; stateSuffix = ' — Uploaded ✓'; }

      var item = document.createElement('div');
      item.className = 'apply-income-file-item ' + stateClass;
      item.id = 'income-item-' + entry.id;

      var iconSpan = document.createElement('span');
      iconSpan.textContent = icon;
      item.appendChild(iconSpan);

      var nameSpan = document.createElement('span');
      nameSpan.className = 'apply-income-file-name';
      nameSpan.title = entry.label;
      nameSpan.textContent = entry.label;
      item.appendChild(nameSpan);

      var sizeSpan = document.createElement('span');
      sizeSpan.className = 'apply-income-file-size';
      sizeSpan.textContent = fmtBytes(entry.file.size) + stateSuffix;
      item.appendChild(sizeSpan);

      if (entry.state !== 'uploading' && entry.state !== 'uploaded') {
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'apply-income-remove-btn';
        removeBtn.setAttribute('aria-label', 'Remove file');
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', (function(id) {
          return function() {
            incomeFileEntries = incomeFileEntries.filter(function(e) { return e.id !== id; });
            renderIncomeFileList();
            updateIncomeStatus();
            if (incomeUploadInput && incomeFileEntries.length < INCOME_MAX_FILES) {
              incomeUploadInput.disabled = false;
              var lbl = document.getElementById('applyIncomeUploadLabel');
              if (lbl) lbl.style.opacity = '';
            }
            syncSubmitEnabledState();
          };
        }(entry.id)));
        item.appendChild(removeBtn);
      }

      incomeFileListEl.appendChild(item);
    });

    syncSubmitEnabledState();
  }

  function updateIncomeStatus() {
    if (!incomeStatusEl) return;
    var count = incomeFileEntries.length;
    if (count === 0) { incomeStatusEl.textContent = ''; syncSubmitEnabledState(); return; }
    var readyCount = incomeFileEntries.filter(function(e) { return e.state === 'ready'; }).length;
    var errorCount = incomeFileEntries.filter(function(e) { return e.state === 'error'; }).length;
    var msg = count + ' file' + (count > 1 ? 's' : '') + ' selected';
    if (errorCount) msg += ', ' + errorCount + ' could not be processed';
    incomeStatusEl.textContent = msg;
    syncSubmitEnabledState();
  }

  /**
   * Process a newly added file: validate → optionally compress → store as base64.
   */
  function processIncomeFile(file, entry) {
    // Validate type
    var mime = file.type || '';
    var validType = mime.startsWith('image/') || mime === 'application/pdf'
      || (mime === '' && INCOME_ALLOWED_EXTS.test(file.name));
    if (!validType) {
      entry.state = 'error';
      entry.errorMsg = 'Unsupported file type';
      renderIncomeFileList();
      updateIncomeStatus();
      return;
    }

    // Validate size BEFORE compression (reject obviously huge files)
    if (file.size > INCOME_MAX_BYTES) {
      entry.state = 'error';
      entry.errorMsg = 'File too large (max 15 MB)';
      renderIncomeFileList();
      updateIncomeStatus();
      return;
    }

    var shouldCompress = isCompressibleImage(mime) && file.size > INCOME_COMPRESS_THRESHOLD;

    function storeAsBase64(blob) {
      var reader = new FileReader();
      reader.onload = function() {
        var dataUrl = reader.result;
        entry.base64 = dataUrl.split(',')[1] || dataUrl;
        entry.mimeType = shouldCompress ? 'image/jpeg' : (mime || 'application/octet-stream');
        entry.compressedSize = blob.size;
        entry.state = 'ready';
        renderIncomeFileList();
        updateIncomeStatus();
      };
      reader.onerror = function() {
        entry.state = 'error';
        entry.errorMsg = 'Could not read file';
        renderIncomeFileList();
        updateIncomeStatus();
      };
      reader.readAsDataURL(blob);
    }

    if (shouldCompress) {
      entry.state = 'compressing';
      renderIncomeFileList();
      if (incomeStatusEl) incomeStatusEl.textContent = 'Image too large, compressing…';
      compressImageFile(file, null).then(function(blob) {
        if (blob.size > INCOME_MAX_BYTES) {
          entry.state = 'error';
          entry.errorMsg = 'File still too large after compression';
          renderIncomeFileList();
          updateIncomeStatus();
          return;
        }
        storeAsBase64(blob);
      });
    } else {
      storeAsBase64(file);
    }
  }

  if (incomeUploadInput) {
    incomeUploadInput.addEventListener("change", function() {
      var files = Array.from(this.files || []);
      this.value = ''; // reset so same file can be re-added after removal

      var remaining = INCOME_MAX_FILES - incomeFileEntries.length;
      if (remaining <= 0) {
        if (incomeStatusEl) incomeStatusEl.textContent = 'Maximum ' + INCOME_MAX_FILES + ' files already selected.';
        return;
      }

      var toAdd = files.slice(0, remaining);
      if (files.length > remaining && incomeStatusEl) {
        incomeStatusEl.textContent = 'Only ' + remaining + ' more file' + (remaining > 1 ? 's' : '') + ' can be added.';
      }

      toAdd.forEach(function(file) {
        incomeFileIdSeq++;
        var entry = {
          id: incomeFileIdSeq,
          file: file,
          label: file.name,
          state: 'pending',
          base64: null,
          mimeType: null,
          compressedSize: null,
          errorMsg: null,
        };
        incomeFileEntries.push(entry);
        processIncomeFile(file, entry);
      });

      renderIncomeFileList();
      updateIncomeStatus();

      // Disable picker if we've hit the max
      if (incomeFileEntries.length >= INCOME_MAX_FILES) {
        incomeUploadInput.disabled = true;
        var label = document.getElementById('applyIncomeUploadLabel');
        if (label) label.style.opacity = '0.4';
      }
    });
  }

  /**
   * Upload all ready income verification files one-by-one after applicationId is known.
   * Does NOT throw — returns summary of successes and failures.
   */
  async function uploadIncomeFiles(applicationId) {
    var readyEntries = incomeFileEntries.filter(function(e) { return e.state === 'ready' && e.base64; });
    if (!readyEntries.length) return { uploaded: 0, failed: 0 };

    if (incomeStatusEl) incomeStatusEl.textContent = 'Uploading income documents…';

    var uploaded = 0, failed = 0;
    for (var i = 0; i < readyEntries.length; i++) {
      var entry = readyEntries[i];
      entry.state = 'uploading';
      renderIncomeFileList();
      if (incomeStatusEl) {
        incomeStatusEl.textContent = 'Uploading ' + (i + 1) + ' of ' + readyEntries.length + '…';
      }

      try {
        var resp = await fetch(API_BASE + '/api/upload-income-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            applicationId: applicationId,
            fileData: entry.base64,
            mimeType: entry.mimeType,
            fileName: entry.label,
          }),
        });
        var result = await resp.json().catch(function() { return {}; });
        if (resp.ok && result.success) {
          entry.state = 'uploaded';
          uploaded++;
        } else {
          entry.state = 'error';
          entry.errorMsg = result.error || 'Upload failed';
          failed++;
          console.warn('[apply] income doc upload failed:', result.error || resp.status);
        }
      } catch (uploadErr) {
        entry.state = 'error';
        entry.errorMsg = 'Upload failed, please try again';
        failed++;
        console.warn('[apply] income doc upload threw:', uploadErr);
      }
      renderIncomeFileList();
    }

    if (incomeStatusEl) {
      if (failed === 0) {
        incomeStatusEl.textContent = uploaded + ' document' + (uploaded > 1 ? 's' : '') + ' uploaded successfully.';
      } else if (uploaded > 0) {
        incomeStatusEl.textContent = uploaded + ' uploaded, ' + failed + ' failed — you can retry after submission.';
      } else {
        incomeStatusEl.textContent = 'Upload failed. Your application was saved — please try uploading again.';
      }
    }
    return { uploaded: uploaded, failed: failed };
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

    if (!hasReadyIncomeFile()) {
      statusEl.textContent = "Please upload at least one proof of rideshare income (screenshot or PDF).";
      statusEl.className = "apply-status error";
      if (incomeStatusEl) incomeStatusEl.textContent = "At least one income document is required.";
      document.getElementById("applyIncomeUploadLabel")?.scrollIntoView({ behavior: "smooth", block: "center" });
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

      // Upload income verification documents (non-blocking — won't prevent redirect on failure)
      if (resolvedApplicationId && incomeFileEntries.some(function(e) { return e.state === 'ready'; })) {
        statusEl.textContent = "Uploading income documents\u2026";
        try {
          await uploadIncomeFiles(resolvedApplicationId);
        } catch (_) {
          // Non-fatal — application already saved
        }
      }

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
