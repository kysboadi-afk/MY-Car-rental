(function () {
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

  // Require at least 7 digit characters in the phone number
  function validatePhone(val) {
    var digits = val.replace(/\D/g, '');
    return digits.length >= 7 && /^[\d\s\+\-\(\)]{7,20}$/.test(val.trim());
  }

  // Require a valid-looking email with a domain + TLD of 2+ chars
  function validateEmail(val) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val.trim());
  }

  function setError(fieldId, msg) {
    document.getElementById(fieldId).textContent = msg;
  }

  function clearErrors() {
    ['renterNameError', 'renterEmailError', 'renterPhoneError', 'renterCityError']
      .forEach(function (id) { document.getElementById(id).textContent = ''; });
  }

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
    }
    if (!email) {
      setError('renterEmailError', 'Email address is required.');
      valid = false;
    } else if (!validateEmail(email)) {
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
    if (!city) {
      setError('renterCityError', 'City is required.');
      valid = false;
    }

    if (!valid) return;

    // Notify the owner immediately with the visitor's lead info.
    // The modal is dismissed regardless of whether the API call succeeds
    // so the visitor's browsing experience is never blocked.
    fetch('https://sly-rides.vercel.app/api/send-lead-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, phone: phone, city: city }),
    }).catch(function () { /* non-fatal — do not block the visitor */ });

    // Store only a completion flag, not PII
    sessionStorage.setItem('renterInfoSubmitted', '1');
    hideModal();
  });
}());
