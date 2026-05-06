// ===== LA Slingshot Rentals CHATBOT =====
// Slingshot-specific variant. References slingshot vehicles, hourly packages,
// and LA Slingshot Rentals LLC branding only — no car-rental / delivery-app content.

// Safely escape user-supplied text before embedding it into bot HTML
function slEscHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Los Angeles timezone helper ───────────────────────────────────────────────
window.SlyLA = window.SlyLA || (function () {
  var TZ = "America/Los_Angeles";
  function isoDateInLA(d) {
    try {
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(d instanceof Date ? d : new Date(d || Date.now()));
      var y   = (parts.find(function(p){return p.type==="year";})||{}).value;
      var m   = (parts.find(function(p){return p.type==="month";})||{}).value;
      var day = (parts.find(function(p){return p.type==="day";})||{}).value;
      return y+"-"+m+"-"+day;
    } catch(_) { return new Date().toISOString().slice(0,10); }
  }
  function addDaysToISO(iso, n) {
    var p = String(iso||"").split("-").map(Number);
    if (!isFinite(p[0])||!isFinite(p[1])||!isFinite(p[2])) return null;
    var dt = new Date(Date.UTC(p[0],p[1]-1,p[2]));
    dt.setUTCDate(dt.getUTCDate()+n);
    return dt.toISOString().slice(0,10);
  }
  return { tz: TZ, todayISO: function(){return isoDateInLA(new Date());},
           isoDateInLA: isoDateInLA, addDaysToISO: addDaysToISO };
}());

var SL_API_BASE = "https://sly-rides.vercel.app";

// ── Slingshot packages (mirrors api/_slingshot-packages.js) ──────────────────
var SL_PACKAGES = {
  "2hr":  { hours: 2,  price: 150, label: "2 Hours"  },
  "3hr":  { hours: 3,  price: 200, label: "3 Hours"  },
  "6hr":  { hours: 6,  price: 250, label: "6 Hours"  },
  "24hr": { hours: 24, price: 350, label: "24 Hours" }
};
var SL_DEPOSIT = 500;

// ── Live fleet data ──────────────────────────────────────────────────────────
var slFleetStatus  = null;   // keyed by vehicle_id
var slBookedDates  = null;   // keyed by vehicle_id → [{from, to}]
var slVehicleMeta  = {};     // keyed by vehicle_id

(function fetchSlFleetStatus() {
  fetch(SL_API_BASE + "/api/fleet-status?scope=slingshot")
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(d) { if (d) slFleetStatus = d; })
    .catch(function() {});
}());

(function fetchSlBookedDates() {
  fetch(SL_API_BASE + "/api/booked-dates?scope=slingshot")
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(d) { if (d) slBookedDates = d; })
    .catch(function() {});
}());

(function fetchSlVehicles() {
  fetch(SL_API_BASE + "/api/v2-vehicles?scope=slingshot")
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!Array.isArray(data)) return;
      var icons = ["🟠","🔵","🟢","🟡","🔴","🟣"];
      data.forEach(function(v, i) {
        if (!v.vehicle_id) return;
        slVehicleMeta[v.vehicle_id] = {
          name: v.vehicle_name || v.vehicle_id,
          icon: icons[i % icons.length]
        };
      });
    })
    .catch(function() {});
}());

// ── Helpers ──────────────────────────────────────────────────────────────────
function slPrettifyId(id) {
  return String(id||"")
    .replace(/[_-]+/g," ")
    .replace(/([a-z])([0-9])/gi,"$1 $2")
    .replace(/\s+/g," ")
    .trim()
    .replace(/\b\w/g, function(c){return c.toUpperCase();});
}

function slGetMeta(id) {
  return slVehicleMeta[id] || { name: slPrettifyId(id), icon: "🏎️" };
}

function slGetFleetIds() {
  var seen = {}, ids = [];
  function add(k) { if (k && !seen[k]) { seen[k]=true; ids.push(k); } }
  Object.keys(slVehicleMeta).forEach(add);
  Object.keys(slFleetStatus||{}).forEach(add);
  Object.keys(slBookedDates||{}).forEach(add);
  return ids;
}

function slFmtDate(iso) {
  var p = iso.split("-");
  var d = new Date(Date.UTC(+p[0],+p[1]-1,+p[2],12));
  return d.toLocaleDateString("en-US",{timeZone:"America/Los_Angeles",month:"long",day:"numeric",year:"numeric"});
}

