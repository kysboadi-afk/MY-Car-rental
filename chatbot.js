// ===== Sly Transportation Services LLC CHATBOT =====

const botResponses = [
  {
    patterns: ["hello","hi","hey","howdy","sup","what's up"],
    reply: "Hey! 👋 Welcome to Sly Transportation Services LLC! How can I help you today?\n\nYou can ask me about:\n• Pricing\n• Available cars\n• How to book\n• Deposit info\n• Contact"
  },
  {
    patterns: ["price","cost","how much","rate","rates","fee","fees","daily","weekly","monthly"],
    reply: "Here are our current rates 🚗\n\n🔴 Slingshot R (Sports 2-Seater)\n  • $300 / day + $150 deposit\n\n🔵 Camry 2012 (Sedan 5-Seater)\n  • $50 / day\n  • $320 / week\n  • $600 / 2 weeks\n  • $1,250 / month\n\nNeed anything else?"
  },
  {
    patterns: ["car","cars","vehicle","vehicles","available","fleet","slingshot","camry"],
    reply: "We currently have 2 vehicles available:\n\n🔴 Slingshot R — Sports 2-Seater, $300/day\n🔵 Camry 2012 — Sedan 5-Seater, $50/day\n\nVisit our Cars page to browse and book!"
  },
  {
    patterns: ["book","booking","reserve","reservation","how do i","how to"],
    reply: "Booking is easy! 📅\n\n1. Browse cars at cars.html\n2. Click 'Select' on your chosen vehicle\n3. Choose your pickup & return dates\n4. Enter your name, email & phone\n5. Upload your Driver's License / ID\n6. Sign the rental agreement\n7. Click 💳 Pay Now\n\nAny questions?"
  },
  {
    patterns: ["deposit","security"],
    reply: "Here's our deposit info 💰\n\n🔴 Slingshot R: $150 deposit\n🔵 Camry 2012: No deposit required\n\nDeposits are refundable upon return of the vehicle in good condition."
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
  return "I'm not sure about that one 🤔\n\nTry asking about:\n• Pricing\n• Available cars\n• How to book\n• Deposit\n• Contact info\n\nOr email us at slyservices@supports-info.com";
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
    msg.innerText = text;
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  function openChat() {
    chatBox.hidden = false;
    toggle.hidden  = true;
    if (!messages.children.length) {
      addMessage("Hey! 👋 Welcome to Sly Transportation Services LLC! Ask me anything — pricing, how to book, contact info, and more!", "bot");
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
