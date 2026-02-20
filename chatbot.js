// Simple FAQ Chatbot for SLY RIDES Car Rental

const chatbotFAQ = {
  "requirements": {
    keywords: ["requirements", "need", "required", "必需", "documents", "what do i need"],
    answer: "To book a car, you need:\n• Valid government-issued ID (Driver's License or Passport)\n• Email address\n• Payment method (Credit/Debit card)\n• Age requirement: 21+ years old"
  },
  "id_upload": {
    keywords: ["id", "upload", "document", "identification", "license"],
    answer: "You must upload a valid government-issued ID (JPG, PNG, or PDF format, max 5MB). This is required before payment. Your ID will be securely sent to our team for verification."
  },
  "booking": {
    keywords: ["book", "reserve", "reservation", "how to", "rent", "rental"],
    answer: "To book a car:\n1. Browse available vehicles on the homepage\n2. Click 'Select' on your preferred car\n3. Fill in pickup/return dates and times\n4. Upload your ID document\n5. Review total and proceed to payment\n\nOr reserve without payment and we'll contact you!"
  },
  "payment": {
    keywords: ["pay", "payment", "price", "cost", "how much", "charge", "fee"],
    answer: "We accept all major credit/debit cards via Stripe secure payment. Prices vary by vehicle:\n• Slingshot R: $300/day + $150 deposit\n• Camry 2012: $50/day or $250/week\n\nTotal is calculated based on rental duration."
  },
  "slingshot": {
    keywords: ["slingshot", "sports car", "2-seater", "sports"],
    answer: "Slingshot R is our premium sports vehicle:\n• Type: Sports 2-Seater\n• Price: $300 per day\n• Deposit: $150\n• Perfect for thrill-seekers and special occasions!"
  },
  "camry": {
    keywords: ["camry", "sedan", "family", "5-seater"],
    answer: "Camry 2012 is our reliable sedan:\n• Type: 5-Seater Sedan\n• Price: $50 per day or $250 per week\n• Great for families and longer trips"
  },
  "cancel": {
    keywords: ["cancel", "cancellation", "refund", "money back"],
    answer: "For cancellation and refund policies, please review our Rental Agreement & Terms. Contact us at slyservices@support-info.com for assistance with cancellations."
  },
  "contact": {
    keywords: ["contact", "email", "support", "help", "phone", "reach"],
    answer: "Contact us:\n• Email: slyservices@support-info.com\n• We typically respond within 24 hours\n• For urgent matters, use this chat!"
  },
  "greeting": {
    keywords: ["hello", "hi", "hey", "good morning", "good afternoon", "greetings"],
    answer: "Hello! 👋 Welcome to SLY RIDES Car Rental. How can I help you today? Ask me about:\n• Booking requirements\n• Vehicle information\n• Payment & pricing\n• ID upload process\n• Policies & terms"
  },
  "navigation": {
    keywords: ["navigate", "website", "page", "find", "where", "location", "menu"],
    answer: "Website Navigation:\n• Homepage: View available vehicles\n• Click 'Select' on any car to see details and book\n• Booking form: Fill dates, upload ID, and pay\n• Use this chat for instant help anytime!"
  },
  "hours": {
    keywords: ["hours", "open", "close", "time", "available", "schedule", "when"],
    answer: "Our booking system is available 24/7 online! You can:\n• Browse vehicles anytime\n• Make reservations instantly\n• Upload documents any time\n\nOur support team responds to emails within 24 hours on business days."
  },
  "insurance": {
    keywords: ["insurance", "damage", "accident", "coverage", "protection"],
    answer: "Insurance & Damage Protection:\n• Basic insurance is included in all rentals\n• Additional coverage options available upon request\n• Damage deposit required (varies by vehicle)\n• Contact us at slyservices@support-info.com for detailed insurance information"
  },
  "fuel": {
    keywords: ["fuel", "gas", "petrol", "refuel", "tank"],
    answer: "Fuel Policy:\n• Vehicles are provided with a full tank\n• Please return with a full tank\n• Or pay a refueling fee at return\n• Fuel type information provided at pickup"
  },
  "delivery": {
    keywords: ["delivery", "pickup", "drop off", "bring", "location", "where to pick up"],
    answer: "Pickup & Delivery:\n• Standard pickup at our location (details provided after booking)\n• Delivery options may be available - contact us for details\n• Pickup and return times are flexible\n• Contact slyservices@support-info.com to arrange special pickup/delivery"
  },
  "age": {
    keywords: ["age", "old", "young", "minimum age", "how old"],
    answer: "Age Requirements:\n• Minimum age: 21 years old\n• Valid driver's license required\n• Some vehicles may have higher age requirements\n• Young driver fees may apply for drivers under 25"
  },
  "driver": {
    keywords: ["driver", "driving", "additional driver", "who can drive"],
    answer: "Driver Requirements:\n• Valid driver's license (minimum 1 year)\n• Minimum age: 21 years\n• Additional drivers can be added (fees may apply)\n• All drivers must present ID and license\n• International licenses accepted with proper documentation"
  },
  "agreement": {
    keywords: ["agreement", "terms", "contract", "rental agreement", "conditions"],
    answer: "Rental Agreement:\n• Please review our Rental Agreement & Terms before booking\n• Link available on booking page\n• Covers: responsibilities, insurance, damages, returns\n• Must agree to terms before completing reservation\n• Contact us for any questions: slyservices@support-info.com"
  },
  "late": {
    keywords: ["late", "delay", "extension", "return late", "overtime"],
    answer: "Late Returns & Extensions:\n• Please contact us immediately if you'll be late\n• Late fees apply after grace period\n• Extensions available subject to availability\n• Contact: slyservices@support-info.com\n• Additional charges calculated on hourly/daily basis"
  },
  "modification": {
    keywords: ["modify", "change", "update", "edit", "reschedule"],
    answer: "Booking Modifications:\n• To modify your reservation, contact us at slyservices@support-info.com\n• Include your booking details and desired changes\n• Changes subject to availability\n• Modification fees may apply\n• We'll respond within 24 hours"
  },
  "vehicles": {
    keywords: ["vehicles", "cars", "options", "available", "fleet", "what cars"],
    answer: "Our Fleet:\n\n🏎️ Slingshot R - Sports 2-Seater\n   $300/day + $150 deposit\n   Perfect for adventures!\n\n🚗 Camry 2012 - 5-Seater Sedan\n   $50/day or $250/week\n   Great for families!\n\nBrowse our homepage to see photos and details!"
  },
  "website_features": {
    keywords: ["features", "what can i do", "website features", "capabilities"],
    answer: "Website Features:\n✅ Browse available vehicles with photos\n✅ Check real-time availability\n✅ Calculate rental costs instantly\n✅ Upload ID documents securely\n✅ Pay securely with Stripe\n✅ Reserve without payment\n✅ 24/7 chatbot support (that's me!)\n✅ Mobile-friendly design"
  }
};

