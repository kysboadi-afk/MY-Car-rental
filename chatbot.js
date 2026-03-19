// ===== Sly Transportation Services LLC CHATBOT =====

// ─── Apply Now link helper ────────────────────────────────────────────────────
// Placeholder replaced at reply-generation time with a page-aware Apply Now link.
const APPLY_PLACEHOLDER = "{{APPLY}}";

// On index.html triggers the apply modal; on all other pages navigates to index.html.
function makeApplyLink() {
  if (document.getElementById("applyNowBtn")) {
    return '<a href="#" class="chat-apply-link" ' +
      'onclick="var b=document.getElementById(\'applyNowBtn\');if(b)b.click();return false;">' +
      '👉 Apply Now</a>';
  }
  return '<a href="index.html" class="chat-apply-link">👉 Apply Now</a>';
}

// ─── Static FAQ responses (free-text fallback) ───────────────────────────────
const botResponses = [
  {
    patterns: ["hello","hi","hey","howdy","sup","what's up"],
    reply: "Hi! 👋 Looking to rent a car for DoorDash, Uber Eats, or other delivery apps?\n\n" +
           "Our cars start at <strong>$350/week with unlimited miles</strong>. " +
           "I can help you apply and get approved quickly!\n\n" + APPLY_PLACEHOLDER
  },
  // Vehicle-specific pricing — checked before the general pricing rule
  {
    patterns: ["slingshot price","slingshot cost","slingshot rate","slingshot how much","slingshot fee","how much is the slingshot","how much for the slingshot","how much slingshot","price of slingshot","cost of slingshot"],
    reply: "Here are the Slingshot R rates 🔴\n\n⏱ Hourly Tiers (Sports 2-Seater):\n  • 3 Hours  — $200\n  • 6 Hours  — $250\n  • 24 Hours — $350\n\n💳 $150 security deposit (included at checkout)\n\nReady to ride? " + APPLY_PLACEHOLDER
  },
  {
    patterns: ["camry price","camry cost","camry rate","camry how much","camry fee","how much is the camry","how much for the camry","how much camry","price of camry","cost of camry"],
    reply: "Here are the Camry rates 🔵🟢\n\n🔵 Camry 2012\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • Daily       — $50 / day\n\n🟢 Camry 2013 SE\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • Daily       — $55 / day\n\n✅ No security deposit required · Minimum 7 days.\n\n" + APPLY_PLACEHOLDER
  },
  {
    // "pricing" intentionally listed first — "pricing".includes("price") is false,
    // so without the explicit "pricing" entry the keyword would be silently dropped.
    patterns: ["pricing","price","cost","how much","per week","per day","per month","rate","rates","fee","fees","daily","weekly","monthly","mileage","unlimited miles"],
    reply: "Here are our current rates 🚗\n\n🔵 Camry 2012 — <strong>$350/week</strong> 🚗 Unlimited Miles · No deposit\n🟢 Camry 2013 SE — <strong>$350/week</strong> 🚗 Unlimited Miles · No deposit\n🔴 Slingshot R — $200/3hrs · $250/6hrs · $350/24hrs (+ $150 deposit)\n\nReady to get started? " + APPLY_PLACEHOLDER
  },
  {
    patterns: ["earn","earnings","income","money","make money","how much can i","how much will i"],
    reply: "💸 Drivers using our vehicles typically earn <strong>$800–$1,500/week</strong> driving for DoorDash, Uber Eats, Instacart, and more.\n\nWith unlimited mileage and a weekly rate, the more you drive, the more you earn!\n\n" + APPLY_PLACEHOLDER
  },
  {
    patterns: ["car","cars","vehicle","vehicles","available","fleet","slingshot","camry"],
    reply: "We currently have 3 vehicles available:\n\n🔴 Slingshot R — Sports 2-Seater\n   3 hrs $200 · 6 hrs $250 · 24 hrs $350 (+ $150 deposit)\n\n🔵 Camry 2012 — $350/week, Unlimited Miles (no deposit)\n\n🟢 Camry 2013 SE — $350/week, Unlimited Miles (no deposit)\n\n" + APPLY_PLACEHOLDER
  },
  {
    patterns: ["book","booking","reserve","reservation","how do i","how to","apply","start","get started","sign up"],
    reply: "Getting started is easy! 📋\n\n1. Click Apply Now to submit your info\n2. We'll review & approve your application\n3. Pick your car & dates on the Cars page\n4. Sign the rental agreement\n5. Pay securely via Stripe 💳\n\nA valid driver's license is required. Ready? " + APPLY_PLACEHOLDER
  },
  {
    patterns: ["doordash","uber eats","instacart","amazon flex","delivery","gig","rideshare","lyft","uber","turo","getaround","ride share","drive for","what app","grubhub"],
    reply: "🚗 Our cars are perfect for <strong>DoorDash, Uber Eats, Instacart, Amazon Flex</strong>, and other delivery or rideshare apps.\n\nWe're not a rideshare app — we <em>rent you the car</em> so you can drive for any app you choose!\n\nReady to hit the road? " + APPLY_PLACEHOLDER
  },
  {
    patterns: ["license","licence","driver","driving license","driving licence","id","identification","requirement","requirements","qualify","eligible"],
    reply: "📋 Driver's License Requirement\n\nYes! A valid driving license is required to rent any of our vehicles.\n\n✅ What you'll need:\n  • Valid government-issued driver's license\n  • Must be 21 years or older\n  • License must not be expired\n  • Upload a photo during your application\n\nHave your license ready? " + APPLY_PLACEHOLDER
  },
  {
    patterns: ["deposit","security"],
    reply: "Here's our deposit info 💰\n\n🔴 Slingshot R: $150 deposit (included in payment)\n🔵 Camry 2012: No deposit required\n🟢 Camry 2013 SE: No deposit required\n\nDeposits are refundable upon return of the vehicle in good condition.\n\n" + APPLY_PLACEHOLDER
  },
  {
    patterns: ["cancel","cancellation","refund","no show","no-show","noshow"],
    reply: "⚠️ No-Refund Policy\n\nAll payments are final once a booking is confirmed.\n\n• Cancellations or no-shows after booking are not eligible for a refund\n• Please review your reservation details carefully before completing payment\n• Refunds may be issued only if the company cancels or cannot fulfill the rental\n\nFor questions, call (213) 916-6606 or email slyservices@supports-info.com 🙏"
  },
  {
    patterns: ["contact","phone","call","email","reach","support","help"],
    reply: "You can reach us at:\n\n📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\nWe typically respond within a few hours. Feel free to ask!"
  },
  {
    patterns: ["pay","payment","stripe","credit","card","paypal"],
    reply: "We accept all major credit and debit cards via Stripe 💳\n\nTo pay:\n1. Complete your application\n2. Select your car & dates\n3. Sign the rental agreement\n4. Click 💳 Pay Now\n\nYou'll be redirected to a secure Stripe checkout page.\n\n" + APPLY_PLACEHOLDER
  },
  {
    patterns: ["location","where","pickup","pick up","pick-up","address"],
    reply: "📍 Please contact us to confirm the pickup location:\n\n📧 slyservices@supports-info.com\n\nWe'll share the exact address after your booking is confirmed!"
  },
  {
    patterns: ["thanks","thank you","thank","appreciate","great","awesome","perfect"],
    reply: "You're welcome! 😊 Happy to help. Enjoy your ride with Sly Transportation Services LLC! 🚗💨"
  }
];

