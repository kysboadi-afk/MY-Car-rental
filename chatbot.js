// ===== Sly Transportation Services LLC CHATBOT =====

// Placeholder replaced at reply-generation time with a page-aware Apply Now link.
const APPLY_PLACEHOLDER = "{{APPLY}}";

// Returns an "Apply Now" HTML anchor that works on every page.
// On index.html it clicks the existing hero button to open the apply modal;
// on all other pages it navigates back to the homepage.
function makeApplyLink() {
  if (document.getElementById("applyNowBtn")) {
    return '<a href="#" class="chat-apply-link" ' +
      'onclick="var b=document.getElementById(\'applyNowBtn\');if(b)b.click();return false;">' +
      '👉 Apply Now</a>';
  }
  return '<a href="index.html" class="chat-apply-link">👉 Apply Now</a>';
}

const botResponses = [
  {
    patterns: ["hello","hi","hey","howdy","sup","what's up"],
    reply: "Hey! 👋 Welcome to Sly Transportation Services LLC!\n\nAsk me about:\n• 💰 Pricing & rates\n• 🚗 Available cars\n• ♾️ Unlimited mileage\n• 📋 Requirements\n• 📞 Contact\n\nOr jump straight in → " + APPLY_PLACEHOLDER
  },
  // Vehicle-specific pricing — checked before the general pricing rule
  {
    patterns: ["slingshot price","slingshot cost","slingshot rate","slingshot how much","slingshot fee","how much is the slingshot","how much for the slingshot","how much slingshot","price of slingshot","cost of slingshot"],
    reply: "Here are the Slingshot R rates 🔴\n\n⏱ Hourly Tiers (Sports 2-Seater):\n  • 3 Hours  — $200\n  • 6 Hours  — $250\n  • 24 Hours — $350\n\n💳 $150 security deposit (included at checkout)\n\nReady to ride? " + APPLY_PLACEHOLDER
  },
  {
    patterns: ["camry price","camry cost","camry rate","camry how much","camry fee","how much is the camry","how much for the camry","how much camry","price of camry","cost of camry"],
    reply: "Here are the Camry rates 🔵🟢\n\n🔵 Camry 2012\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • Daily       — $50 / day\n\n🟢 Camry 2013 SE\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • Daily       — $55 / day\n\n✅ No security deposit required\nMinimum rental is 7 days.\n\n" + APPLY_PLACEHOLDER
  },
  {
    // "pricing" intentionally listed first — "pricing".includes("price") is false,
    // so without the explicit "pricing" entry the keyword was silently dropped.
    patterns: ["pricing","price","cost","how much","per week","per day","per month","rate","rates","fee","fees","daily","weekly","monthly","mileage","unlimited miles"],
    reply: "Here are our current rates 🚗\n\n🔴 Slingshot R (Sports 2-Seater)\n  • 3 Hours  — $200\n  • 6 Hours  — $250\n  • 24 Hours — $350\n  • + $150 deposit\n\n🔵 Camry 2012\n  • 1 Week   — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • No deposit\n\n🟢 Camry 2013 SE\n  • 1 Week   — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • No deposit\n\nReady to get started? " + APPLY_PLACEHOLDER
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
    patterns: ["app","uber","lyft","turo","getaround","rideshare","ride share","drive for","what app","doordash","instacart","grubhub"],
    reply: "Great question! 🚗 We are <strong>not</strong> a rideshare or delivery app.<br><br>We are <strong>Sly Transportation Services LLC</strong> — a car rental company based in Los Angeles, CA.<br><br>We rent vehicles directly to you, so <em>you</em> can drive for any app you like — Uber, Lyft, Turo, or just for personal use!<br><br>Ready to get behind the wheel? " + APPLY_PLACEHOLDER
  },
  {
    patterns: ["thanks","thank you","thank","appreciate","great","awesome","perfect"],
    reply: "You're welcome! 😊 Happy to help. Enjoy your ride with Sly Transportation Services LLC! 🚗💨"
  }
];