function slNextDay(iso) { return window.SlyLA.addDaysToISO(iso,1); }

// ── Text builders ─────────────────────────────────────────────────────────────

function buildSlPricingText() {
  var lines = [
    "🏎️ Slingshot Rental Packages\n",
    "  • 2 Hours  — $150",
    "  • 3 Hours  — $200",
    "  • 6 Hours  — $250",
    "  • 24 Hours — $350\n",
    "💰 $" + SL_DEPOSIT + " refundable security deposit required at booking.",
    "🚫 No tax on slingshot rentals.",
    "\nChoose your package on our <a href=\"slingshots.html\">Slingshots page</a>!"
  ];
  return lines.join("\n");
}

function buildSlDepositText() {
  return "Deposit info 💰\n\n" +
    "A <strong>$" + SL_DEPOSIT + " refundable security deposit</strong> is required at the time of booking.\n\n" +
    "✅ The deposit is returned after the vehicle is returned undamaged.\n" +
    "🚫 No sales tax applies to slingshot rentals.";
}

function buildSlAvailabilityText() {
  var ids = slGetFleetIds();
  if (!ids.length) {
    return "📅 Slingshot Availability\n\nVisit our <a href=\"slingshots.html\">Slingshots page</a> to check real-time availability for each vehicle, or call us at 📞 (844) 511-4059.";
  }
  var today = window.SlyLA.todayISO();
  var lines = ids.map(function(id) {
    var meta = slGetMeta(id);
    var ranges = slBookedDates
      ? (slBookedDates[id]||[]).slice().sort(function(a,b){return a.from<b.from?-1:1;})
      : [];
    var active = null, next = null;
    for (var i=0;i<ranges.length;i++) {
      var r=ranges[i];
      if (r.from<=today && today<=r.to) active=r;
      else if (r.from>today && !next)  next=r;
    }
    if (active) {
      return meta.icon+" "+meta.name+" — 🔴 Rented until "+slFmtDate(active.to)+" · free: "+slFmtDate(slNextDay(active.to));
    }
    var suffix = next ? " (next booking: "+slFmtDate(next.from)+")" : "";
    return meta.icon+" "+meta.name+" — ✅ Available"+suffix;
  });
  return "📅 Current slingshot availability:\n\n"+lines.join("\n")+
    "\n\nTo book, visit our <a href=\"slingshots.html\">Slingshots page</a> or call 📞 (844) 511-4059.";
}

function buildSlFleetText() {
  var ids = slGetFleetIds();
  if (!ids.length) {
    return "We have a fleet of Polaris Slingshots available in Los Angeles! 🏎️\n\nVisit our <a href=\"slingshots.html\">Slingshots page</a> to browse and book.";
  }
  var today = window.SlyLA.todayISO();
  var lines = ids.map(function(id) {
    var meta = slGetMeta(id);
    var status = "";
    if (slFleetStatus && slFleetStatus[id]) {
      status = slFleetStatus[id].available ? " ✅ Available" : " 🔴 Unavailable";
    }
    return meta.icon+" "+meta.name+status;
  });
  return "🏎️ Our Slingshot Fleet:\n\n"+lines.join("\n")+
    "\n\nPackages from <strong>$150 for 2 hours</strong> up to <strong>$350 for 24 hours</strong>."+
    "\n\nVisit our <a href=\"slingshots.html\">Slingshots page</a> to browse and book!";
}