function getBotReply(input) {
  var lower = input.toLowerCase();
  for (var i = 0; i < botResponses.length; i++) {
    if (botResponses[i].patterns.some(function(p) { return lower.includes(p); })) {
      return botResponses[i].reply.split(APPLY_PLACEHOLDER).join(makeApplyLink());
    }
  }
  return "I'm not sure about that one 🤔\n\nTry asking about:\n• 💰 Pricing\n• 🚗 Available cars\n• 📋 Requirements\n• 📞 Contact\n\nOr " + makeApplyLink() + " to get started!";
}

// ─── Main chatbot ─────────────────────────────────────────────────────────────
function buildChatbot() {
  // ── inject HTML ──────────────────────────────────────────────────────────────
  document.body.insertAdjacentHTML("beforeend", `
    <div id="chat-reminder" hidden>
      <button id="chat-reminder-close" aria-label="Dismiss reminder">✕</button>
      <p>🚗 Don't miss out! Our cars are <strong>$350/week</strong> with unlimited miles.<br>Start driving for DoorDash, Uber Eats &amp; more today!</p>
      <a id="chat-reminder-link" href="#" class="chat-apply-link">👉 Apply Now</a>
    </div>
    <div id="chat-widget">
      <button id="chat-toggle" aria-label="Open chat">
        💬<span id="chat-badge" hidden aria-hidden="true"></span>
      </button>
      <div id="chat-box" hidden>
        <div id="chat-header">
          <span>🚗 Sly Transportation Services LLC</span>
          <button id="chat-close" aria-label="Close chat">✕</button>
        </div>
        <div id="chat-messages"></div>
        <div id="chat-input-row">
          <input id="chat-input" type="text" placeholder="Type a message..." autocomplete="off"/>
          <button id="chat-send">Send</button>
        </div>
      </div>
    </div>
  `);

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  var toggle        = document.getElementById("chat-toggle");
  var badge         = document.getElementById("chat-badge");
  var closeBtn      = document.getElementById("chat-close");
  var chatBox       = document.getElementById("chat-box");
  var input         = document.getElementById("chat-input");
  var sendBtn       = document.getElementById("chat-send");
  var messages      = document.getElementById("chat-messages");
  var reminder      = document.getElementById("chat-reminder");
  var reminderClose = document.getElementById("chat-reminder-close");
  var reminderLink  = document.getElementById("chat-reminder-link");

  // Reminder "Apply Now" — open modal on index.html, navigate on other pages.
  reminderLink.addEventListener("click", function(e) {
    e.preventDefault();
    hideReminder();
    var btn = document.getElementById("applyNowBtn");
    if (btn) btn.click();
    else window.location.href = "index.html";
  });

  // ── state ────────────────────────────────────────────────────────────────────
  // idle → greeted → faq | collect_name → collect_contact → collect_license
  //      → collect_app → collect_experience → collect_terms → done
  var chatState     = "idle";
  var applicant     = {};   // { name, contact, hasLicense, app, experience, termsAgreed }
  var chatOpened    = false;
  var reminderTimer = null;

  // ── badge & reminder ─────────────────────────────────────────────────────────
  function showBadge()    { badge.hidden = false; toggle.classList.add("chat-toggle-pulse"); }
  function hideBadge()    { badge.hidden = true;  toggle.classList.remove("chat-toggle-pulse"); }
  function showReminder() { reminder.hidden = false; }
  function hideReminder() { reminder.hidden = true; }

  // ── scroll trigger: badge after 10–20 s once user passes 50 % of page ────────
  (function setupScrollTrigger() {
    var fired = false;
    function onScroll() {
      if (fired || chatOpened) return;
      var docH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      if (window.scrollY + window.innerHeight >= docH * 0.5) {
        fired = true;
        window.removeEventListener("scroll", onScroll);
        setTimeout(function() {
          if (chatOpened) return;
          showBadge();
          // 12 s after badge appears without interaction → reminder popup
          reminderTimer = setTimeout(function() {
            if (!chatOpened) showReminder();
          }, 12000);
        }, 10000 + Math.random() * 10000); // 10–20 s random delay
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
  }());

  reminderClose.addEventListener("click", hideReminder);

  // ── HTML-escape for user-supplied text embedded in bot innerHTML ──────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── message helpers ───────────────────────────────────────────────────────────
  function addMessage(text, sender) {
    var msg = document.createElement("div");
    msg.className = "chat-msg " + sender;
    if (sender === "bot") {
      // Bot replies are either hardcoded strings or use escHtml for any user data.
      // innerHTML is safe here; convert \n to <br> for line breaks.
      msg.innerHTML = text.replace(/\n/g, "<br>");
    } else {
      // User input is always set via innerText to prevent XSS.
      msg.innerText = text;
    }
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  // Generic chip row: each chip has { label, action(label) }
  function addChips(chips) {
    var row = document.createElement("div");
    row.className = "chat-quick-replies";
    chips.forEach(function(chip) {
      var btn = document.createElement("button");
      btn.className = "chat-chip";
      btn.textContent = chip.label;
      btn.addEventListener("click", function() {
        row.remove();
        chip.action(chip.label);
      });
      row.appendChild(btn);
    });
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Step 1: delivery-driver greeting ─────────────────────────────────────────
  function startGreeting() {
    chatState = "greeted";
    setTimeout(function() {
      addMessage(
        "Hi! 👋 Looking to rent a car for <strong>DoorDash, Uber Eats</strong>, " +
        "or other delivery apps?\n\n" +
        "Our cars are <strong>$350/week with unlimited miles</strong>. " +
        "I can help you apply and get approved quickly!",
        "bot"
      );
      addChips([
        { label: "✅ Yes, I want to apply",
          action: function(lbl) { addMessage(lbl, "user"); startQualification(); } },
        { label: "❓ I have a question",
          action: function(lbl) { addMessage(lbl, "user"); startFAQ(); } },
      ]);
    }, 400);
  }

  // ── Step 1a: FAQ path ─────────────────────────────────────────────────────────
  function startFAQ() {
    chatState = "faq";
    setTimeout(function() {
      addMessage("Sure! What would you like to know? 👇", "bot");
      addChips([
        { label: "💰 How much does it cost?",
          action: function(lbl) { addMessage(lbl, "user"); faqAnswer("cost"); } },
        { label: "📱 Which apps can I drive for?",
          action: function(lbl) { addMessage(lbl, "user"); faqAnswer("apps"); } },
        { label: "🪪 Do I need a license?",
          action: function(lbl) { addMessage(lbl, "user"); faqAnswer("license"); } },
        { label: "💸 Can I make money?",
          action: function(lbl) { addMessage(lbl, "user"); faqAnswer("earnings"); } },
        { label: "✅ Ready to apply",
          action: function(lbl) { addMessage(lbl, "user"); startQualification(); } },
      ]);
    }, 400);
  }

  function faqAnswer(topic) {
    var answers = {
      cost:
        "💰 Our Camry rentals are <strong>$350/week</strong> with <strong>unlimited miles</strong> " +
        "and no security deposit. You can start driving today!",
      apps:
        "📱 Our cars work with <strong>DoorDash, Uber Eats, Instacart, Amazon Flex</strong>, " +
        "and other delivery or rideshare apps.",
      license:
        "🪪 Yes, a <strong>valid driver's license</strong> is required. " +
        "You must be 21 or older and your license must not be expired.",
      earnings:
        "💸 Drivers using our vehicles typically earn <strong>$800–$1,500/week</strong> " +
        "on delivery apps. It's a great way to start earning fast!",
    };
    addMessage(answers[topic], "bot");
    setTimeout(function() {
      addMessage("Have more questions or ready to apply? 👇", "bot");
      addChips([
        { label: "❓ Another question",
          action: function(lbl) { addMessage(lbl, "user"); startFAQ(); } },
        { label: "✅ Ready to apply",
          action: function(lbl) { addMessage(lbl, "user"); startQualification(); } },
      ]);
    }, 600);
  }

  // ── Step 2: qualification flow ────────────────────────────────────────────────
  function startQualification() {
    chatState = "collect_name";
    setTimeout(function() {
      addMessage(
        "Great! Let's get you pre-approved. 📋\n\nWhat's your <strong>full name</strong>?",
        "bot"
      );
    }, 400);
  }

  function handleName(name) {
    applicant.name = name;
    chatState = "collect_contact";
    setTimeout(function() {
      addMessage(
        "Nice to meet you, <strong>" + escHtml(applicant.name) + "</strong>! 😊\n\n" +
        "What's your <strong>email address and phone number</strong>?",
        "bot"
      );
    }, 400);
  }

  function handleContact(contact) {
    applicant.contact = contact;
    chatState = "collect_license";
    setTimeout(function() {
      addMessage("Do you have a <strong>valid driver's license</strong>?", "bot");
      addChips([
        { label: "✅ Yes, I have a license",
          action: function(lbl) { addMessage(lbl, "user"); handleLicense(true); } },
        { label: "❌ No",
          action: function(lbl) { addMessage(lbl, "user"); handleLicense(false); } },
      ]);
    }, 400);
  }

  function handleLicense(hasLicense) {
    applicant.hasLicense = hasLicense;
    if (!hasLicense) {
      showResult("rejected");
      return;
    }
    chatState = "collect_app";
    setTimeout(function() {
      addMessage("Which <strong>delivery app(s)</strong> will you be driving for?", "bot");
      addChips([
        { label: "🟠 DoorDash",
          action: function(lbl) { addMessage(lbl, "user"); setApp(lbl); } },
        { label: "🟢 Uber Eats",
          action: function(lbl) { addMessage(lbl, "user"); setApp(lbl); } },
        { label: "🛒 Instacart",
          action: function(lbl) { addMessage(lbl, "user"); setApp(lbl); } },
        { label: "📦 Amazon Flex",
          action: function(lbl) { addMessage(lbl, "user"); setApp(lbl); } },
        { label: "📲 Multiple apps",
          action: function(lbl) { addMessage(lbl, "user"); setApp(lbl); } },
      ]);
    }, 400);
  }

  function setApp(app) {
    applicant.app = app;
    chatState = "collect_experience";
    setTimeout(function() {
      addMessage(
        "How long have you been <strong>driving for deliveries</strong> " +
        "(or any professional driving experience)?",
        "bot"
      );
      addChips([
        { label: "🆕 Less than 3 months",
          action: function(lbl) { addMessage(lbl, "user"); setExperience(lbl, "under3"); } },
        { label: "📅 3–6 months",
          action: function(lbl) { addMessage(lbl, "user"); setExperience(lbl, "mid"); } },
        { label: "📅 6–12 months",
          action: function(lbl) { addMessage(lbl, "user"); setExperience(lbl, "senior"); } },
        { label: "⭐ 1+ year",
          action: function(lbl) { addMessage(lbl, "user"); setExperience(lbl, "expert"); } },
      ]);
    }, 400);
  }

  function setExperience(label, level) {
    applicant.experience = level;
    chatState = "collect_terms";
    setTimeout(function() {
      addMessage(
        "Almost done! ✅\n\n" +
        "Do you agree to our <strong>$350/week rental policy</strong> with a minimum rental of 7 days?\n\n" +
        "Review the full terms when you " + makeApplyLink() + ".",
        "bot"
      );
      addChips([
        { label: "✅ Yes, I agree",
          action: function(lbl) { addMessage(lbl, "user"); handleTerms(true); } },
        { label: "❌ No",
          action: function(lbl) { addMessage(lbl, "user"); handleTerms(false); } },
      ]);
    }, 400);
  }

  function handleTerms(agreed) {
    applicant.termsAgreed = agreed;
    if (!agreed) {
      chatState = "done";
      setTimeout(function() {
        addMessage(
          "No problem! 👍 If you change your mind, feel free to come back.\n\n" +
          "📞 (213) 916-6606\n📧 slyservices@supports-info.com\n\n" +
          "You can always " + makeApplyLink() + " when you're ready.",
          "bot"
        );
      }, 400);
      return;
    }
    evaluateApplicant();
  }

  // ── Step 3: pre-approval logic ────────────────────────────────────────────────
  // ❌ Rejected: no valid license (handled in handleLicense)
  // ⚠️ Needs review: < 3 months driving experience
  // ✅ Approved: has license + 3+ months experience + agrees to terms
  function evaluateApplicant() {
    showResult(applicant.experience === "under3" ? "review" : "approved");
  }

  // ── Step 4: result messages ───────────────────────────────────────────────────
  function showResult(outcome) {
    chatState = "done";
    var firstName = escHtml((applicant.name || "there").split(/\s+/)[0]);
    setTimeout(function() {
      if (outcome === "approved") {
        addMessage(
          "🎉 Congratulations, <strong>" + firstName + "</strong>! " +
          "You're <strong>pre-approved</strong> to rent a car with us!\n\n" +
          "Complete your application to reserve your vehicle and start driving today:\n\n" +
          makeApplyLink() + "\n\n🚗💨 You can start once your booking is complete!",
          "bot"
        );
      } else if (outcome === "review") {
        addMessage(
          "Thanks for applying, <strong>" + firstName + "</strong>! 📋\n\n" +
          "Your information requires a quick review before approval. " +
          "We'll contact you within <strong>5–10 minutes</strong> with next steps.\n\n" +
          "Speed things up by submitting your full application now:\n\n" + makeApplyLink(),
          "bot"
        );
      } else {
        // rejected (no license)
        addMessage(
          "Hi <strong>" + firstName + "</strong>, unfortunately your application " +
          "doesn't meet our current criteria.\n\n" +
          "Contact us if you have questions or want more info:\n" +
          "📞 (213) 916-6606\n📧 slyservices@supports-info.com",
          "bot"
        );
      }
    }, 400);
  }

  // ── state-aware send handler ──────────────────────────────────────────────────
  function sendMessage() {
    var text = input.value.trim();
    if (!text) return;
    addMessage(text, "user");
    input.value = "";

    switch (chatState) {
      case "collect_name":
        if (text.length >= 2) {
          handleName(text);
        } else {
          setTimeout(function() { addMessage("Please enter your full name. 😊", "bot"); }, 300);
        }
        break;

      case "collect_contact":
        handleContact(text);
        break;

      case "collect_license": {
        var ll = text.toLowerCase();
        if (/\byes\b|\by\b|have|got|valid/.test(ll))            handleLicense(true);
        else if (/\bno\b|\bn\b|don'?t|no license/.test(ll))    handleLicense(false);
        else setTimeout(function() {
          addMessage("Please tap Yes or No above, or type \"yes\" / \"no\". 😊", "bot");
        }, 300);
        break;
      }

      case "collect_app":
        setApp(text);
        break;

      case "collect_experience": {
        var le = text.toLowerCase();
        var lvl = "senior"; // default mid-tier if we can't parse
        if (/new|never|no exp|less than|under|^[01]\s*mo/.test(le))         lvl = "under3";
        else if (/[3-5]\s*(mo|month)/.test(le))                              lvl = "mid";
        else if (/\b1\s*(year|yr)|\b1[0-9]\s*(mo|month)/.test(le))          lvl = "expert";
        setExperience(text, lvl);
        break;
      }

      case "collect_terms": {
        var lt = text.toLowerCase();
        if (/\byes\b|\by\b|agree|ok\b|sure|yep/.test(lt))       handleTerms(true);
        else if (/\bno\b|\bn\b|don'?t|disagree/.test(lt))       handleTerms(false);
        else setTimeout(function() {
          addMessage("Please tap Yes or No above, or type \"yes\" / \"no\". 😊", "bot");
        }, 300);
        break;
      }

      default:
        // FAQ fallback for idle / greeted / faq / done states
        setTimeout(function() { addMessage(getBotReply(text), "bot"); }, 400);
    }
  }

  // ── open / close ──────────────────────────────────────────────────────────────
  function openChat() {
    chatOpened = true;
    clearTimeout(reminderTimer);
    hideReminder();
    hideBadge();
    chatBox.hidden = false;
    toggle.hidden  = true;
    if (chatState === "idle") startGreeting();
    input.focus();
  }

  function closeChat() {
    chatBox.hidden = true;
    toggle.hidden  = false;
  }

  // ── event listeners ───────────────────────────────────────────────────────────
  toggle.addEventListener("click", openChat);
  closeBtn.addEventListener("click", closeChat);
  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", function(e) { if (e.key === "Enter") sendMessage(); });
}

document.readyState === "loading"
  ? document.addEventListener("DOMContentLoaded", buildChatbot)
  : buildChatbot();