class SimpleChatbot {
  constructor() {
    this.isOpen = false;
    this.createChatWidget();
    this.attachEventListeners();
  }

  createChatWidget() {
    const chatHTML = `
      <div id="chatbot-container" class="chatbot-container">
        <div id="chatbot-button" class="chatbot-button">
          <span class="chat-icon">💬</span>
          <span class="chat-text">Chat</span>
        </div>
        <div id="chatbot-window" class="chatbot-window" style="display: none;">
          <div class="chatbot-header">
            <h3>SLY RIDES Assistant</h3>
            <button id="chatbot-close" class="chatbot-close">×</button>
          </div>
          <div id="chatbot-messages" class="chatbot-messages">
            <div class="bot-message">
              Hi! I'm your SLY RIDES assistant. 🚗<br><br>
              I can help you with everything about our website:<br>
              • Booking & reservations<br>
              • Vehicle details & pricing<br>
              • Policies & requirements<br>
              • ID upload & payment<br>
              • Website navigation<br>
              • And much more!<br><br>
              Just ask me anything! 😊
            </div>
          </div>
          <div class="chatbot-input-area">
            <input type="text" id="chatbot-input" placeholder="Type your question..." />
            <button id="chatbot-send">Send</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', chatHTML);
  }

  attachEventListeners() {
    const button = document.getElementById('chatbot-button');
    const closeBtn = document.getElementById('chatbot-close');
    const sendBtn = document.getElementById('chatbot-send');
    const input = document.getElementById('chatbot-input');

    button.addEventListener('click', () => this.toggleChat());
    closeBtn.addEventListener('click', () => this.toggleChat());
    sendBtn.addEventListener('click', () => this.sendMessage());
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.sendMessage();
    });
  }

  toggleChat() {
    this.isOpen = !this.isOpen;
    const window = document.getElementById('chatbot-window');
    const button = document.getElementById('chatbot-button');
    
    if (this.isOpen) {
      window.style.display = 'flex';
      button.style.display = 'none';
      document.getElementById('chatbot-input').focus();
    } else {
      window.style.display = 'none';
      button.style.display = 'flex';
    }
  }

  sendMessage() {
    const input = document.getElementById('chatbot-input');
    const message = input.value.trim();
    
    if (!message) return;
    
    this.addMessage(message, 'user');
    input.value = '';
    
    setTimeout(() => {
      const response = this.getResponse(message);
      this.addMessage(response, 'bot');
    }, 500);
  }

  addMessage(text, type) {
    const messagesContainer = document.getElementById('chatbot-messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = type === 'user' ? 'user-message' : 'bot-message';
    messageDiv.innerHTML = text.replace(/\n/g, '<br>');
    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  getResponse(message) {
    const lowerMessage = message.toLowerCase();
    
    // Find matching FAQ
    for (const [key, faq] of Object.entries(chatbotFAQ)) {
      if (faq.keywords.some(keyword => lowerMessage.includes(keyword))) {
        return faq.answer;
      }
    }
    
    // Default response with comprehensive topics
    return "I'm here to help! You can ask me about:\n\n📋 Booking & Reservations\n• How to book a car\n• Requirements needed\n• Payment options\n• Reserve without paying\n\n🚗 Vehicles & Pricing\n• Available cars\n• Pricing & deposits\n• Vehicle features\n\n📄 Policies & Terms\n• Age requirements\n• Driver requirements\n• Insurance & damage\n• Fuel policy\n• Cancellations & refunds\n• Late returns & extensions\n\n💡 Website Help\n• Navigation\n• ID upload process\n• Pickup & delivery\n• Hours & availability\n\n📧 Contact: slyservices@support-info.com";
  }
}

// Initialize chatbot when page loads
document.addEventListener('DOMContentLoaded', () => {
  new SimpleChatbot();
});