// ── Bot responses ─────────────────────────────────────────────────────────────
var slBotResponses = [
  {
    patterns: ["hello","hi","hey","howdy","sup","what's up"],
    reply: function() {
      return "Hey! 👋 Welcome to <strong>LA Slingshot Rentals</strong>!\n\nLooking to rent a Polaris Slingshot in Los Angeles? We have packages starting at <strong>$150 for 2 hours</strong>.\n\n<a href=\"slingshots.html\">👉 Browse our slingshots and book now</a>";
    }
  },
  {
    patterns: ["price","cost","how much","rate","rates","fee","fees","package","packages","2 hour","3 hour","6 hour","24 hour","2hr","3hr","6hr","24hr"],
    reply: function() { return buildSlPricingText(); }
  },
  {
    patterns: ["deposit","security","refund"],
    reply: function() { return buildSlDepositText(); }
  },
  {
    patterns: ["available","availability","when","booked","rented","free","status"],
    reply: function() { return buildSlAvailabilityText(); }
  },
  {
    patterns: ["slingshot","polaris","vehicle","vehicles","fleet","car","cars"],
    reply: function() { return buildSlFleetText(); }
  },
  {
    patterns: ["book","booking","reserve","reservation","how do i","how to","get started"],
    reply: "Booking a slingshot is easy! 📅\n\n1. Visit our <a href=\"slingshots.html\">Slingshots page</a>\n2. Click on the slingshot you want\n3. Choose your package (2, 3, 6, or 24 hours)\n4. Select your pickup date & time\n5. Enter your name, email & phone\n6. Upload your Driver's License\n7. Pay the rental fee + $500 refundable deposit\n\n📋 A valid driver's license is required."
  },
  {
    patterns: ["license","licence","driver","requirement","requirements","qualify","eligible","age","21","old"],
    reply: "📋 Requirements to Rent a Slingshot\n\n✅ What you'll need:\n  • Valid government-issued driver's license\n  • Must be 21 years or older\n  • License must not be expired\n  • You will need to upload a photo during booking\n\nThe Polaris Slingshot is a 3-wheeled autocycle — it's easy and fun to drive! 🏎️"
  },
  {
    patterns: ["cancel","cancellation","no show","no-show","noshow"],
    reply: "⚠️ Cancellation Policy\n\nAll payments are final once a booking is confirmed.\n\n• Cancellations after booking are not eligible for a refund\n• The $500 security deposit is refunded after the vehicle is returned undamaged\n• Refunds may be issued only if we cancel or cannot fulfill the rental\n\nFor questions, call 📞 (844) 511-4059 or email slyservices@supports-info.com 🙏"
  },
  {
    patterns: ["contact","phone","call","email","reach","support","help"],
    reply: "You can reach us at:\n\n📞 (844) 511-4059\n📧 slyservices@supports-info.com\n\nWe typically respond within a few hours. Feel free to ask!"
  },
  {
    patterns: ["pay","payment","stripe","credit","card","checkout"],
    reply: "We accept all major credit and debit cards via Stripe 💳\n\nPayment is collected securely at checkout — you'll pay the rental package fee plus a $500 refundable security deposit.\n\nNo tax on slingshot rentals! 🎉"
  },
  {
    patterns: ["location","where","pickup","pick up","pick-up","address"],
    reply: "📍 Please contact us to confirm the pickup location:\n\n📞 (844) 511-4059\n📧 slyservices@supports-info.com\n\nWe'll share the exact address after your booking is confirmed!"
  },
  {
    patterns: ["extend","extension","longer","more time","extra time"],
    reply: "⏱️ Extending Your Rental\n\nNeed more time? You can extend your slingshot rental!\n\nOn your booking confirmation page, use the <strong>Extend Rental</strong> option to add more time.\n\nOr call us at 📞 (844) 511-4059 and we'll help you extend."
  },
  {
    patterns: ["late","late return","late fee","grace","grace period"],
    reply: "⏰ Late Return Policy\n\nA <strong>30-minute grace period</strong> is provided after your scheduled return time.\n\nAfter the grace period: <strong>$100/hour</strong> for each hour (or part thereof) you are late.\n\nPlease return the slingshot on time to avoid late charges! 🙏"
  },
  {
    patterns: ["safe","safety","drive","driving","experience","how hard","easy","difficult","fun"],
    reply: "🏎️ Driving a Polaris Slingshot\n\nThe Polaris Slingshot is a 3-wheeled autocycle — it's <strong>incredibly fun</strong> and straightforward to drive!\n\n✅ Automatic or manual transmission options\n✅ Open-air cockpit for a thrilling experience\n✅ Stable 3-wheel design\n\nA valid driver's license is all you need. No motorcycle license required in California!"
  },
  {
    patterns: ["thanks","thank you","thank","appreciate","great","awesome","perfect"],
    reply: "You're welcome! 😊 Happy to help. Enjoy your slingshot experience with LA Slingshot Rentals! 🏎️💨"
  }
];

function slGetBotReply(input) {
  var lower = input.toLowerCase();
  for (var i=0;i<slBotResponses.length;i++) {
    var item = slBotResponses[i];
    if (item.patterns.some(function(p){return lower.includes(p);})) {
      return typeof item.reply==="function" ? item.reply() : item.reply;
    }
  }
  return "I'm not sure about that one 🤔\n\nTry asking about:\n• Pricing & packages\n• Available slingshots\n• How to book\n• Requirements\n• Contact info\n\nOr call us at 📞 (844) 511-4059";
}

