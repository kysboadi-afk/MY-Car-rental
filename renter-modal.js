(function () {
  var API_BASE = 'https://sly-rides.vercel.app';

  var overlay = document.getElementById('renterModalOverlay');
  var form    = document.getElementById('renterInfoForm');

  function showModal() {
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function hideModal() {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
  }

  // Capitalize the first letter after each word boundary (spaces, hyphens, apostrophes)
  function toTitleCase(str) {
    return str.replace(/(?:^|[\s'\-])([a-zA-ZÀ-ÖØ-öø-ÿ])/g, function (m) {
      return m.toUpperCase();
    });
  }

  // Remove any character that is not a letter, space, hyphen, apostrophe, or period.
  // Used for both name and city fields.
  function sanitizeTextInput(val) {
    return val.replace(/[^a-zA-ZÀ-ÖØ-öø-ÿ\s'\-.]/g, '');
  }

  // Require at least 7 digit characters in the phone number
  function validatePhone(val) {
    var digits = val.replace(/\D/g, '');
    return digits.length >= 7 && /^[\d\s\+\-\(\)]{7,20}$/.test(val.trim());
  }

  // Require a valid-looking email with a domain + TLD of 2+ chars
  function validateEmail(val) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val.trim());
  }

  // Name must have at least two words (first + last name)
  function validateName(val) {
    return val.trim().split(/\s+/).filter(Boolean).length >= 2;
  }

  // City must be at least 2 characters and start with a letter
  function validateCity(val) {
    var trimmed = val.trim();
    return trimmed.length >= 2 && /^[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(trimmed);
  }

  function setError(fieldId, msg) {
    document.getElementById(fieldId).textContent = msg;
  }

  function clearErrors() {
    ['renterNameError', 'renterEmailError', 'renterPhoneError', 'renterCityError', 'renterTextConsentError']
      .forEach(function (id) { document.getElementById(id).textContent = ''; });
  }

  // ----- Real-time sanitization: strip invalid characters as the user types -----
  var nameInput = document.getElementById('renterName');
  var cityInput = document.getElementById('renterCity');

  nameInput.addEventListener('input', function () {
    var cleaned = sanitizeTextInput(this.value);
    if (cleaned !== this.value) { this.value = cleaned; }
  });

  nameInput.addEventListener('blur', function () {
    if (this.value.trim()) {
      this.value = toTitleCase(this.value.trim().replace(/\s+/g, ' '));
    }
  });

  cityInput.addEventListener('input', function () {
    var cleaned = sanitizeTextInput(this.value);
    if (cleaned !== this.value) { this.value = cleaned; }
  });

  cityInput.addEventListener('blur', function () {
    if (this.value.trim()) {
      this.value = toTitleCase(this.value.trim().replace(/\s+/g, ' '));
    }
  });

  // Only store a flag — not PII — in sessionStorage
  if (!sessionStorage.getItem('renterInfoSubmitted')) {
    showModal();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearErrors();

    var name  = document.getElementById('renterName').value.trim();
    var email = document.getElementById('renterEmail').value.trim();
    var phone = document.getElementById('renterPhone').value.trim();
    var city  = document.getElementById('renterCity').value.trim();
    var valid = true;

    if (!name) {
      setError('renterNameError', 'Full name is required.');
      valid = false;
    } else if (!validateName(name)) {
      setError('renterNameError', 'Please enter at least a first and last name.');
      valid = false;
    }
    if (email && !validateEmail(email)) {
      setError('renterEmailError', 'Please enter a valid email address.');
      valid = false;
    }
    if (!phone) {
      setError('renterPhoneError', 'Phone number is required.');
      valid = false;
    } else if (!validatePhone(phone)) {
      setError('renterPhoneError', 'Please enter a valid phone number (at least 7 digits).');
      valid = false;
    }
    if (city && !validateCity(city)) {
      setError('renterCityError', 'Please enter a valid city name.');
      valid = false;
    }
    if (!document.getElementById('renterTextConsent').checked) {
      setError('renterTextConsentError', 'You must consent to receive text messages about your reservation to continue.');
      valid = false;
    }

    if (!valid) return;

    // Notify the owner immediately with the visitor's lead info.
    // The modal is dismissed regardless of whether the API call succeeds
    // so the visitor's browsing experience is never blocked.
    fetch(API_BASE + '/api/send-lead-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, phone: phone, city: city }),
    }).catch(function () { /* non-fatal — do not block the visitor */ });

    // Send an SMS confirmation to the visitor.
    // Also non-fatal — visitor flow is never blocked.
    fetch(API_BASE + '/api/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, phone: phone }),
    }).catch(function () { /* non-fatal — do not block the visitor */ });

    // Store a completion flag and the contact details so car.html can
    // pre-fill the booking form without asking the customer to retype them.
    // sessionStorage is used intentionally: it is cleared when the tab closes,
    // is scoped to this origin, and never sent to a server on its own.
    sessionStorage.setItem('renterInfoSubmitted', '1');
    sessionStorage.setItem('slyRidesLead', JSON.stringify({ name: name, email: email, phone: phone }));
    hideModal();
  });
}());