function getBotReply(input) {
  const lower = input.toLowerCase();
  for (const item of botResponses) {
    if (item.patterns.some(p => lower.includes(p))) {
      // Swap in the page-aware Apply Now link before returning.
      return item.reply.split(APPLY_PLACEHOLDER).join(makeApplyLink());
    }
  }
  return "I'm not sure about that one 🤔\n\nTry asking about:\n• Pricing\n• Available cars\n• How to book\n• Deposit\n• Contact info\n\nOr " + makeApplyLink() + " to get started!";
}

function buildChatbot() {
  // Inject HTML
  document.body.insertAdjacentHTML("beforeend", `
    <div id="chat-widget">
      <button id="chat-toggle" aria-label="Open chat">💬</button>
      <div id="chat-box" hidden>
        <div id="chat-header">
          <span>🚗 Sly Transportation Services LLC Assistant</span>
          <button id="chat-close" aria-label="Close chat">✕</button>
        </div>
        <div id="chat-messages"></div>
        <div id="chat-input-row">
          <input id="chat-input" type="text" placeholder="Ask a question..." autocomplete="off"/>
          <button id="chat-send">Send</button>
        </div>
      </div>
    </div>
  `);

  const toggle   = document.getElementById("chat-toggle");
  const closeBtn = document.getElementById("chat-close");
  const chatBox  = document.getElementById("chat-box");
  const input    = document.getElementById("chat-input");
  const sendBtn  = document.getElementById("chat-send");
  const messages = document.getElementById("chat-messages");

  function addMessage(text, sender) {
    const msg = document.createElement("div");
    msg.className = "chat-msg " + sender;
    if (sender === "bot") {
      // Bot replies are hardcoded static strings (never user input), so innerHTML is safe.
      // Convert \n to <br> so plain-text replies keep their line breaks.
      msg.innerHTML = text.replace(/\n/g, "<br>");
    } else {
      // User input is always set via innerText to prevent XSS.
      msg.innerText = text;
    }
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  // Render clickable quick-reply chips so users can tap common topics without typing.
  function addQuickReplies() {
    const chips = [
      { label: "💰 Pricing",      query: "pricing" },
      { label: "🔴 Slingshot",    query: "slingshot price" },
      { label: "🔵 Camry",        query: "camry price" },
      { label: "♾️ Unlimited Miles", query: "unlimited miles" },
      { label: "📋 Requirements", query: "requirements" },
      { label: "📞 Contact",      query: "contact" },
    ];

    const row = document.createElement("div");
    row.className = "chat-quick-replies";

    chips.forEach(function (chip) {
      const btn = document.createElement("button");
      btn.className = "chat-chip";
      btn.textContent = chip.label;
      btn.addEventListener("click", function () {
        // Remove chips after first selection to keep the conversation clean.
        row.remove();
        addMessage(chip.label, "user");
        setTimeout(function () { addMessage(getBotReply(chip.query), "bot"); }, 400);
      });
      row.appendChild(btn);
    });

    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }

  function openChat() {
    chatBox.hidden = false;
    toggle.hidden  = true;
    if (!messages.children.length) {
      addMessage(
        "Hey! 👋 Welcome to Sly Transportation Services LLC!\n\nAsk me anything — pricing, unlimited miles, how to apply, and more. Or tap a topic below:",
        "bot"
      );
      addQuickReplies();
    }
    input.focus();
  }

  function closeChat() {
    chatBox.hidden = true;
    toggle.hidden  = false;
  }

  function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    addMessage(text, "user");
    input.value = "";
    setTimeout(() => addMessage(getBotReply(text), "bot"), 400);
  }

  toggle.addEventListener("click", openChat);
  closeBtn.addEventListener("click", closeChat);
  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });
}

document.readyState === "loading"
  ? document.addEventListener("DOMContentLoaded", buildChatbot)
  : buildChatbot();
