// ===== Sly Transportation Services LLC CHATBOT =====

const botResponses = [
  {
    patterns: ["hello","hi","hey","howdy","sup","what's up"],
    reply: "Hey! 👋 Looking to rent a car for DoorDash, Uber Eats, or other delivery apps?\n\nOur cars are <strong>$350/week with unlimited miles</strong>. I can help you get approved quickly.\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Click here to apply and get approved</a>"
  },
  // Vehicle-specific pricing — checked before the general pricing rule
  {
    patterns: ["slingshot price","slingshot cost","slingshot rate","slingshot how much","slingshot fee","how much is the slingshot","how much for the slingshot","how much slingshot","price of slingshot","cost of slingshot"],
    reply: "Here are the Slingshot R rates 🔴\n\n⏱ Hourly Tiers (Sports 2-Seater):\n  • 3 Hours  — $200\n  • 6 Hours  — $250\n  • 24 Hours — $350\n\n💳 $150 security deposit required\n   (included in your payment at checkout)\n\nReady to book? Visit our Cars page!"
  },
  {
    patterns: ["camry price","camry cost","camry rate","camry how much","camry fee","how much is the camry","how much for the camry","how much camry","price of camry","cost of camry"],
    reply: "Here are the Camry rates 🔵🟢\n\n🔵 Camry 2012\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • Daily       — $50 / day\n\n🟢 Camry 2013 SE\n  • 1 Week    — $350 🚗 Unlimited Miles\n  • 2 Weeks  — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • Daily       — $55 / day\n\n✅ No security deposit required\n\nMinimum rental is 7 days. Ready to book? Visit our Cars page!\n\n📋 Do you have a valid driving license?"
  },
  {
    patterns: ["price","cost","how much","rate","rates","fee","fees","daily","weekly","monthly"],
    reply: "Here are our current rates 🚗\n\n🔴 Slingshot R (Sports 2-Seater)\n  • 3 Hours  — $200\n  • 6 Hours  — $250\n  • 24 Hours — $350\n  • + $150 deposit\n\n🔵 Camry 2012\n  • 1 Week   — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • No deposit required\n\n🟢 Camry 2013 SE\n  • 1 Week   — $350 🚗 Unlimited Miles\n  • 2 Weeks — $650 🚗 Unlimited Miles\n  • 1 Month  — $1,300 🚗 Unlimited Miles\n  • No deposit required\n\nAsk me about a specific car for more details!"
  },
  {
    patterns: ["earn","earnings","income","make money","how much can","how much money","revenue"],
    reply: "💰 Earning Potential with SLY Rides\n\nOur delivery drivers typically earn:\n  • $800 – $1,500 per week\n\nworking on apps like DoorDash, Uber Eats, Instacart, and Amazon Flex.\n\nFor just $350/week with unlimited miles, that's a great return!\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Apply now to get approved</a>"
  },
  {
    patterns: ["car","cars","vehicle","vehicles","available","fleet","slingshot","camry"],
    reply: "We currently have 3 vehicles available:\n\n🔴 Slingshot R — Sports 2-Seater\n   3 hrs $200 · 6 hrs $250 · 24 hrs $350 (+ $150 deposit)\n\n🔵 Camry 2012 — $350/week, Unlimited Miles (no deposit)\n\n🟢 Camry 2013 SE — $350/week, Unlimited Miles (no deposit)\n\nVisit our Cars page to browse and book!"
  },
  {
    patterns: ["book","booking","reserve","reservation","how do i","how to"],
    reply: "Booking is easy! 📅\n\n1. Visit our Cars page to browse vehicles\n2. Click 'Select' on your chosen vehicle\n3. Choose your pickup & return dates\n4. Enter your name, email & phone\n5. Upload your Driver's License / ID\n6. Sign the rental agreement\n7. Click 💳 Pay Now\n\n📋 Do you have a valid driving license? A valid driver's license is required to rent any of our vehicles."
  },
  {
    patterns: ["apply","application","sign up","get approved","approved","approval","start","get started"],
    reply: "Getting approved is quick and easy! 🚀\n\nJust fill out our short application:\n  • Full name & phone number\n  • Driver's license upload\n  • Age (must be 21+)\n  • Driving experience (3+ months)\n  • Which delivery apps you use\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Click here to apply now</a>\n\nApprovals are typically same-day! 🎉"
  },
  {
    patterns: ["license","licence","driver","driving license","driving licence","id","identification","requirement","requirements","qualify","eligible"],
    reply: "📋 Driver's License Requirement\n\nYes! A valid driving license is required to rent any of our vehicles.\n\n✅ What you'll need:\n  • Valid government-issued driver's license\n  • Must be 21 years or older\n  • At least 3 months of driving experience\n  • License must not be expired\n  • You will need to upload a photo of your license during booking\n\nDo you have a valid driving license? If yes, you're ready to apply! 🚗\n\n<a href=\"index.html\" id=\"chatApplyLink\">👉 Apply now</a>"
  },
  {
    patterns: ["deposit","security"],
    reply: "Here's our deposit info 💰\n\n🔴 Slingshot R: $150 deposit\n🔵 Camry 2012: No deposit required\n🟢 Camry 2013 SE: No deposit required\n\nDeposits are refundable upon return of the vehicle in good condition."
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
    reply: "We accept all major credit and debit cards via Stripe 💳\n\nTo pay:\n1. Select your car & dates\n2. Enter your email\n3. Check the rental agreement box\n4. Click 💳 Pay Now\n\nYou'll be redirected to a secure Stripe checkout page."
  },
  {
    patterns: ["location","where","pickup","pick up","pick-up","address"],
    reply: "📍 Please contact us to confirm the pickup location:\n\n📧 slyservices@supports-info.com\n\nWe'll share the exact address after your booking is confirmed!"
  },
  {
    patterns: ["app","uber","lyft","turo","getaround","rideshare","ride share","drive for","what app","doordash","instacart","grubhub","amazon flex","amazon"],
    reply: "Great question! 🚗 We are <strong>not</strong> a rideshare or delivery app.<br><br>We are <strong>Sly Transportation Services LLC</strong> — a car rental company based in Los Angeles, CA.<br><br>We rent vehicles directly to you, so <em>you</em> can drive for any app you like — DoorDash, Uber Eats, Instacart, Amazon Flex, and more!<br><br>Ready to get behind the wheel? 👇<br><a href=\"index.html\" id=\"chatApplyLink\">👉 Apply &amp; Get Approved Now</a>"
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
      return item.reply;
    }
  }
  return "I'm not sure about that one 🤔\n\nTry asking about:\n• Pricing\n• Available cars\n• How to book\n• Delivery apps\n• Contact info\n\nOr email us at slyservices@supports-info.com";
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

  // Track whether the user has ever manually dismissed the chat
  let userDismissed = false;

  function addMessage(text, sender) {
    const msg = document.createElement("div");
    msg.className = "chat-msg " + sender;
    if (sender === "bot") {
      // Bot replies are hardcoded static strings (never user input), so innerHTML is safe.
      // Convert \n to <br> so plain-text replies keep their line breaks.
      msg.innerHTML = text.replace(/\n/g, "<br>");
      // Wire up any "Apply Now" links injected into bot replies so they open the
      // apply modal instead of navigating away (only on the homepage).
      msg.querySelectorAll("#chatApplyLink").forEach(function (link) {
        if (typeof openApplyModal === "function") {
          link.addEventListener("click", function (e) {
            e.preventDefault();
            openApplyModal();
            closeChat();
          });
        }
      });
    } else {
      // User input is always set via innerText to prevent XSS.
      msg.innerText = text;
    }
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  function openChat() {
    chatBox.hidden = false;
    toggle.hidden  = true;
    if (!messages.children.length) {
      addMessage(
        "Hi! 👋 Looking to rent a car for DoorDash, Uber Eats, or other delivery apps?\n\n" +
        "Our cars are <strong>$350/week with unlimited miles</strong>. I can help you get approved quickly.\n\n" +
        "Ask me anything — pricing, requirements, earnings — or click below to apply!\n\n" +
        "<a href=\"index.html\" id=\"chatApplyLink\">👉 Apply and get approved now</a>",
        "bot"
      );
    }
    input.focus();
  }

  function closeChat() {
    chatBox.hidden = true;
    toggle.hidden  = false;
    userDismissed  = true;
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

  // Auto-open the chatbot after a random delay between 10 and 20 seconds,
  // unless the user has already opened or dismissed it themselves.
  const autoDelay = Math.floor(Math.random() * 10000) + 10000; // 10–20 s
  setTimeout(function () {
    if (!userDismissed && chatBox.hidden) {
      openChat();
    }
  }, autoDelay);
}

document.readyState === "loading"
  ? document.addEventListener("DOMContentLoaded", buildChatbot)
  : buildChatbot();