// ── Widget builder ─────────────────────────────────────────────────────────────
function buildSlingshotChatbot() {
  document.body.insertAdjacentHTML("beforeend",
    '<div id="chat-widget">' +
      '<button id="chat-toggle" aria-label="Open chat">💬' +
        '<span id="chat-badge" hidden aria-hidden="true"></span>' +
      '</button>' +
      '<div id="chat-box" hidden>' +
        '<div id="chat-header">' +
          '<span id="chat-header-title">LA Slingshot Rentals</span>' +
          '<button id="chat-close" aria-label="Close chat">✕</button>' +
        '</div>' +
        '<div id="chat-messages"></div>' +
        '<div id="chat-input-row">' +
          '<input id="chat-input" type="text" placeholder="Ask a question…" autocomplete="off"/>' +
          '<button id="chat-send">Send</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div id="chat-reminder" hidden role="alertdialog" aria-label="Chat reminder">' +
      '<button id="chat-reminder-close" aria-label="Dismiss reminder">✕</button>' +
      '<p>🏎️ <strong>Polaris Slingshot Rentals — from $150!</strong></p><p>Book a slingshot in Los Angeles today.</p>' +
      '<button id="chat-reminder-cta">Book Now →</button>' +
    '</div>'
  );

  var toggle        = document.getElementById("chat-toggle");
  var badge         = document.getElementById("chat-badge");
  var closeBtn      = document.getElementById("chat-close");
  var chatBox       = document.getElementById("chat-box");
  var input         = document.getElementById("chat-input");
  var sendBtn       = document.getElementById("chat-send");
  var messages      = document.getElementById("chat-messages");
  var reminder      = document.getElementById("chat-reminder");
  var reminderClose = document.getElementById("chat-reminder-close");
  var reminderCta   = document.getElementById("chat-reminder-cta");

  var userInteracted = false;
  var userDismissed  = false;
  var reminderTimer  = null;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function addMessage(text, sender) {
    var msg = document.createElement("div");
    msg.className = "chat-msg " + sender;
    if (sender === "bot") {
      msg.innerHTML = text.replace(/\n/g, "<br>");
    } else {
      msg.innerText = text;
    }
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  function addChips(chips) {
    var row = document.createElement("div");
    row.className = "chat-chips";
    chips.forEach(function(chip) {
      var btn = document.createElement("button");
      btn.className = "chat-chip";
      btn.textContent = chip.label;
      btn.addEventListener("click", function() {
        if (row.parentNode) row.parentNode.removeChild(row);
        userInteracted = true;
        addMessage(chip.label, "user");
        chip.action();
      });
      row.appendChild(btn);
    });
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Entry chips ────────────────────────────────────────────────────────────
  function showEntryChips() {
    addChips([
      { label: "💰 Pricing & Packages", action: function() { showFAQAnswer("pricing");      } },
      { label: "🏎️ Our Slingshots",     action: function() { showFAQAnswer("fleet");        } },
      { label: "📅 Check Availability", action: function() { showFAQAnswer("availability"); } },
      { label: "📋 Requirements",        action: function() { showFAQAnswer("reqs");         } },
      { label: "📞 Contact Us",          action: function() { showFAQAnswer("contact");      } }
    ]);
  }

  // ── FAQ answers ────────────────────────────────────────────────────────────
  var faqReplies = {
    pricing: function() { return buildSlPricingText(); },
    fleet:   function() { return buildSlFleetText(); },
    availability: function() { return buildSlAvailabilityText(); },
    deposit: function() { return buildSlDepositText(); },
    reqs: "📋 Requirements to Rent a Slingshot\n\n✅ What you'll need:\n  • Valid government-issued driver's license\n  • Must be 21 years or older\n  • License must not be expired\n  • Upload a photo of your license during booking\n\nNo motorcycle license needed in California! 🏎️",
    contact: "You can reach us at:\n\n📞 (844) 511-4059\n📧 slyservices@supports-info.com\n\nWe typically respond within a few hours!",
    booking: "Booking is easy! 📅\n\n1. Visit our <a href=\"slingshots.html\">Slingshots page</a>\n2. Click on your chosen slingshot\n3. Select your package (2, 3, 6, or 24 hours)\n4. Pick your date & time\n5. Upload your Driver's License\n6. Pay securely via Stripe 💳",
    latefee: "⏰ Late Return Fee\n\nA <strong>30-minute grace period</strong> applies after your scheduled return time.\n\nAfter that: <strong>$100/hour</strong> for each hour (or part thereof) you are late.\n\nPlease return on time! 🙏"
  };

  function showFAQAnswer(topic) {
    var val = faqReplies[topic];
    var msg = typeof val === "function" ? val() : (val || "");
    setTimeout(function() {
      addMessage(msg, "bot");
      setTimeout(function() {
        addChips([
          { label: "🔙 More questions", action: showMoreChips },
          { label: "🏎️ Book Now",       action: function() { addMessage("Visit <a href=\"slingshots.html\">slingshots.html</a> to book your ride!", "bot"); } }
        ]);
      }, 600);
    }, 400);
  }

  function showMoreChips() {
    setTimeout(function() {
      addMessage("What else can I help you with? 👇", "bot");
      showEntryChips();
    }, 300);
  }

  // ── Open / close ────────────────────────────────────────────────────────────
  function openChat() {
    chatBox.hidden = false;
    toggle.hidden  = true;
    badge.hidden   = true;
    dismissReminder();
    if (!messages.children.length) {
      addMessage("Hey! 👋 Welcome to <strong>LA Slingshot Rentals</strong>! How can I help you today?", "bot");
      setTimeout(showEntryChips, 600);
    }
    input.focus();
  }

  function closeChat() {
    chatBox.hidden = true;
    toggle.hidden  = false;
    userDismissed  = true;
  }

  function dismissReminder() {
    reminder.hidden = true;
    if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
  }

  // ── Send ────────────────────────────────────────────────────────────────────
  function sendMessage() {
    var text = input.value.trim();
    if (!text) return;
    userInteracted = true;
    addMessage(text, "user");
    input.value = "";
    setTimeout(function() {
      var reply;
      try { reply = slGetBotReply(text); }
      catch(e) { reply = "I'm not sure about that — call us at 📞 (844) 511-4059 for help!"; }
      addMessage(reply, "bot");
      setTimeout(function() {
        addChips([
          { label: "🔙 More questions", action: showMoreChips },
          { label: "🏎️ Book Now",       action: function() {
            addMessage("Ready to ride? Visit <a href=\"slingshots.html\">our Slingshots page</a> to book!", "bot");
          }}
        ]);
      }, 800);
    }, 400);
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  toggle.addEventListener("click", openChat);
  closeBtn.addEventListener("click", closeChat);
  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", function(e) { if (e.key === "Enter") sendMessage(); });

  reminderClose.addEventListener("click", function() {
    dismissReminder();
    userDismissed = true;
  });
  reminderCta.addEventListener("click", function() {
    dismissReminder();
    openChat();
  });

  // ── Badge + reminder ────────────────────────────────────────────────────────
  var badgeShown   = false;
  var scrolledHalf = false;

  function maybeShowBadge() {
    if (badgeShown || userInteracted || !chatBox.hidden) return;
    badge.hidden = false;
    badge.setAttribute("aria-hidden","false");
    toggle.classList.add("chat-toggle-pulse");
    badgeShown = true;
    reminderTimer = setTimeout(function() {
      if (!userInteracted && chatBox.hidden && !userDismissed) {
        reminder.hidden = false;
      }
    }, 12000);
  }

  window.addEventListener("scroll", function() {
    if (scrolledHalf) return;
    var halfway = document.documentElement.scrollHeight / 2;
    if (window.scrollY + window.innerHeight >= halfway) {
      scrolledHalf = true;
      if (!badgeShown && !userInteracted && chatBox.hidden) maybeShowBadge();
    }
  }, { passive: true });

  var autoDelay = Math.floor(Math.random() * 10000) + 10000; // 10–20 s
  setTimeout(function() {
    if (userInteracted || !chatBox.hidden) return;
    if (scrolledHalf) {
      maybeShowBadge();
    } else {
      if (!userDismissed) openChat();
    }
  }, autoDelay);
}

document.readyState === "loading"
  ? document.addEventListener("DOMContentLoaded", buildSlingshotChatbot)
  : buildSlingshotChatbot();
