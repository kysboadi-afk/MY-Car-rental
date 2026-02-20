// Simple FAQ Chatbot for SLY RIDES Car Rental

const chatbotFAQ = {
  "requirements": {
    keywords: ["requirements", "need", "required", "必需", "documents"],
    answer: "To book a car, you need:\n• Valid government-issued ID (Driver's License or Passport)\n• Email address\n• Payment method (Credit/Debit card)\n• Age requirement: 21+ years old"
  },
  "id_upload": {
    keywords: ["id", "upload", "document", "identification"],
    answer: "You must upload a valid government-issued ID (JPG, PNG, or PDF format, max 5MB). This is required before payment. Your ID will be securely sent to our team for verification."
  },
  "booking": {
    keywords: ["book", "reserve", "reservation", "how to"],
    answer: "To book a car:\n1. Browse available vehicles on the homepage\n2. Click 'Select' on your preferred car\n3. Fill in pickup/return dates and times\n4. Upload your ID document\n5. Review total and proceed to payment"
  },
  "payment": {
    keywords: ["pay", "payment", "price", "cost", "how much"],
    answer: "We accept all major credit/debit cards via Stripe secure payment. Prices vary by vehicle:\n• Slingshot R: $300/day + $150 deposit\n• Camry 2012: $50/day or $250/week\n\nTotal is calculated based on rental duration."
  },
  "slingshot": {
    keywords: ["slingshot", "sports car", "2-seater"],
    answer: "Slingshot R is our premium sports vehicle:\n• Type: Sports 2-Seater\n• Price: $300 per day\n• Deposit: $150\n• Perfect for thrill-seekers and special occasions!"
  },
  "camry": {
    keywords: ["camry", "sedan", "family", "5-seater"],
    answer: "Camry 2012 is our reliable sedan:\n• Type: 5-Seater Sedan\n• Price: $50 per day or $250 per week\n• Great for families and longer trips"
  },
  "cancel": {
    keywords: ["cancel", "cancellation", "refund"],
    answer: "For cancellation and refund policies, please review our Rental Agreement & Terms. Contact us at slyservices@support-info.com for assistance."
  },
  "contact": {
    keywords: ["contact", "email", "support", "help", "phone"],
    answer: "Contact us:\n• Email: slyservices@support-info.com\n• We typically respond within 24 hours\n• For urgent matters, use the chat!"
  },
  "greeting": {
    keywords: ["hello", "hi", "hey", "good morning", "good afternoon"],
    answer: "Hello! 👋 Welcome to SLY RIDES Car Rental. How can I help you today? Ask me about:\n• Booking requirements\n• Vehicle information\n• Payment & pricing\n• ID upload process"
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
              Ask me about:<br>
              • Booking requirements<br>
              • Vehicle information<br>
              • Payment & pricing<br>
              • ID upload process
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
    
    // Default response
    return "I'm here to help! You can ask me about:\n• Booking requirements and process\n• Vehicle details (Slingshot R, Camry 2012)\n• Payment information\n• ID document upload\n• Contact information\n\nOr email us at: slyservices@support-info.com";
  }
}

// Initialize chatbot when page loads
document.addEventListener('DOMContentLoaded', () => {
  new SimpleChatbot();
});
