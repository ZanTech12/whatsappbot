import "dotenv/config";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";
import QRCode from "qrcode";
import Groq from "groq-sdk";
import fs from "fs";
import os from "os";
import path from "path";

import {
  searchProducts,
  getCategories,
  getProductDetails,
  createGuestOrder,
  getOrderStatus
} from "./api.js";

// ==========================================
// CONFIGURATION
// ==========================================

const logger = P({ level: "silent" });

const AUTH_FOLDER = path.resolve(
  process.env.AUTH_FOLDER || "./auth_info_baileys"
);

const STORE_NAME =
  process.env.STORE_NAME || "Divine Solar Hub";

const STORE_OWNER_NAME =
  process.env.STORE_OWNER_NAME ||
  "Vincent Edochie Mmadukolu";

const STORE_OWNER_IMAGE = path.resolve(
  process.env.STORE_OWNER_IMAGE || "./founder.jpeg"
);

const STORE_TIMEZONE =
  process.env.STORE_TIMEZONE || "Africa/Lagos";

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Customer service contact details

const CUSTOMER_SERVICE_PHONE = "07033533320";

const CUSTOMER_SERVICE_WHATSAPP = "2347033533320";

const CUSTOMER_SERVICE_WHATSAPP_LINK =
  `https://wa.me/${CUSTOMER_SERVICE_WHATSAPP}`;

const ONLINE_STORE_URL =
  "https://shop.divinesolarhub.com";

const OFFICIAL_WEBSITE_URL =
  "https://www.solarhub.com";

const MAX_AI_HISTORY = 8;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_PDF_SIZE = 7 * 1024 * 1024;

const MIN_MESSAGE_INTERVAL = 1200;
const TYPING_MIN_MS = 700;
const TYPING_MAX_MS = 3500;
const TYPING_CHARS_PER_SECOND = 40;

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const MAX_DEDUPE_ENTRIES = 5000;

const PRODUCTS_PER_PAGE = 8;

// ==========================================
// AI AUTOMATION SETTINGS (NEW ADD-ONS)
// Every feature below is an optional add-on.
// The original store logic is untouched.
// Set any variable to "false" in your .env
// file to switch that feature off.
// ==========================================

// 1. Voice note transcription (Groq Whisper)

const AI_VOICE_ENABLED =
  process.env.AI_VOICE_ENABLED !== "false";

const GROQ_TRANSCRIBE_MODEL =
  process.env.GROQ_TRANSCRIBE_MODEL ||
  "whisper-large-v3";

const MAX_VOICE_SECONDS =
  Number(process.env.MAX_VOICE_SECONDS) || 300;

const MAX_VOICE_BYTES = 25 * 1024 * 1024;

// 2. Image recognition (Groq vision model)

const AI_VISION_ENABLED =
  process.env.AI_VISION_ENABLED !== "false";

const GROQ_VISION_MODEL =
  process.env.GROQ_VISION_MODEL ||
  "meta-llama/llama-4-scout-17b-16e-instruct";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// 3. AI-corrected search retry

const AI_SMART_SEARCH_ENABLED =
  process.env.AI_SMART_SEARCH_ENABLED !== "false";

// 4. AI category matching

const AI_CATEGORY_MATCHING_ENABLED =
  process.env.AI_CATEGORY_MATCHING_ENABLED !== "false";

// 5. AI product advisor on live product lists

const AI_PRODUCT_ADVISOR_ENABLED =
  process.env.AI_PRODUCT_ADVISOR_ENABLED !== "false";

// 6. AI order flow assistant

const AI_ORDER_ASSISTANT_ENABLED =
  process.env.AI_ORDER_ASSISTANT_ENABLED !== "false";

// 7. Post-order product suggestions

const AI_CROSS_SELL_ENABLED =
  process.env.AI_CROSS_SELL_ENABLED !== "false";

// 8. Automatic follow-up reminders

const AI_FOLLOW_UP_ENABLED =
  process.env.AI_FOLLOW_UP_ENABLED !== "false";

const AI_FOLLOW_UP_DELAY_MS =
  Number(process.env.AI_FOLLOW_UP_DELAY_MS) ||
  10 * 60 * 1000;

// ==========================================
// PERSISTENT CUSTOMER WELCOME REGISTRY
// ==========================================

const WELCOME_REGISTRY_FILE = path.join(
  AUTH_FOLDER,
  "welcomed_customers.json"
);

let welcomedCustomers = new Set();

function loadWelcomedCustomers() {
  try {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    if (!fs.existsSync(WELCOME_REGISTRY_FILE)) {
      welcomedCustomers = new Set();
      return;
    }

    const content = fs.readFileSync(
      WELCOME_REGISTRY_FILE,
      "utf8"
    );

    const saved = JSON.parse(content);

    welcomedCustomers = new Set(
      Array.isArray(saved)
        ? saved.filter(item => typeof item === "string")
        : []
    );

    console.log(
      `Loaded ${welcomedCustomers.size} previously welcomed customers.`
    );
  } catch (error) {
    console.error(
      "Welcome registry loading error:",
      error.message
    );

    welcomedCustomers = new Set();
  }
}

function saveWelcomedCustomers() {
  try {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    const temporaryFile =
      `${WELCOME_REGISTRY_FILE}.tmp`;

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify([...welcomedCustomers], null, 2),
      "utf8"
    );

    fs.renameSync(
      temporaryFile,
      WELCOME_REGISTRY_FILE
    );
  } catch (error) {
    console.error(
      "Welcome registry saving error:",
      error.message
    );
  }
}

// ==========================================
// ACCURATE JAVASCRIPT DATE AND TIME
// NIGERIA TIMEZONE: AFRICA/LAGOS
// ==========================================

function getStoreDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: STORE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = Number(part.value);
    }
  }

  return result;
}

function getTimeGreeting() {
  const { hour } = getStoreDateParts();

  if (!Number.isFinite(hour)) {
    console.error(
      "Unable to determine store hour. Using neutral greeting."
    );

    return "Hello";
  }

  if (hour >= 5 && hour < 12) {
    return "Good morning";
  }

  if (hour >= 12 && hour < 17) {
    return "Good afternoon";
  }

  if (hour >= 17 && hour < 21) {
    return "Good evening";
  }

  return "Hello";
}

function logStoreClock() {
  try {
    const {
      year,
      month,
      day,
      hour,
      minute,
      second
    } = getStoreDateParts();

    const formattedTime =
      `${String(hour).padStart(2, "0")}:` +
      `${String(minute).padStart(2, "0")}:` +
      `${String(second).padStart(2, "0")}`;

    const formattedDate =
      `${String(day).padStart(2, "0")}/` +
      `${String(month).padStart(2, "0")}/` +
      `${year}`;

    console.log("------------------------------------------");
    console.log("STORE TIME DIAGNOSTIC");
    console.log("Timezone:", STORE_TIMEZONE);
    console.log("Nigeria date:", formattedDate);
    console.log("Nigeria time:", formattedTime);
    console.log("Greeting:", getTimeGreeting());
    console.log("JavaScript UTC:", new Date().toISOString());
    console.log("------------------------------------------");

  } catch (error) {
    console.error(
      "Store clock diagnostic failed:",
      error.message
    );
  }
}

// ==========================================
// EASTER DATE CALCULATION
// ==========================================

function getEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;

  const d = Math.floor(b / 4);
  const e = b % 4;

  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);

  const h =
    (19 * a + b - d - g + 15) % 30;

  const i = Math.floor(c / 4);
  const k = c % 4;

  const l =
    (32 + 2 * e + 2 * i - h - k) % 7;

  const m =
    Math.floor((a + 11 * h + 22 * l) / 451);

  const month =
    Math.floor((h + l - 7 * m + 114) / 31);

  const day =
    ((h + l - 7 * m + 114) % 31) + 1;

  return { month, day };
}

function getEasterOccasion(year, month, day) {
  const easter = getEasterSunday(year);

  const easterDate = new Date(
    Date.UTC(year, easter.month - 1, easter.day)
  );

  const currentDate = new Date(
    Date.UTC(year, month - 1, day)
  );

  const difference = Math.round(
    (currentDate.getTime() - easterDate.getTime()) /
    86400000
  );

  const occasions = {
    "-2": {
      title: "Good Friday",
      message:
        "We wish you a peaceful and reflective Good Friday."
    },

    "-1": {
      title: "Easter Saturday",
      message:
        "Wishing you a peaceful and beautiful Easter celebration."
    },

    "0": {
      title: "Easter Sunday",
      message:
        "Happy Easter! May this season bring you renewed hope, joy and blessings."
    },

    "1": {
      title: "Easter Monday",
      message:
        "Happy Easter Monday! May the joy of this season remain with you."
    }
  };

  return occasions[String(difference)] || null;
}

// ==========================================
// SPECIAL OCCASIONS
// ==========================================

function getSpecialOccasion() {
  const { year, month, day } = getStoreDateParts();

  const easter = getEasterOccasion(
    year,
    month,
    day
  );

  if (easter) return easter;

  const occasions = {
    "1-1": {
      title: "New Year",
      message:
        "Happy New Year! We wish you success, happiness and a brighter year ahead."
    },

    "2-14": {
      title: "Valentine's Day",
      message:
        "Happy Valentine's Day! Wishing you love, happiness and wonderful moments."
    },

    "3-8": {
      title: "International Women's Day",
      message:
        "Happy International Women's Day! Today we celebrate the achievements and contributions of women."
    },

    "5-1": {
      title: "Workers' Day",
      message:
        "Happy Workers' Day! We celebrate your dedication, effort and hard work."
    },

    "5-27": {
      title: "Children's Day",
      message:
        "Happy Children's Day! Wishing every child a bright and promising future."
    },

    "6-12": {
      title: "Democracy Day",
      message:
        "Happy Democracy Day, Nigeria! Wishing our nation peace, progress and unity."
    },

    "10-1": {
      title: "Nigeria Independence Day",
      message:
        "Happy Independence Day, Nigeria! May our great nation continue to grow in peace and prosperity."
    },

    "12-24": {
      title: "Christmas Season",
      message:
        "Merry Christmas! May this festive season bring joy, peace and happiness to you and your family."
    },

    "12-25": {
      title: "Christmas Day",
      message:
        "Merry Christmas! We wish you and your family love, peace, happiness and blessings."
    },

    "12-26": {
      title: "Boxing Day",
      message:
        "Happy Boxing Day! We hope you are enjoying a wonderful festive season."
    },

    "12-31": {
      title: "New Year's Eve",
      message:
        "Thank you for being part of our journey this year. We wish you an amazing year ahead!"
    }
  };

  return occasions[`${month}-${day}`] || null;
}

// ==========================================
// FOUNDER WELCOME CAPTION
// ==========================================

function getFounderWelcomeMessage() {
  const greeting = getTimeGreeting();
  const occasion = getSpecialOccasion();

  let message =
    `${greeting}! 👋\n\n` +
    `Welcome to *${STORE_NAME}*! ☀️\n\n`;

  if (occasion) {
    message +=
      `🎉 *${occasion.title}*\n` +
      `${occasion.message}\n\n`;
  }

  message +=
    `Thank you for choosing us. We're delighted to have you here.\n\n` +
    `I'm *${STORE_OWNER_NAME}*, and we appreciate your interest in ${STORE_NAME}.\n\n` +
    `We are here to help you find quality solar energy products and electrical solutions for your needs.\n\n` +
    `How may we assist you today? 😊`;

  return message;
}

// ==========================================
// CUSTOMER SERVICE AND HUMAN SUPPORT
// ==========================================

function isCustomerServiceRequest(message) {
  const text = normalizeMessage(message);

  const patterns = [
    /\b(customer service|customer support|contact support)\b/,
    /\bspeak to (a |an )?(human|person|agent|representative|staff|someone)\b/,
    /\btalk to (a |an )?(human|person|agent|representative|staff|someone)\b/,
    /\bi want to speak to someone\b/,
    /\bi need to speak to someone\b/,
    /\bi want a human agent\b/,
    /\bconnect me to (a |an )?(human|person|agent|staff)\b/,
    /\breal person\b/,
    /\blive agent\b/,
    /\bhuman assistance\b/,
    /\bcontact your team\b/,
    /\bcontact the company\b/,
    /\bhow can i contact you\b/,
    /\bhow do i contact you\b/,
    /\bphone number\b/,
    /\bwhatsapp number\b/,
    /\bcomplaint\b/,
    /\bi want to complain\b/,
    /\bi have a problem\b/,
    /\bi have an issue\b/,
    /\bi need help from your team\b/,
    /\bi need customer care\b/,
    /\bcontact a representative\b/,
    /\bspeak with your team\b/,
    /\btalk with your team\b/,
    /\bcontact a human\b/,
    /\bcontact a person\b/
  ];

  return patterns.some(pattern => pattern.test(text));
}

function isOrderPaymentProblem(message) {
  const text = normalizeMessage(message);

  const patterns = [
    /\bpayment failed\b/,
    /\bpayment problem\b/,
    /\bpayment issue\b/,
    /\bpayment error\b/,
    /\bpayment not successful\b/,
    /\bpayment unsuccessful\b/,
    /\bunable to pay\b/,
    /\bcannot make payment\b/,
    /\bpaid but\b/,
    /\bi have paid\b/,
    /\bpayment deducted\b/,
    /\bmoney deducted\b/,
    /\bdebit(ed)? but\b/,
    /\brefund\b/,
    /\bwrong payment\b/,
    /\bdouble payment\b/,
    /\bcharged twice\b/,
    /\border problem\b/,
    /\border issue\b/,
    /\border not received\b/,
    /\bwhere is my order\b/,
    /\bdelayed delivery\b/,
    /\blate delivery\b/,
    /\bmissing item\b/,
    /\bdamaged product\b/,
    /\bwrong product delivered\b/,
    /\bcancel my order\b/,
    /\bchange my order\b/
  ];

  return patterns.some(pattern => pattern.test(text));
}

function getCustomerServiceMessage(intro = "") {
  let message = "";

  if (intro) {
    message += `${intro}\n\n`;
  }

  message +=
    `*${STORE_NAME} - CUSTOMER SERVICE* ☀️\n\n` +
    `Our customer service team is available to assist you.\n\n` +
    `📞 *Phone / WhatsApp:*\n` +
    `${CUSTOMER_SERVICE_PHONE}\n\n` +
    `💬 *Chat directly with our team:*\n` +
    `${CUSTOMER_SERVICE_WHATSAPP_LINK}\n\n` +
    `🛒 *Online Store:*\n` +
    `${ONLINE_STORE_URL}\n\n` +
    `🌐 *Website:*\n` +
    `${OFFICIAL_WEBSITE_URL}\n\n` +
    `If your enquiry concerns an order, payment, refund, delivery or product complaint, please contact our team directly and provide your order number where applicable.\n\n` +
    `Thank you for choosing ${STORE_NAME}. 😊`;

  return message;
}

async function sendCustomerServiceDetails(jid, intro = "") {
  await sendText(
    jid,
    getCustomerServiceMessage(intro)
  );
}

// ==========================================
// GROQ AI
// ==========================================

let groqClient = null;

function getGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.startsWith("gsk_")) {
    throw new Error("GROQ_API_KEY_NOT_SET");
  }

  if (!groqClient) {
    groqClient = new Groq({
      apiKey,
      timeout: 30000,
      maxRetries: 2
    });
  }

  return groqClient;
}

// ==========================================
// AI CONVERSATION MEMORY
// ==========================================

const aiHistory = new Map();

function clearAIHistory(jid) {
  aiHistory.delete(jid);
}

function getAIHistory(jid) {
  return aiHistory.get(jid) || [];
}

function saveAIHistory(jid, question, answer) {
  const history = getAIHistory(jid);

  history.push(
    {
      role: "user",
      content: String(question).slice(0, MAX_MESSAGE_LENGTH)
    },
    {
      role: "assistant",
      content: String(answer).slice(0, MAX_MESSAGE_LENGTH)
    }
  );

  aiHistory.set(
    jid,
    history.slice(-MAX_AI_HISTORY)
  );
}

// ==========================================
// GROQ SYSTEM PROMPT
// ==========================================

function getAISystemPrompt() {
  return `
You are the intelligent customer service assistant
for ${STORE_NAME}, a solar energy and electrical
products business in Nigeria.

PERSONALITY:
- Friendly, intelligent and professional.
- Natural and conversational.
- Understand Nigerian English and informal expressions.
- Be patient and helpful.
- Do not sound like a robot.
- Do not repeat greetings unnecessarily.

YOUR RESPONSIBILITIES:

1. CUSTOMER SERVICE

Answer customer questions about the store, products,
solar energy, electrical systems, installations,
renewable energy and related topics.

2. PRODUCT ENQUIRIES

Help customers explain what they need.

If a customer says:
"I need something for my house"

Ask what appliances they want to power.

If a customer says:
"I need a solar system"

Ask about their appliances, power requirements,
backup duration and budget.

If a customer gives technical requirements,
help identify the type of products they may need.

3. LIVE PRODUCT DATABASE — CRITICAL RULES

The actual product catalogue and categories are stored
in the Divine Solar Hub ecommerce database.

You MUST NOT invent, assume, guess or hardcode product
names, categories, brands, prices, descriptions or stock.

Never generate example product categories as if they
are actually available in the store.

Never create a list of products based on general
knowledge of solar shops.

The application retrieves actual categories and
products from the ecommerce database.

When a customer asks what products are available,
what the store sells, or what categories exist,
the application must use the live category API.

When a customer asks to see products, the application
must use the live product API.

If the database has no categories or products,
the application must say so.

If the database request fails, explain that the
catalogue cannot be retrieved at the moment.

Never pretend that you checked the database.

4. TECHNICAL QUESTIONS

Explain solar panels, batteries, inverters, charge
controllers, wiring, electrical protection, installations
and solar calculations in understandable language.

Ask for missing information when calculations require it.

Do not present estimates as guaranteed specifications.

5. ORDERING

When a customer wants to purchase a product,
guide them through the automated ordering process.

6. ORDER TRACKING

When a customer wants to track an order,
guide them through order tracking.

7. SECURITY

Never request passwords, payment card details or
private OTPs.

Never claim that payment has been received unless
the payment system confirms it.

Never claim an order was created without API confirmation.

Never invent delivery fees or delivery dates.

8. CUSTOMER SERVICE ESCALATION

Official customer service contact details:

Phone/WhatsApp: ${CUSTOMER_SERVICE_PHONE}

WhatsApp chat:
${CUSTOMER_SERVICE_WHATSAPP_LINK}

Online store:
${ONLINE_STORE_URL}

Website:
${OFFICIAL_WEBSITE_URL}

If a customer requests a human agent, customer care,
a representative, or a member of the store team,
direct them to the official customer service contact.

If a customer reports payment failure, money deducted
without order confirmation, refund requests, delivery
problems, damaged products, missing items, order
cancellation or other complaints, recommend contacting
the customer service team directly.

Do not claim that you have transferred the customer
to a human agent.

Do not claim that a human agent has joined the chat.

Do not invent customer service opening hours.

The application will provide official contact details
automatically when escalation is required.

WHATSAPP STYLE:
Use short paragraphs, clear explanations and natural
emojis where appropriate.

You represent ${STORE_NAME}.
`;
}

// ==========================================
// ASK GROQ
// ==========================================

async function askCustomerAI(jid, question) {
  try {
    const client = getGroqClient();
    const history = getAIHistory(jid);

    const completion =
      await client.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: getAISystemPrompt()
          },
          ...history,
          {
            role: "user",
            content: String(question).slice(
              0,
              MAX_MESSAGE_LENGTH
            )
          }
        ],
        temperature: 0.3,
        max_tokens: 1000,
        stream: false
      });

    const answer =
      completion.choices?.[0]?.message?.content?.trim() || "";

    if (!answer) {
      throw new Error("AI returned an empty response.");
    }

    saveAIHistory(jid, question, answer);

    return answer;

  } catch (error) {
    console.error("Groq AI error:", error.message);

    return (
      "I'm sorry, I'm having difficulty responding " +
      "at the moment. Please try again shortly. 😊"
    );
  }
}

// ==========================================
// AI AUTOMATION ENGINE (NEW ADD-ONS)
// The functions below only ADD intelligence.
// They never replace the original store
// logic; on any failure they fall back to
// the original behaviour.
// ==========================================

function isConversationalQuestion(message) {
  const text = String(message || "").trim();

  if (!text) return false;

  if (text.includes("?")) return true;

  if (isTechnicalQuestion(text)) return true;

  return /^(which|what|who|why|how|can|could|should|is|are|do|does|did|please|recommend|suggest|advice|advise|help me choose)\b/i.test(
    text
  );
}

function isFrustratedCustomer(message) {
  const text = normalizeMessage(message);

  const patterns = [
    /\bthis is (a )?(scam|nonsense|rubbish|fraud|joke)\b/,
    /\b(you people|your company|your store|your staff) (are|is) (useless|scammers|fraudsters|crazy|stupid|wicked)\b/,
    /\bi am (so |very )?(angry|tired|fed up|disappointed|upset)\b/,
    /\bvery (angry|disappointed|upset)\b/,
    /\buseless (service|company|store|bot|app|people)\b/,
    /\bworst (service|company|store|experience)\b/,
    /\brefund my money\b/,
    /\bscam(mers?|ming)?\b/,
    /\bfraud(sters?|ulent)?\b/,
    /\bno response (from|since|for)\b/,
    /\bhow many times (do i|must i|should i|will i)\b/,
    /\bi give up\b/
  ];

  return patterns.some(pattern => pattern.test(text));
}

async function getAISearchSuggestion(searchTerm) {
  try {
    const client = getGroqClient();

    const completion =
      await client.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `You correct product search phrases for ${STORE_NAME}, a Nigerian solar energy and electrical equipment store.

Correct the customer's search phrase for spelling mistakes, brand name spellings, spacing and product naming.

Examples:
"jinko solar pannel" -> "Jinko solar panel"
"inveter 5kva" -> "5kVA inverter"
"litum battery" -> "lithium battery"
"gel batery 220ah" -> "220Ah gel battery"
"tublar batterys" -> "tubular batteries"

RULES:
- Return ONLY the corrected search phrase.
- Maximum 6 words.
- Do not add products that were not mentioned.
- Do not answer, explain or use quotes.`
          },
          {
            role: "user",
            content: String(searchTerm).slice(
              0,
              MAX_MESSAGE_LENGTH
            )
          }
        ],
        temperature: 0,
        max_tokens: 40,
        stream: false
      });

    const suggestion =
      completion.choices?.[0]?.message?.content
        ?.trim()
        .replace(/^["']+|["']+$/g, "") || "";

    if (
      !suggestion ||
      suggestion.length > 60 ||
      suggestion.includes("\n")
    ) {
      return "";
    }

    return suggestion;

  } catch (error) {
    console.error(
      "AI search suggestion error:",
      error.message
    );

    return "";
  }
}

async function matchCategoryWithAI(text, categories) {
  try {
    const client = getGroqClient();

    const categoryList = categories
      .map(
        (category, index) =>
          `${index + 1}. ${category}`
      )
      .join("\n");

    const completion =
      await client.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `You match a customer's message to ONE product category from the official category list of ${STORE_NAME}.

OFFICIAL CATEGORIES:
${categoryList}

RULES:
- If one category clearly matches what the customer is looking for, return ONLY that category name exactly as written in the list above.
- If no category clearly matches, return ONLY: NONE
- Never invent a category that is not in the list.
- Do not explain. Return only the category name or NONE.`
          },
          {
            role: "user",
            content: String(text).slice(
              0,
              MAX_MESSAGE_LENGTH
            )
          }
        ],
        temperature: 0,
        max_tokens: 30,
        stream: false
      });

    const answer =
      completion.choices?.[0]?.message?.content
        ?.trim() || "";

    if (!answer || /^NONE$/i.test(answer)) {
      return "";
    }

    if (answer.length > 60) return "";

    const matchedCategory = categories.find(
      category =>
        category.toLowerCase() ===
        answer.toLowerCase()
    );

    return matchedCategory || "";

  } catch (error) {
    console.error(
      "AI category matching error:",
      error.message
    );

    return "";
  }
}

async function answerProductListQuestion(
  jid,
  text,
  products
) {
  try {
    if (!AI_PRODUCT_ADVISOR_ENABLED) return false;

    if (
      !Array.isArray(products) ||
      !products.length
    ) {
      return false;
    }

    if (!isConversationalQuestion(text)) return false;

    const productListText = products
      .map((product, index) => {
        const stock = Number(
          product.countInStock || 0
        );

        return (
          `${index + 1}. ${product.name} | ` +
          `${formatNaira(productPrice(product))} | ` +
          `Brand: ${product.brand || "N/A"} | ` +
          `Stock: ${stock > 0 ? stock : "Out of stock"}`
        );
      })
      .join("\n");

    const client = getGroqClient();

    const completion =
      await client.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `You are the shopping assistant for ${STORE_NAME}, a solar energy and electrical products business in Nigeria.

The customer is currently viewing this list of REAL products from the store database:

${productListText}

CRITICAL RULES:
- Recommend or discuss ONLY the products in this list.
- Never invent products, brands, prices or stock.
- If the customer asks which product is best, compare using the listed prices, brands and stock.
- Keep the answer short, friendly and in WhatsApp style with emojis where appropriate.
- To buy a product, the customer should reply with its number from the list.`
          },
          {
            role: "user",
            content: String(text).slice(
              0,
              MAX_MESSAGE_LENGTH
            )
          }
        ],
        temperature: 0.3,
        max_tokens: 500,
        stream: false
      });

    const answer =
      completion.choices?.[0]?.message?.content
        ?.trim() || "";

    if (!answer) return false;

    await sendText(jid, answer);

    return true;

  } catch (error) {
    console.error(
      "AI product advisor error:",
      error.message
    );

    return false;
  }
}

const ORDER_STAGE_CONTEXT = {
  quantity:
    "the customer must reply with the quantity they want to order",
  full_name:
    "the customer must reply with their full name for delivery",
  phone:
    "the customer must reply with their delivery phone number. For security it must match their WhatsApp number",
  address:
    "the customer must reply with their delivery street or house address",
  city:
    "the customer must reply with their city or town",
  state:
    "the customer must reply with their state in Nigeria",
  zipCode:
    "the customer must reply with their delivery postcode or ZIP code",
  order_number:
    "the customer must reply with their order number so the store can look it up",
  order_phone:
    "the customer must reply with the phone number used when placing the order they want to track"
};

function buildOrderSummaryText(state = {}) {
  const lines = [];

  if (state.product?.name) {
    lines.push(`Product: ${state.product.name}`);
  }

  if (state.quantity) {
    lines.push(`Quantity: ${state.quantity}`);
  }

  if (state.fullName) {
    lines.push(`Name: ${state.fullName}`);
  }

  if (state.address) {
    lines.push(`Address: ${state.address}`);
  }

  if (state.city) {
    lines.push(`City: ${state.city}`);
  }

  if (state.state) {
    lines.push(`State: ${state.state}`);
  }

  return lines.length
    ? lines.join("\n")
    : "No order details captured yet.";
}

async function getAIOrderFlowAnswer(
  text,
  stage,
  state
) {
  try {
    const client = getGroqClient();

    const stageRequirement =
      ORDER_STAGE_CONTEXT[stage] ||
      "the customer must continue the current step";

    const orderSummary = buildOrderSummaryText(state);

    const completion =
      await client.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `You are the automated order assistant for ${STORE_NAME}, a solar energy and electrical products business in Nigeria.

The customer is in the middle of an automated WhatsApp order or tracking flow.

Current step: ${stage}.
At this step, ${stageRequirement}.

Order details captured so far:
${orderSummary}

RULES:
- Answer the customer's question briefly, friendly and professionally.
- Use short WhatsApp-style paragraphs.
- After answering, remind the customer what to send at this step.
- Never request passwords, payment card details or private OTPs.
- Never claim that payment has been received.
- Never invent delivery fees, delivery dates or stock.
- If the question is unrelated, answer briefly and then remind them of the current step.

Return only the reply message.`
          },
          {
            role: "user",
            content: String(text).slice(
              0,
              MAX_MESSAGE_LENGTH
            )
          }
        ],
        temperature: 0.3,
        max_tokens: 400,
        stream: false
      });

    return completion.choices?.[0]?.message?.content
      ?.trim() || "";

  } catch (error) {
    console.error(
      "AI order flow assistant error:",
      error.message
    );

    return "";
  }
}

async function handleOrderFlowQuestion(
  jid,
  text,
  stage,
  state
) {
  if (!AI_ORDER_ASSISTANT_ENABLED) return false;

  if (!isConversationalQuestion(text)) return false;

  const answer = await getAIOrderFlowAnswer(
    text,
    stage,
    state
  );

  if (!answer) return false;

  console.log(
    "AI answered a mid-flow order question:",
    { stage }
  );

  await sendText(jid, answer);

  return true;
}

async function parseQuantityWithAI(text) {
  try {
    if (!AI_ORDER_ASSISTANT_ENABLED) return null;

    const clean = String(text || "").trim();

    if (!clean || clean.length > 30) return null;

    if (clean.includes("?")) return null;

    const client = getGroqClient();

    const completion =
      await client.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `Extract the quantity of items the customer wants to order from their message.

Examples:
"two" -> 2
"I need 3 pieces" -> 3
"five units please" -> 5
"one" -> 1

RULES:
- Return ONLY a whole number between 1 and 100.
- If no quantity is present, return ONLY: NONE`
          },
          {
            role: "user",
            content: clean
          }
        ],
        temperature: 0,
        max_tokens: 10,
        stream: false
      });

    const raw =
      completion.choices?.[0]?.message?.content
        ?.trim() || "";

    if (!raw || /^NONE$/i.test(raw)) return null;

    const parsed = Number(raw.replace(/[^\d]/g, ""));

    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > 100
    ) {
      return null;
    }

    return parsed;

  } catch (error) {
    console.error(
      "AI quantity parsing error:",
      error.message
    );

    return null;
  }
}

async function downloadWhatsAppMedia(message) {
  try {
    const baileys = await import(
      "@whiskeysockets/baileys"
    );

    if (
      !baileys ||
      typeof baileys.downloadMediaMessage !== "function"
    ) {
      console.error(
        "Media download is not supported by this Baileys version."
      );

      return null;
    }

    const buffer = await baileys.downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger,
        reuploadRequest:
          sock?.updateMediaMessage
      }
    );

    if (
      !Buffer.isBuffer(buffer) ||
      !buffer.length
    ) {
      return null;
    }

    return buffer;

  } catch (error) {
    console.error(
      "WhatsApp media download error:",
      error.message
    );

    return null;
  }
}

async function transcribeAudioBuffer(audioBuffer) {
  let temporaryFile = "";

  try {
    const client = getGroqClient();

    temporaryFile = path.join(
      os.tmpdir(),
      `voice-note-${Date.now()}-${Math.floor(
        Math.random() * 100000
      )}.ogg`
    );

    fs.writeFileSync(temporaryFile, audioBuffer);

    let audioFile = null;

    try {
      const groqSdk = await import("groq-sdk");

      if (typeof groqSdk.toFile === "function") {
        audioFile = await groqSdk.toFile(
          fs.createReadStream(temporaryFile),
          "voice-note.ogg",
          { type: "audio/ogg" }
        );
      }
    } catch (error) {
      audioFile = null;
    }

    if (!audioFile) {
      audioFile = fs.createReadStream(temporaryFile);
    }

    const transcription =
      await client.audio.transcriptions.create({
        model: GROQ_TRANSCRIBE_MODEL,
        file: audioFile
      });

    return String(
      transcription?.text || ""
    ).trim();

  } catch (error) {
    console.error(
      "Groq voice transcription error:",
      error.message
    );

    return "";

  } finally {
    if (temporaryFile) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch (error) {}
    }
  }
}

async function describeImageEnquiry(imageBuffer) {
  try {
    const client = getGroqClient();

    const base64Image =
      imageBuffer.toString("base64");

    const completion =
      await client.chat.completions.create({
        model: GROQ_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `You identify products in images for ${STORE_NAME}, a solar energy and electrical equipment store in Nigeria.

Look at the image and identify the main product or equipment visible.

Reply with ONLY a short product search phrase of at most 5 words describing it for a solar and electrical equipment store.

Examples:
"5kVA inverter"
"100Ah lithium battery"
"400W monocrystalline solar panel"
"solar charge controller"

If the image does not clearly show a product or equipment, reply with only: UNSURE`
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        temperature: 0.2,
        max_tokens: 300,
        stream: false
      });

    return completion.choices?.[0]?.message?.content
      ?.trim() || "";

  } catch (error) {
    console.error(
      "Groq vision error:",
      error.message
    );

    return "";
  }
}

async function extractTextFromMedia(message, jid) {
  try {
    if (!isConnected()) return "";

    const content = message?.message;

    if (!content) return "";

    // 1. VOICE NOTES AND AUDIO MESSAGES

    if (content.audioMessage) {
      if (!AI_VOICE_ENABLED) return "";

      const seconds = Number(
        content.audioMessage.seconds || 0
      );

      if (seconds > MAX_VOICE_SECONDS) {
        console.log(
          "Voice note ignored: too long.",
          seconds,
          "seconds."
        );

        try {
          await sendText(
            jid,
            "I received your voice note, but it is too long for me to listen to. 🎙️\n\nPlease send a shorter voice note, or simply type your message and I will respond immediately. 😊"
          );
        } catch (error) {}

        return "";
      }

      console.log(
        "AI voice note received. Transcribing with Groq Whisper..."
      );

      const audioBuffer =
        await downloadWhatsAppMedia(message);

      if (!audioBuffer) {
        try {
          await sendText(
            jid,
            "I received your voice note but couldn't download it. 🎙️\n\nPlease try sending it again, or type your message instead. 😊"
          );
        } catch (error) {}

        return "";
      }

      if (audioBuffer.length > MAX_VOICE_BYTES) {
        try {
          await sendText(
            jid,
            "I received your voice note, but the file is too large for me to listen to. 🎙️\n\nPlease type your message instead. 😊"
          );
        } catch (error) {}

        return "";
      }

      const transcript =
        await transcribeAudioBuffer(audioBuffer);

      if (!transcript) {
        try {
          await sendText(
            jid,
            "I received your voice note but couldn't understand it clearly. 🎙️\n\nPlease try sending it again, or type your message and I will respond immediately. 😊"
          );
        } catch (error) {}

        return "";
      }

      console.log(
        "Voice note transcription:",
        transcript
      );

      return transcript;
    }

    // 2. IMAGES WITHOUT CAPTION (AI VISION)

    if (content.imageMessage) {
      if (!AI_VISION_ENABLED) return "";

      console.log(
        "AI image received. Identifying the product with Groq vision..."
      );

      const imageBuffer =
        await downloadWhatsAppMedia(message);

      if (!imageBuffer) {
        try {
          await sendText(
            jid,
            "I received your image but couldn't open it. 📷\n\nPlease try sending it again, or tell me what you're looking for. 😊"
          );
        } catch (error) {}

        return "";
      }

      if (imageBuffer.length > MAX_IMAGE_BYTES) {
        try {
          await sendText(
            jid,
            "I received your image, but the file is too large for me to view. 📷\n\nPlease send a smaller image or tell me what you're looking for. 😊"
          );
        } catch (error) {}

        return "";
      }

      const enquiry =
        await describeImageEnquiry(imageBuffer);

      if (!enquiry || /^UNSURE$/i.test(enquiry)) {
        try {
          await sendText(
            jid,
            "I received your image but couldn't identify a product in it clearly. 📷\n\nCould you tell me what you're looking for? You can also type MENU to browse our store. 😊"
          );
        } catch (error) {}

        return "";
      }

      console.log(
        "AI image enquiry:",
        enquiry
      );

      return enquiry;
    }

    return "";

  } catch (error) {
    console.error(
      "AI media processing error:",
      error.message
    );

    return "";
  }
}

async function sendRelatedProductSuggestions(
  jid,
  orderedProduct
) {
  try {
    if (!AI_CROSS_SELL_ENABLED) return;

    const category = String(
      orderedProduct?.category || ""
    ).trim();

    if (!category) return;

    const result = await searchProducts(
      "",
      1,
      6,
      category
    );

    if (!result || result.success !== true) return;

    const products = getProducts(result)
      .filter(
        product =>
          String(product._id) !==
          String(orderedProduct._id)
      )
      .slice(0, 2);

    if (!products.length) return;

    let message =
      `🛍️ *YOU MAY ALSO NEED* ☀️\n\n` +
      `Customers often complete their ${category} setup with these products from our store:\n\n`;

    products.forEach((product, index) => {
      message +=
        `${index + 1}. *${product.name}* - ${formatNaira(productPrice(product))}\n`;
    });

    message +=
      `\nType MENU to browse more products, or ask me anything about them. 😊`;

    await sendText(jid, message);

    console.log(
      "Post-order product suggestions sent:",
      {
        category,
        count: products.length
      }
    );

  } catch (error) {
    console.error(
      "Post-order suggestion error:",
      error.message
    );
  }
}

const FOLLOW_UP_STAGES = new Set([
  "search",
  "select_category",
  "select_product",
  "quantity",
  "full_name",
  "phone",
  "address",
  "city",
  "state",
  "zipCode",
  "order_number",
  "order_phone"
]);

const FOLLOW_UP_MESSAGES = {
  search:
    "Just checking in 😊 Which product would you like me to look up in our store? You can also type MENU to see all options.",
  select_category:
    "Just checking in 😊 Reply with a category number whenever you are ready, or type MENU.",
  select_product:
    "Just checking in 😊 Reply with the product number you are interested in whenever you are ready, or type MENU.",
  quantity:
    "Just checking in 😊 Reply with the quantity you would like to order whenever you are ready, or type MENU to stop.",
  full_name:
    "Just checking in 😊 Reply with your full name whenever you are ready to continue your order.",
  phone:
    "Just checking in 😊 Reply with your WhatsApp number whenever you are ready to continue your order.",
  address:
    "Just checking in 😊 Reply with your delivery address whenever you are ready to continue your order.",
  city:
    "Just checking in 😊 Which city or town should we deliver your order to?",
  state:
    "Just checking in 😊 Which state in Nigeria should we deliver your order to?",
  zipCode:
    "Just checking in 😊 Reply with your postcode or ZIP code to complete your order.",
  order_number:
    "Just checking in 😊 Reply with your order number whenever you are ready, and I will check it for you.",
  order_phone:
    "Just checking in 😊 Reply with the phone number used for your order, and I will check the status for you."
};

const followUpTimers = new Map();

function clearFollowUpTimer(jid) {
  const timer = followUpTimers.get(jid);

  if (timer) {
    clearTimeout(timer);
    followUpTimers.delete(jid);
  }
}

function getFollowUpMessage(stage) {
  return FOLLOW_UP_MESSAGES[stage] || null;
}

function scheduleFollowUp(jid, stage) {
  if (!AI_FOLLOW_UP_ENABLED) return;

  if (!FOLLOW_UP_STAGES.has(stage)) return;

  clearFollowUpTimer(jid);

  const timer = setTimeout(async () => {
    followUpTimers.delete(jid);

    try {
      if (!isConnected()) return;

      const state = conversations.get(jid) || {};

      if (state.stage !== stage) return;

      const message = getFollowUpMessage(stage);

      if (!message) return;

      console.log(
        "AI follow-up reminder sent:",
        { jid, stage }
      );

      await sendText(jid, message);

    } catch (error) {
      console.error(
        "AI follow-up error:",
        error.message
      );
    }
  }, AI_FOLLOW_UP_DELAY_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  followUpTimers.set(jid, timer);
}

export function getAIAutomationStatus() {
  return {
    voiceTranscription: AI_VOICE_ENABLED,
    visionEnquiries: AI_VISION_ENABLED,
    smartSearchCorrection: AI_SMART_SEARCH_ENABLED,
    aiCategoryMatching: AI_CATEGORY_MATCHING_ENABLED,
    productAdvisor: AI_PRODUCT_ADVISOR_ENABLED,
    orderFlowAssistant: AI_ORDER_ASSISTANT_ENABLED,
    postOrderSuggestions: AI_CROSS_SELL_ENABLED,
    followUpReminders: AI_FOLLOW_UP_ENABLED,
    followUpDelayMinutes: Math.round(
      AI_FOLLOW_UP_DELAY_MS / 60000
    ),
    groqModel: GROQ_MODEL,
    transcriptionModel: GROQ_TRANSCRIBE_MODEL,
    visionModel: GROQ_VISION_MODEL,
    activeAIConversations: aiHistory.size,
    scheduledFollowUps: followUpTimers.size
  };
}

// ==========================================
// MESSAGE NORMALIZATION
// ==========================================

function normalizeMessage(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/[?!.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ==========================================
// CATEGORY BROWSING DETECTION
// ==========================================

function isCategoryBrowseRequest(message) {
  const text = normalizeMessage(message);

  const patterns = [
    /\bwhat products can i get\b/,
    /\bwhat products can i get here\b/,
    /\bwhat can i get here\b/,
    /\bwhat can i buy here\b/,
    /\bwhat products do you have\b/,
    /\bwhat products do you have here\b/,
    /\bwhat products are in your store\b/,
    /\bwhat products are available\b/,
    /\bwhat products are available here\b/,
    /\bwhat do you have in your store\b/,
    /\bwhat do you have here\b/,
    /\bwhat do you sell\b/,
    /\bwhat can i buy from you\b/,
    /\bwhat items do you sell\b/,
    /\bwhat items are available\b/,
    /\bwhat is available in your store\b/,
    /\bwhat is available here\b/,
    /\bwhat do you offer\b/,
    /\bwhat can your store offer\b/,
    /\bwhat can i get from your shop\b/,
    /\btell me what products you have\b/,
    /\bwhat products are in this store\b/,
    /\bso what products can i get here\b/,
    /\bthe products in (this|your|the) store\b/,
    /\bproducts in (this|your|the) store\b/,
    /\bproducts available in (this|your|the) store\b/,
    /\bshow me (all |every )?(your )?categories\b/,
    /\bshow (all |every )?(the )?(product )?categories\b/,
    /\blist (all |every )?(the )?(product )?categories\b/,
    /\bdisplay (all |every )?(the )?(product )?categories\b/,
    /\bwhat categories do you have\b/,
    /\bwhich categories do you have\b/,
    /\ball product categories\b/,
    /\bevery product category\b/,
    /\bproduct categories\b/,
    /\bbrowse by categor(y|ies)\b/,
    /\bcategory list\b/,
    /\bavailable categories\b/,
    /\btypes of products (available|do you have)\b/,
    /\bwhat types of products\b/,
    /\bi want to explore your products\b/,
    /\bi want to browse your products\b/,
    /\bthe products available here\b/,
    /\bshow me your products and categories\b/,
    /\bi want to see the products here\b/
  ];

  return patterns.some(pattern => pattern.test(text));
}

// ==========================================
// GENERAL STORE INVENTORY DETECTION
// ==========================================

function isStoreInventoryQuestion(message) {
  const text = normalizeMessage(message);

  const inventoryWords =
    /\b(products?|items?|goods|stock|inventory|selling|available|availability|store|shop|catalog|catalogue)\b/i;

  const questionWords =
    /\b(what|which|show|list|see|view|browse|buy|offer|carry|available)\b/i;

  return (
    inventoryWords.test(text) &&
    questionWords.test(text)
  );
}

// ==========================================
// FULL PRODUCT CATALOGUE DETECTION
// ==========================================

function isCatalogBrowseRequest(message) {
  const text = normalizeMessage(message);

  const patterns = [
    /\bshow (me )?(all|every) (the )?products\b/,
    /\blist (all|every) (the )?products\b/,
    /\bdisplay (all|every) (the )?products\b/,
    /\bview (all|every) (the )?products\b/,
    /\bsee (all|every) (the )?products\b/,
    /\bbrowse (all|every) (the )?products\b/,
    /\ball products\b/,
    /\bevery product\b/,
    /\bfull product catalog(ue)?\b/,
    /\bproduct catalog(ue)\b/,
    /\bshow me everything\b/,
    /\bshow everything in the store\b/,
    /\bi want to see all products\b/,
    /\bshow me all the items\b/,
    /\bsee everything you have\b/
  ];

  return patterns.some(pattern => pattern.test(text));
}

// ==========================================
// GREETING DETECTION
// ==========================================

function isGreetingOrAcknowledgement(message) {
  const text = normalizeMessage(message);

  return /^(hi|hello|hey|hey there|hi there|hello there|good morning|good afternoon|good evening|how far|how are you|what is up|whats up|okay|ok|alright|all right|yes|no|sure|thanks|thank you|thank you so much|thanks a lot|cool|nice|great|good|fine|understood|i understand|no problem|perfect)$/.test(text);
}

// ==========================================
// TECHNICAL QUESTION DETECTION
// ==========================================

function isTechnicalQuestion(message) {
  return /^(how does|how do|why does|why do|what is|what are|explain|tell me about|can you explain|what causes|what happens when|difference between|what is the difference between)\b/i.test(
    String(message || "").trim()
  );
}

// ==========================================
// EXPLICIT PRODUCT SEARCH DETECTION
// ==========================================

function isExplicitProductRequest(message) {
  const text = String(message || "").trim();

  if (isCategoryBrowseRequest(text)) return false;
  if (isStoreInventoryQuestion(text)) return false;
  if (isCatalogBrowseRequest(text)) return false;

  return /\b(do you have|have you got|do you sell|i want to buy|i want|i need|looking for|show me|find me|search for|how much is|how much does|what is the price|what's the price|price of|available for sale|in stock|buy|purchase|order|product price|check availability)\b/i.test(text);
}

// ==========================================
// SIMPLE PRODUCT SEARCH DETECTION
// ==========================================

function shouldTryCatalogSearch(message) {
  const text = String(message || "").trim();

  if (!text) return false;

  if (isCategoryBrowseRequest(text)) return false;
  if (isStoreInventoryQuestion(text)) return false;
  if (isCatalogBrowseRequest(text)) return false;
  if (isGreetingOrAcknowledgement(text)) return false;
  if (isTechnicalQuestion(text)) return false;
  if (isCustomerServiceRequest(text)) return false;
  if (isOrderPaymentProblem(text)) return false;

  const words = text.split(/\s+/).filter(Boolean);

  return (
    words.length >= 1 &&
    words.length <= 5 &&
    !/[?!]/.test(text)
  );
}

// ==========================================
// EXTRACT PRODUCT SEARCH TERM
// ==========================================

function extractProductSearchTerm(message = "") {
  let search = String(message || "").trim();

  if (
    isCategoryBrowseRequest(search) ||
    isStoreInventoryQuestion(search) ||
    isCatalogBrowseRequest(search)
  ) {
    return "";
  }

  const prefixes = [
    /^(please\s+)?(can you\s+)?(could you\s+)?(show|find|search|list|get|display)\s+(me\s+)?/i,
    /^(please\s+)?(do you have|have you got|do you sell)\s+/i,
    /^(please\s+)?(i want|i need|i would like|i'm looking for|i am looking for|looking for)\s+(to\s+)?(see|view|browse|check)\s+/i,
    /^(please\s+)?(i want|i need|i would like|i am looking for|i'm looking for|looking for)\s+/i,
    /^(please\s+)?(what is the price of|what's the price of|how much is|how much does)\s+/i,
    /^(please\s+)?(buy|purchase|order)\s+/i,
    /^(please\s+)?(price of|availability of)\s+/i
  ];

  for (const prefix of prefixes) {
    search = search.replace(prefix, "");
  }

  return search
    .replace(/[?!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ==========================================
// AI INTENT CLASSIFICATION
// ==========================================

function fallbackIntent(message) {
  const text = normalizeMessage(message);

  if (isCustomerServiceRequest(text)) {
    return "SUPPORT";
  }

  if (isOrderPaymentProblem(text)) {
    return "SUPPORT";
  }

  if (isCategoryBrowseRequest(text)) return "CATEGORY";
  if (isStoreInventoryQuestion(text)) return "CATEGORY";
  if (isCatalogBrowseRequest(text)) return "CATALOG";

  if (isGreetingOrAcknowledgement(text)) {
    return "GREETING";
  }

  if (
    /\b(track|tracking|order status|where is my order|my order|check my order)\b/i.test(text)
  ) {
    return "TRACKING";
  }

  if (isExplicitProductRequest(text)) {
    return "PRODUCT";
  }

  if (shouldTryCatalogSearch(text)) {
    return "PRODUCT";
  }

  return "QUESTION";
}

async function detectMessageIntent(message) {
  try {
    const client = getGroqClient();

    const completion =
      await client.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: `
You are an intent classifier for ${STORE_NAME}.

Return exactly one of these labels:

GREETING
CATEGORY
CATALOG
PRODUCT
TRACKING
SUPPORT
QUESTION

CATEGORY:
The customer wants to know what the store sells or
wants to see the store's product categories.

Examples:
"The products in this store"
"What do you sell?"
"What categories do you have?"
"Show me all categories"
"List your product categories"
"What products are available in your store?"
"What products can I get here?"
"So what products can I get here?"
"What can I buy here?"
"What do you have in your store?"
"What items are available here?"

CATALOG:
The customer explicitly wants to see all actual products.

Examples:
"Show me all products"
"List every product"
"Browse the full catalogue"

PRODUCT:
The customer wants to search for, buy, compare or
check the price or availability of a specific product.

Examples:
"Do you have Jinko?"
"I need a 5kVA inverter"
"How much is a solar panel?"
"Show me batteries"

TRACKING:
The customer wants to track an existing order.

SUPPORT:
The customer needs customer service, a human agent,
help with an order, payment, refund, delivery,
complaint or other issue requiring store assistance.

Examples:
"I want to speak to a human."
"Connect me to customer care."
"I have a payment problem."
"I paid but my order was not confirmed."
"My money was deducted."
"I want a refund."
"My order has not arrived."
"I received a damaged product."
"I want to make a complaint."
"Give me your WhatsApp number."

GREETING:
Greetings and simple acknowledgements.

QUESTION:
Technical questions, general enquiries, vague requests
and anything that does not fit the other categories.

IMPORTANT:
A technical question about how a product works is
QUESTION, not PRODUCT.

"The products in this store" is CATEGORY, not PRODUCT.

"What products can I get here?" is CATEGORY.

Return only the label.
`
          },
          {
            role: "user",
            content: String(message).slice(
              0,
              MAX_MESSAGE_LENGTH
            )
          }
        ],
        temperature: 0,
        max_tokens: 20
      });

    const intent =
      completion.choices?.[0]?.message?.content
        ?.trim()
        .toUpperCase()
        .replace(/[^A-Z_]/g, "");

    const allowed = [
      "GREETING",
      "CATEGORY",
      "CATALOG",
      "PRODUCT",
      "TRACKING",
      "SUPPORT",
      "QUESTION"
    ];

    return allowed.includes(intent)
      ? intent
      : fallbackIntent(message);

  } catch (error) {
    console.error(
      "AI intent detection error:",
      error.message
    );

    return fallbackIntent(message);
  }
}

// ==========================================
// WHATSAPP STATE
// ==========================================

let sock = null;
let authState = null;

let currentQR = null;
let pairingCode = null;

let connectionStatus = "disconnected";

let pendingPairingNumber = null;
let pairingRequested = false;
let qrEventReady = false;

let starting = false;
let reconnectTimer = null;

const conversations = new Map();

const sendQueues = new Map();
const lastMessageSent = new Map();

const incomingQueues = new Map();
const processedMessages = new Map();

// ==========================================
// GENERAL UTILITIES
// ==========================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isConnected() {
  return Boolean(
    sock && connectionStatus === "connected"
  );
}

function getTypingDuration(message) {
  const length = String(message || "").length;

  const calculated =
    (length / TYPING_CHARS_PER_SECOND) * 1000;

  return Math.min(
    TYPING_MAX_MS,
    Math.max(TYPING_MIN_MS, calculated)
  );
}

function formatNaira(amount) {
  const numericAmount = Number(amount || 0);

  return `₦${Number.isFinite(numericAmount)
    ? numericAmount.toLocaleString("en-NG")
    : "0"}`;
}

function normalizePhone(phone) {
  let number = String(phone || "").replace(/\D/g, "");

  if (number.startsWith("0") && number.length === 11) {
    number = `234${number.slice(1)}`;
  }

  return number;
}

function getWhatsAppPhone(jid) {
  const rawNumber = String(jid || "").split("@")[0];

  return normalizePhone(rawNumber);
}

function getText(message) {
  const content = message?.message;

  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.buttonsResponseMessage?.selectedButtonId ||
    content?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content?.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

// ==========================================
// PUBLIC STATUS
// ==========================================

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    qrAvailable: Boolean(currentQR),
    pairingCode,
    pairingRequested: Boolean(pendingPairingNumber),
    authFolder: AUTH_FOLDER
  };
}

export function getCurrentQR() {
  return currentQR;
}

// ==========================================
// OUTGOING MESSAGE QUEUE
// ==========================================

async function sendTextNow(jid, message) {
  if (!isConnected()) {
    throw new Error("WhatsApp service is not connected.");
  }

  const text = String(message || "").trim();

  if (!text) return;

  const previousSent = lastMessageSent.get(jid) || 0;

  const remainingDelay =
    MIN_MESSAGE_INTERVAL - (Date.now() - previousSent);

  if (remainingDelay > 0) {
    await sleep(remainingDelay);
  }

  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch (error) {}

  await sleep(getTypingDuration(text));

  if (!isConnected()) {
    throw new Error("WhatsApp disconnected before sending.");
  }

  try {
    await sock.sendMessage(jid, { text });
    lastMessageSent.set(jid, Date.now());
  } finally {
    try {
      if (sock) {
        await sock.sendPresenceUpdate("paused", jid);
      }
    } catch (error) {}
  }
}

function sendText(jid, message) {
  const previousTask =
    sendQueues.get(jid) || Promise.resolve();

  const currentTask = previousTask
    .catch(() => {})
    .then(() => sendTextNow(jid, message));

  sendQueues.set(jid, currentTask);

  return currentTask.finally(() => {
    if (sendQueues.get(jid) === currentTask) {
      sendQueues.delete(jid);
    }
  });
}

function sendDocument(jid, document) {
  const previousTask =
    sendQueues.get(jid) || Promise.resolve();

  const currentTask = previousTask
    .catch(() => {})
    .then(async () => {
      if (!isConnected()) {
        throw new Error("WhatsApp service is not connected.");
      }

      try {
        await sock.sendPresenceUpdate("composing", jid);
      } catch (error) {}

      await sleep(1000);

      await sock.sendMessage(jid, document);

      lastMessageSent.set(jid, Date.now());
    });

  sendQueues.set(jid, currentTask);

  return currentTask.finally(() => {
    if (sendQueues.get(jid) === currentTask) {
      sendQueues.delete(jid);
    }
  });
}

// ==========================================
// FOUNDER WELCOME SENDER
// ==========================================

async function sendFounderWelcome(jid) {
  if (welcomedCustomers.has(jid)) {
    return false;
  }

  const caption = getFounderWelcomeMessage();

  try {
    if (!fs.existsSync(STORE_OWNER_IMAGE)) {
      throw new Error(
        `Founder image not found: ${STORE_OWNER_IMAGE}`
      );
    }

    const imageStats = await fs.promises.stat(
      STORE_OWNER_IMAGE
    );

    if (!imageStats.isFile() || imageStats.size === 0) {
      throw new Error("Founder image is invalid or empty.");
    }

    if (imageStats.size > 10 * 1024 * 1024) {
      throw new Error("Founder image exceeds the 10MB limit.");
    }

    if (!isConnected()) {
      throw new Error("WhatsApp is disconnected.");
    }

    const imageBuffer = await fs.promises.readFile(
      STORE_OWNER_IMAGE
    );

    const previousTask =
      sendQueues.get(jid) || Promise.resolve();

    const currentTask = previousTask
      .catch(() => {})
      .then(async () => {
        if (!isConnected()) {
          throw new Error("WhatsApp is disconnected.");
        }

        try {
          await sock.sendPresenceUpdate("composing", jid);
        } catch (error) {}

        await sleep(1000);

        await sock.sendMessage(jid, {
          image: imageBuffer,
          caption
        });

        lastMessageSent.set(jid, Date.now());
      });

    sendQueues.set(jid, currentTask);

    try {
      await currentTask;
    } finally {
      if (sendQueues.get(jid) === currentTask) {
        sendQueues.delete(jid);
      }
    }

    welcomedCustomers.add(jid);
    saveWelcomedCustomers();

    console.log(
      "Founder welcome photo sent successfully."
    );

    return true;

  } catch (error) {
    console.error(
      "Founder welcome photo error:",
      error.message
    );

    try {
      await sendText(jid, caption);

      welcomedCustomers.add(jid);
      saveWelcomedCustomers();

      console.log(
        "Founder welcome sent as text fallback."
      );

      return true;

    } catch (textError) {
      console.error(
        "Founder text welcome failed:",
        textError.message
      );

      return false;
    }
  }
}

// ==========================================
// DUPLICATE MESSAGE PROTECTION
// ==========================================

function cleanProcessedMessages() {
  const now = Date.now();

  for (const [id, timestamp] of processedMessages.entries()) {
    if (now - timestamp > DEDUPE_TTL_MS) {
      processedMessages.delete(id);
    }
  }

  while (processedMessages.size > MAX_DEDUPE_ENTRIES) {
    const oldestKey =
      processedMessages.keys().next().value;

    if (!oldestKey) break;

    processedMessages.delete(oldestKey);
  }
}

function isDuplicateMessage(message) {
  const messageId = message?.key?.id;

  if (!messageId) return false;

  cleanProcessedMessages();

  if (processedMessages.has(messageId)) {
    return true;
  }

  processedMessages.set(messageId, Date.now());

  return false;
}

// ==========================================
// INCOMING MESSAGE QUEUE
// ==========================================

function queueIncomingMessage(jid, task) {
  const previousTask =
    incomingQueues.get(jid) || Promise.resolve();

  const currentTask = previousTask
    .catch(() => {})
    .then(task);

  incomingQueues.set(jid, currentTask);

  return currentTask.finally(() => {
    if (incomingQueues.get(jid) === currentTask) {
      incomingQueues.delete(jid);
    }
  });
}

// ==========================================
// SEND WHATSAPP OTP
// ==========================================

export async function sendWhatsAppOTP(
  phone,
  otp,
  name = "Customer"
) {
  if (!isConnected()) {
    throw new Error("WhatsApp service is not connected.");
  }

  const number = normalizePhone(phone);

  if (number.length < 10 || number.length > 15) {
    throw new Error("Invalid WhatsApp phone number.");
  }

  if (!/^\d{6}$/.test(String(otp))) {
    throw new Error("Invalid OTP format.");
  }

  const safeName = String(name || "Customer")
    .replace(/[\r\n]/g, " ")
    .trim()
    .slice(0, 80);

  const message =
    `*${STORE_NAME} - ACCOUNT VERIFICATION*\n\n` +
    `Hello ${safeName},\n\n` +
    `Your account verification code is:\n\n` +
    `*${otp}*\n\n` +
    `This code expires in 10 minutes.\n\n` +
    `Do not share this code with anyone.\n\n` +
    `If you did not request this code, please ignore this message.\n\n` +
    `Thank you for choosing ${STORE_NAME}.`;

  await sendText(`${number}@s.whatsapp.net`, message);

  console.log("WhatsApp verification message sent.");

  return { success: true };
}

// ==========================================
// SEND NOTIFICATION AND OPTIONAL PDF
// ==========================================

export async function sendWhatsAppNotification(
  phone,
  message,
  pdfBuffer = null,
  fileName = "Divine-Solar-Hub-Receipt.pdf"
) {
  if (!isConnected()) {
    throw new Error("WhatsApp service is not connected.");
  }

  const number = normalizePhone(phone);

  if (number.length < 10 || number.length > 15) {
    throw new Error("Invalid WhatsApp recipient phone number.");
  }

  if (
    typeof message !== "string" ||
    !message.trim()
  ) {
    throw new Error("WhatsApp notification message is required.");
  }

  if (message.length > 10000) {
    throw new Error("WhatsApp notification message is too long.");
  }

  const jid = `${number}@s.whatsapp.net`;

  await sendText(jid, message.trim());

  console.log("WhatsApp notification message sent.");

  if (pdfBuffer !== null && pdfBuffer !== undefined) {
    if (!Buffer.isBuffer(pdfBuffer)) {
      throw new Error("PDF receipt must be supplied as a Buffer.");
    }

    if (
      !pdfBuffer.length ||
      pdfBuffer.length > MAX_PDF_SIZE
    ) {
      throw new Error("PDF receipt is empty or exceeds the 7MB limit.");
    }

    if (pdfBuffer.subarray(0, 5).toString() !== "%PDF-") {
      throw new Error("Invalid PDF receipt file.");
    }

    let safeFileName =
      String(fileName || "Divine-Solar-Hub-Receipt.pdf")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 100);

    if (!safeFileName.toLowerCase().endsWith(".pdf")) {
      safeFileName += ".pdf";
    }

    await sendDocument(jid, {
      document: pdfBuffer,
      mimetype: "application/pdf",
      fileName: safeFileName,
      caption: "Your Divine Solar Hub PDF receipt."
    });

    console.log("WhatsApp PDF receipt sent.");
  }

  return {
    success: true,
    messageSent: true,
    receiptSent: Boolean(pdfBuffer)
  };
}

// ==========================================
// PRODUCT API VALIDATION
// ==========================================

function getProducts(data) {
  if (
    !data ||
    data.success !== true ||
    !Array.isArray(data.products)
  ) {
    console.error(
      "Invalid product API response:",
      JSON.stringify(data).slice(0, 2000)
    );

    return [];
  }

  return data.products.filter(product =>
    product &&
    typeof product === "object" &&
    !Array.isArray(product) &&
    product._id &&
    typeof product.name === "string" &&
    product.name.trim() &&
    Number.isFinite(Number(product.price))
  );
}

function getCategoriesList(data) {
  if (
    !data ||
    data.success !== true ||
    !Array.isArray(data.categories)
  ) {
    console.error(
      "Invalid categories API response:",
      JSON.stringify(data).slice(0, 2000)
    );

    return [];
  }

  const names = data.categories
    .map(item => {
      if (typeof item === "string") {
        return item.trim();
      }

      if (item && typeof item === "object") {
        return String(
          item.name ||
          item.category ||
          item.title ||
          ""
        ).trim();
      }

      return "";
    })
    .filter(Boolean);

  return [
    ...new Map(
      names.map(name => [name.toLowerCase(), name])
    ).values()
  ];
}

function productPrice(product) {
  const price = Number(product.price);

  return Number.isFinite(price) ? price : 0;
}

function productOriginalPrice(product) {
  const originalPrice = Number(product.originalPrice);

  return Number.isFinite(originalPrice)
    ? originalPrice
    : productPrice(product);
}

// ==========================================
// BROWSE CATEGORIES FROM DATABASE
// ==========================================

async function showCategories(jid) {
  const state = conversations.get(jid) || {};

  state.stage = "loading_categories";
  state.categories = [];

  conversations.set(jid, state);

  try {
    console.log(
      "Fetching categories directly from ecommerce database."
    );

    const result = await getCategories();

    console.log(
      "Raw categories API response:",
      JSON.stringify(result).slice(0, 5000)
    );

    if (!result || result.success !== true) {
      throw new Error(
        result?.message || "Category API request failed."
      );
    }

    const categories = getCategoriesList(result);

    console.log(
      "Categories received from database:",
      categories
    );

    if (!categories.length) {
      state.stage = "browse_empty";
      state.categories = [];

      conversations.set(jid, state);

      await sendText(
        jid,
        "I checked our store database, but there are currently no active product categories available. Please try browsing again later."
      );

      return;
    }

    state.categories = categories;
    state.stage = "select_category";

    conversations.set(jid, state);

    let response =
      `*${STORE_NAME} - ALL PRODUCT CATEGORIES* ☀️\n\n` +
      "Here are the product categories currently available in our store:\n\n";

    categories.forEach((category, index) => {
      response += `${index + 1}. ${category}\n`;
    });

    response +=
      "\nReply with a category number to view its products.\n\n" +
      "You can also type a category name directly.\n" +
      "Type *ALL PRODUCTS* to view the complete catalogue.\n" +
      "Type *MENU* to return to the main menu.";

    await sendText(jid, response);

  } catch (error) {
    console.error(
      "Category retrieval error:",
      error.message
    );

    state.stage = "browse_empty";
    state.categories = [];

    conversations.set(jid, state);

    await sendText(
      jid,
      "Sorry, I couldn't retrieve product categories from our store database right now. Please try again shortly."
    );
  }
}

// ==========================================
// DISPLAY PRODUCTS FROM DATABASE
// ==========================================

async function showProducts(
  jid,
  search = "",
  page = 1,
  category = "",
  isAIRetry = false
) {
  const state = conversations.get(jid) || {};

  const searchTerm = String(search || "").trim();

  state.products = [];
  state.product = null;
  state.stage = "loading_products";

  conversations.set(jid, state);

  try {
    console.log("Fetching products:", {
      search: searchTerm,
      category,
      page,
      limit: PRODUCTS_PER_PAGE
    });

    const result = await searchProducts(
      searchTerm,
      page,
      PRODUCTS_PER_PAGE,
      category
    );

    if (!result || result.success !== true) {
      throw new Error(
        result?.message || "Product API request failed."
      );
    }

    const products = getProducts(result);

    console.log(
      "Database products returned:",
      products.map(product => ({
        id: String(product._id),
        name: product.name,
        category: product.category,
        brand: product.brand,
        sku: product.sku,
        price: product.price,
        stock: product.countInStock
      }))
    );

    if (!products.length) {
      // AI ENHANCEMENT: one automatic AI-corrected
      // retry when a search returns no products
      // (fixes spelling and brand name mistakes)

      if (
        searchTerm &&
        !isAIRetry &&
        AI_SMART_SEARCH_ENABLED
      ) {
        const suggestion =
          await getAISearchSuggestion(searchTerm);

        if (
          suggestion &&
          suggestion.toLowerCase() !==
          searchTerm.toLowerCase()
        ) {
          console.log(
            "AI corrected product search:",
            {
              original: searchTerm,
              corrected: suggestion
            }
          );

          await showProducts(
            jid,
            suggestion,
            page,
            category,
            true
          );

          return;
        }
      }

      state.products = [];
      state.stage = "browse_empty";

      conversations.set(jid, state);

      if (category) {
        await sendText(
          jid,
          `There are currently no active products listed under *${category}*.\n\nI'll show you the other available categories.`
        );

      } else if (searchTerm) {
        await sendText(
          jid,
          `I couldn't find a matching product for "${searchTerm}" in our database. 😊\n\nLet me show you the available product categories so you can choose what you're looking for.`
        );

      } else {
        await sendText(
          jid,
          "There are currently no active products available in our store."
        );
      }

      if (searchTerm || category) {
        await showCategories(jid);
      }

      return;
    }

    const currentPage = Math.max(
      1,
      Number(result.page) || page
    );

    const totalPages = Math.max(
      1,
      Number(result.pages) || 1
    );

    const total = Number(result.total) || products.length;

    state.products = products;
    state.stage = "select_product";
    state.currentPage = currentPage;
    state.totalPages = totalPages;
    state.totalProducts = total;
    state.currentSearch = searchTerm;
    state.selectedCategory = category;

    conversations.set(jid, state);

    let response = "";

    if (category) {
      response += `*${STORE_NAME} - ${category.toUpperCase()}*\n\n`;
    } else if (searchTerm) {
      response += `*${STORE_NAME} - SEARCH RESULTS*\n\n`;
    } else {
      response += `*${STORE_NAME} - ALL PRODUCTS*\n\n`;
    }

    response +=
      `Showing page ${currentPage} of ${totalPages}\n` +
      `Total matching products: ${total}\n\n`;

    products.forEach((product, index) => {
      const stock = Number(product.countInStock || 0);

      const price = productPrice(product);
      const originalPrice = productOriginalPrice(product);

      response +=
        `*${index + 1}. ${product.name}*\n` +
        `Price: ${formatNaira(price)}\n`;

      if (originalPrice > price) {
        response +=
          `Original price: ${formatNaira(originalPrice)}\n`;
      }

      if (product.brand) {
        response += `Brand: ${product.brand}\n`;
      }

      if (product.category) {
        response += `Category: ${product.category}\n`;
      }

      response +=
        `Stock: ${stock > 0 ? stock : "Out of stock"}\n`;

      if (product.sku) {
        response += `SKU: ${product.sku}\n`;
      }

      response += "\n";
    });

    response +=
      "Reply with the product number to select it.\n";

    if (currentPage < totalPages) {
      response += "Type *NEXT* to see more products.\n";
    }

    if (currentPage > 1) {
      response += "Type *PREV* to see the previous page.\n";
    }

    response += "\nType MENU to return to the main menu.";

    await sendText(jid, response);

  } catch (error) {
    console.error("Product search error:", error.message);

    state.products = [];
    state.stage = "browse_empty";

    conversations.set(jid, state);

    await sendText(
      jid,
      "Sorry, I cannot retrieve products from our store database at the moment. Please try again shortly."
    );
  }
}

// ==========================================
// GET FRESH PRODUCT DETAILS
// ==========================================

async function getFreshProduct(productId) {
  const result = await getProductDetails(productId);

  if (
    !result ||
    result.success !== true ||
    !result.product ||
    !result.product._id ||
    !result.product.name
  ) {
    throw new Error("This product is no longer available.");
  }

  return result.product;
}

// ==========================================
// CREATE CUSTOMER ORDER
// ==========================================

async function createOrderFromConversation(jid, state) {
  try {
    if (!state.product?._id) {
      throw new Error("No valid product was selected.");
    }

    const whatsappPhone = getWhatsAppPhone(jid);
    const customerPhone = normalizePhone(state.phone);

    if (!whatsappPhone || customerPhone !== whatsappPhone) {
      throw new Error(
        "Delivery phone number does not match WhatsApp number."
      );
    }

    const orderData = {
      items: [
        {
          productId: state.product._id,
          quantity: state.quantity
        }
      ],

      shippingAddress: {
        fullName: state.fullName,
        phone: customerPhone,
        street: state.address,
        city: state.city,
        state: state.state,
        zipCode: state.zipCode,
        country: "Nigeria"
      },

      whatsappPhone
    };

    console.log("Submitting WhatsApp order:", {
      productId: state.product._id,
      quantity: state.quantity,
      whatsappPhone
    });

    const result = await createGuestOrder(orderData);

    if (
      !result ||
      result.success !== true ||
      !result.order
    ) {
      throw new Error(
        result?.message ||
        "The order API did not confirm the order."
      );
    }

    const order = result.order;

    const totalAmount = Number(order.totalAmount || 0);

    let response =
      `*${STORE_NAME} - ORDER CREATED* ☀️\n\n` +
      `Your order has been successfully recorded.\n\n` +
      `Order Number: *${order.orderNumber || "Pending"}*\n` +
      `Product: ${state.product.name}\n` +
      `Quantity: ${state.quantity}\n` +
      `Total: ${formatNaira(totalAmount)}\n` +
      `Order Status: ${order.status || "pending"}\n` +
      `Payment Status: ${order.paymentStatus || "pending"}\n\n`;

    const paymentUrl =
      order.paymentUrl ||
      order.paymentLink ||
      order.checkoutUrl ||
      result.paymentUrl ||
      result.paymentLink;

    if (paymentUrl) {
      response +=
        `Complete your payment using this secure payment link:\n${paymentUrl}\n\n`;
    } else {
      response +=
        "Your order is awaiting payment instructions from our store.\n\n";
    }

    response +=
      `Please keep your order number for reference.\n\n` +
      `Thank you for choosing ${STORE_NAME}.`;

    await sendText(jid, response);

    // AI ENHANCEMENT: automatic post-order product
    // suggestions from the live store database

    await sendRelatedProductSuggestions(
      jid,
      state.product
    );

    conversations.delete(jid);
    clearAIHistory(jid);

  } catch (error) {
    console.error("Order creation error:", error.message);

    await sendText(
      jid,
      `I couldn't complete your order.\n\n${error.message}\n\nPlease check your details and try again, or type MENU.`
    );
  }
}

// ==========================================
// MAIN MENU
// ==========================================

async function showMainMenu(jid) {
  conversations.set(jid, {});

  const greeting = getTimeGreeting();
  const occasion = getSpecialOccasion();

  let message =
    `${greeting}! 👋\n\n` +
    `Welcome to *${STORE_NAME}*! ☀️\n\n`;

  if (occasion) {
    message +=
      `🎉 *${occasion.title}*\n` +
      `${occasion.message}\n\n`;
  }

  message +=
    `How can we assist you today?\n\n` +
    `1️⃣ Search for a product\n` +
    `2️⃣ Browse all products\n` +
    `3️⃣ Browse product categories\n` +
    `4️⃣ Track an order\n` +
    `5️⃣ Customer support\n\n` +
    `You can also ask questions about solar energy, ` +
    `electrical systems, installations and our products.\n\n` +
    `For example:\n` +
    `"I need a solar system for my house."\n\n` +
    `We're happy to help! 😊`;

  await sendText(jid, message);
}

// ==========================================
// CUSTOMER CONVERSATION
// ==========================================

async function handleConversation(jid, text) {
  const normalized = normalizeMessage(text);

  let state = conversations.get(jid) || {};

  // GLOBAL MENU COMMAND

  if (
    ["menu", "start", "main menu", "home"].includes(normalized)
  ) {
    clearAIHistory(jid);
    await showMainMenu(jid);
    return;
  }

  // STOP CURRENT CONVERSATION

  if (
    ["stop", "cancel", "exit"].includes(normalized)
  ) {
    conversations.delete(jid);
    clearAIHistory(jid);

    await sendText(
      jid,
      "Your current automated conversation has been stopped. Send MENU whenever you want to start again."
    );

    return;
  }

  // ========================================
  // AUTOMATIC CUSTOMER SERVICE ESCALATION
  // ========================================

  if (
    isCustomerServiceRequest(text) ||
    isOrderPaymentProblem(text) ||
    isFrustratedCustomer(text)
  ) {
    console.log(
      "Customer service escalation requested:",
      text
    );

    conversations.delete(jid);

    let escalationIntro =
      "Certainly! You can contact our customer service team directly using the details below.";

    if (isOrderPaymentProblem(text)) {
      escalationIntro =
        "I'm sorry you're experiencing this problem. Our customer service team can help you resolve it.";
    } else if (isFrustratedCustomer(text)) {
      escalationIntro =
        "I'm truly sorry about your experience. Our customer service team will attend to you immediately.";
    }

    await sendCustomerServiceDetails(
      jid,
      escalationIntro
    );

    return;
  }

  // DATABASE-FIRST STORE INVENTORY ROUTING

  if (
    isCategoryBrowseRequest(text) ||
    isStoreInventoryQuestion(text)
  ) {
    console.log(
      "Customer asked about store inventory. Fetching live database categories:",
      text
    );

    await showCategories(jid);
    return;
  }

  // FULL CATALOGUE REQUEST

  if (isCatalogBrowseRequest(text)) {
    console.log("Customer requested full catalogue:", text);

    await showProducts(jid, "");
    return;
  }

  // CATEGORY SELECTION

  if (state.stage === "select_category") {
    const index = Number(text) - 1;

    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < state.categories.length
    ) {
      const selectedCategory = state.categories[index];

      await showProducts(
        jid,
        "",
        1,
        selectedCategory
      );

      return;
    }

    const selectedByName = state.categories.find(
      category =>
        category.toLowerCase() === normalized
    );

    if (selectedByName) {
      await showProducts(
        jid,
        "",
        1,
        selectedByName
      );

      return;
    }

    // AI ENHANCEMENT: smart category matching when
    // the customer types a category in their own words

    if (
      AI_CATEGORY_MATCHING_ENABLED &&
      state.categories &&
      state.categories.length &&
      text.trim().length >= 2 &&
      !/^\d+$/.test(text.trim())
    ) {
      const aiCategory = await matchCategoryWithAI(
        text,
        state.categories
      );

      if (aiCategory) {
        console.log(
          "AI category match:",
          text,
          "->",
          aiCategory
        );

        await showProducts(
          jid,
          "",
          1,
          aiCategory
        );

        return;
      }
    }

    if (text.trim().length >= 2) {
      await showProducts(
        jid,
        extractProductSearchTerm(text) || text
      );

      return;
    }

    await sendText(
      jid,
      "Please enter a valid category number or category name. You can also type ALL PRODUCTS or MENU."
    );

    return;
  }

  // PRODUCT PAGINATION AND SELECTION

  if (state.stage === "select_product") {
    if (
      ["next", "more", "next page"].includes(normalized)
    ) {
      if (state.currentPage >= state.totalPages) {
        await sendText(
          jid,
          "You are already viewing the last product page."
        );

        return;
      }

      await showProducts(
        jid,
        state.currentSearch || "",
        state.currentPage + 1,
        state.selectedCategory || ""
      );

      return;
    }

    if (
      ["prev", "previous", "previous page", "back"].includes(normalized)
    ) {
      if (state.currentPage <= 1) {
        await sendText(
          jid,
          "You are already viewing the first product page."
        );

        return;
      }

      await showProducts(
        jid,
        state.currentSearch || "",
        state.currentPage - 1,
        state.selectedCategory || ""
      );

      return;
    }

    const index = Number(text) - 1;

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= state.products.length
    ) {
      if (isExplicitProductRequest(text)) {
        await showProducts(
          jid,
          extractProductSearchTerm(text)
        );

        return;
      }

      // AI ENHANCEMENT: grounded product advice
      // based only on the live product list

      if (
        await answerProductListQuestion(
          jid,
          text,
          state.products
        )
      ) {
        return;
      }

      await sendText(
        jid,
        "Please enter a valid product number. You can also type NEXT, PREV, a new product name, or MENU."
      );

      return;
    }

    const selectedProduct = state.products[index];

    try {
      const product = await getFreshProduct(
        selectedProduct._id
      );

      if (Number(product.countInStock || 0) < 1) {
        await sendText(
          jid,
          `Sorry, *${product.name}* is currently out of stock. Please select another product.`
        );

        return;
      }

      state.product = product;
      state.stage = "quantity";

      conversations.set(jid, state);

      await sendText(
        jid,
        `You selected *${product.name}*.\n\n` +
        `Price: ${formatNaira(productPrice(product))}\n` +
        `Available stock: ${product.countInStock}\n\n` +
        `How many would you like?`
      );

    } catch (error) {
      console.error("Product details error:", error.message);

      await sendText(
        jid,
        "Sorry, I couldn't verify this product. Please return to the product list and select another item."
      );
    }

    return;
  }

  // ACTIVE SEARCH STAGE

  if (state.stage === "search") {
    if (text.trim().length < 2) {
      await sendText(
        jid,
        "Please enter at least two characters of the product name, brand, SKU or category."
      );

      return;
    }

    await showProducts(
      jid,
      extractProductSearchTerm(text) || text
    );

    return;
  }

  // QUANTITY

  if (state.stage === "quantity") {
    let quantity = Number(text);

    // AI ENHANCEMENT: understand natural language
    // quantities like "two" or "3 pieces"

    if (!Number.isInteger(quantity)) {
      const parsedQuantity =
        await parseQuantityWithAI(text);

      if (parsedQuantity !== null) {
        quantity = parsedQuantity;
      }
    }

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 100 ||
      quantity > Number(state.product.countInStock || 0)
    ) {
      // AI ENHANCEMENT: answer mid-order questions
      // without losing the customer's order state

      if (
        await handleOrderFlowQuestion(
          jid,
          text,
          "quantity",
          state
        )
      ) {
        await sendText(
          jid,
          `How many *${state.product.name}* would you like? Available stock: ${state.product.countInStock}.`
        );

        return;
      }

      await sendText(
        jid,
        `Enter a valid quantity. Available stock: ${state.product.countInStock}.`
      );

      return;
    }

    state.quantity = quantity;
    state.stage = "full_name";

    conversations.set(jid, state);

    await sendText(jid, "Please enter your full name.");
    return;
  }

  // CUSTOMER NAME

  if (state.stage === "full_name") {
    // AI ENHANCEMENT: answer mid-order questions
    // without losing the customer's order state

    if (
      await handleOrderFlowQuestion(
        jid,
        text,
        "full_name",
        state
      )
    ) {
      await sendText(jid, "Please enter your full name.");
      return;
    }

    if (text.length < 3 || text.length > 100) {
      await sendText(jid, "Please enter your full name.");
      return;
    }

    state.fullName = text.trim();
    state.stage = "phone";

    conversations.set(jid, state);

    await sendText(
      jid,
      "Enter your delivery phone number.\n\n" +
      "For security, it must be the same number you are using to chat with us on WhatsApp."
    );

    return;
  }

  // CUSTOMER PHONE

  if (state.stage === "phone") {
    // AI ENHANCEMENT: answer mid-order questions
    // without losing the customer's order state

    if (
      await handleOrderFlowQuestion(
        jid,
        text,
        "phone",
        state
      )
    ) {
      await sendText(
        jid,
        "Enter your delivery phone number.\n\n" +
        "For security, it must be the same number you are using to chat with us on WhatsApp."
      );

      return;
    }

    const phone = normalizePhone(text);
    const whatsappPhone = getWhatsAppPhone(jid);

    if (phone.length < 10 || phone.length > 15) {
      await sendText(jid, "Please enter a valid phone number.");
      return;
    }

    if (phone !== whatsappPhone) {
      await sendText(
        jid,
        "The delivery phone number must match the WhatsApp number you are using to place this order. Please enter your WhatsApp number."
      );

      return;
    }

    state.phone = phone;
    state.stage = "address";

    conversations.set(jid, state);

    await sendText(
      jid,
      "Enter your delivery street or house address."
    );

    return;
  }

  // DELIVERY ADDRESS

  if (state.stage === "address") {
    // AI ENHANCEMENT: answer mid-order questions
    // without losing the customer's order state

    if (
      await handleOrderFlowQuestion(
        jid,
        text,
        "address",
        state
      )
    ) {
      await sendText(
        jid,
        "Enter your delivery street or house address."
      );

      return;
    }

    if (text.length < 5) {
      await sendText(
        jid,
        "Please enter a complete delivery address."
      );

      return;
    }

    state.address = text.trim();
    state.stage = "city";

    conversations.set(jid, state);

    await sendText(jid, "Which city or town?");
    return;
  }

  // CITY

  if (state.stage === "city") {
    // AI ENHANCEMENT: answer mid-order questions
    // without losing the customer's order state

    if (
      await handleOrderFlowQuestion(
        jid,
        text,
        "city",
        state
      )
    ) {
      await sendText(jid, "Which city or town?");
      return;
    }

    if (text.length < 2 || text.length > 100) {
      await sendText(jid, "Please enter a valid city or town.");
      return;
    }

    state.city = text.trim();
    state.stage = "state";

    conversations.set(jid, state);

    await sendText(jid, "Which state in Nigeria?");
    return;
  }

  // STATE

  if (state.stage === "state") {
    // AI ENHANCEMENT: answer mid-order questions
    // without losing the customer's order state

    if (
      await handleOrderFlowQuestion(
        jid,
        text,
        "state",
        state
      )
    ) {
      await sendText(jid, "Which state in Nigeria?");
      return;
    }

    if (text.length < 2 || text.length > 100) {
      await sendText(jid, "Please enter a valid state.");
      return;
    }

    state.state = text.trim();
    state.stage = "zipCode";

    conversations.set(jid, state);

    await sendText(
      jid,
      "Please enter your delivery postcode or ZIP code."
    );

    return;
  }

  // POSTCODE AND ORDER SUBMISSION

  if (state.stage === "zipCode") {
    // AI ENHANCEMENT: answer mid-order questions
    // without losing the customer's order state

    if (
      await handleOrderFlowQuestion(
        jid,
        text,
        "zipCode",
        state
      )
    ) {
      await sendText(
        jid,
        "Please enter your delivery postcode or ZIP code."
      );

      return;
    }

    if (
      text.trim().length < 2 ||
      text.trim().length > 20
    ) {
      await sendText(
        jid,
        "Please enter a valid delivery postcode."
      );

      return;
    }

    state.zipCode = text.trim();

    conversations.set(jid, state);

    await sendText(
      jid,
      "Please wait while I submit your order to our store..."
    );

    await createOrderFromConversation(jid, state);
    return;
  }

  // ORDER NUMBER

  if (state.stage === "order_number") {
    // AI ENHANCEMENT: answer tracking questions
    // without losing the tracking state

    if (
      await handleOrderFlowQuestion(
        jid,
        text,
        "order_number",
        state
      )
    ) {
      await sendText(jid, "Please enter your order number.");
      return;
    }

    if (text.trim().length < 2) {
      await sendText(jid, "Please enter a valid order number.");
      return;
    }

    state.orderNumber = text.trim();
    state.stage = "order_phone";

    conversations.set(jid, state);

    await sendText(
      jid,
      "Enter the phone number used when placing your order."
    );

    return;
  }

  // ORDER TRACKING

  if (state.stage === "order_phone") {
    // AI ENHANCEMENT: answer tracking questions
    // without losing the tracking state

    if (
      await handleOrderFlowQuestion(
        jid,
        text,
        "order_phone",
        state
      )
    ) {
      await sendText(
        jid,
        "Enter the phone number used when placing your order."
      );

      return;
    }

    try {
      const phone = normalizePhone(text);

      if (phone.length < 10 || phone.length > 15) {
        await sendText(jid, "Please enter a valid phone number.");
        return;
      }

      const result = await getOrderStatus(
        state.orderNumber,
        phone
      );

      if (!result || result.success !== true) {
        throw new Error(
          result?.message || "Order lookup failed."
        );
      }

      const order =
        result.order ||
        result.data?.order;

      if (!order) {
        throw new Error("Order not found.");
      }

      let itemsText = "";

      if (Array.isArray(order.items)) {
        itemsText = order.items
          .map(item =>
            `${item.name || "Product"} x ${item.quantity || 1}`
          )
          .join("\n");
      }

      await sendText(
        jid,
        `*${STORE_NAME} - ORDER STATUS*\n\n` +
        `Order: ${order.orderNumber}\n` +
        (itemsText ? `Items:\n${itemsText}\n\n` : "") +
        `Status: ${order.status || "Unavailable"}\n` +
        `Payment: ${order.paymentStatus || "Unavailable"}\n` +
        `Subtotal: ${formatNaira(order.subtotal)}\n` +
        `Shipping: ${formatNaira(order.shippingCost)}\n` +
        `Total: ${formatNaira(order.totalAmount)}\n\n` +
        `Thank you for shopping with ${STORE_NAME}.`
      );

      conversations.delete(jid);

    } catch (error) {
      console.error("Order lookup:", error.message);

      await sendText(
        jid,
        "I couldn't verify this order. Please check your order number and phone number."
      );
    }

    return;
  }

  // CUSTOMER SUPPORT

  if (state.stage === "support") {
    const aiResponse = await askCustomerAI(
      jid,
      `The customer needs assistance. Their message is: ${text}

Help them if possible. Do not claim to have connected
them to a human agent.`
    );

    await sendText(
      jid,
      `${aiResponse}\n\n${getCustomerServiceMessage(
        "For further assistance, you can also contact our customer service team directly:"
      )}`
    );

    conversations.delete(jid);
    return;
  }

  // MAIN MENU SHORTCUTS

  if (
    ["1", "search", "search products", "find products"].includes(normalized)
  ) {
    conversations.set(jid, { stage: "search" });

    await sendText(
      jid,
      "What product are you looking for?\n\nEnter a product name, brand, SKU or category."
    );

    return;
  }

  if (
    ["2", "browse", "browse products", "view products", "all products"].includes(normalized)
  ) {
    await showProducts(jid, "");
    return;
  }

  if (
    ["3", "categories", "browse categories", "browse by category", "product categories"].includes(normalized)
  ) {
    await showCategories(jid);
    return;
  }

  if (
    ["4", "track", "track order", "track an order"].includes(normalized)
  ) {
    conversations.set(jid, { stage: "order_number" });

    await sendText(jid, "Please enter your order number.");
    return;
  }

  if (
    ["5", "support", "customer support", "contact support"].includes(normalized)
  ) {
    conversations.set(jid, { stage: "support" });

    await sendCustomerServiceDetails(
      jid,
      "You've selected customer support. Please describe your issue, or contact our customer service team directly using the details below."
    );

    return;
  }

  // DIRECT PRODUCT SEARCH ROUTING

  if (isExplicitProductRequest(text)) {
    const searchTerm = extractProductSearchTerm(text);

    if (!searchTerm) {
      await showCategories(jid);
      return;
    }

    console.log("Explicit product search:", searchTerm);

    await showProducts(jid, searchTerm);
    return;
  }

  // STANDALONE PRODUCT NAMES / BRANDS / SKU

  if (shouldTryCatalogSearch(text)) {
    const searchTerm = extractProductSearchTerm(text);

    console.log("Possible product search:", searchTerm);

    await showProducts(jid, searchTerm);
    return;
  }

  // GROQ INTENT DETECTION

  const intent = await detectMessageIntent(text);

  console.log("Detected customer intent:", intent);

  if (intent === "GREETING") {
    const aiResponse = await askCustomerAI(jid, text);

    await sendText(jid, aiResponse);
    return;
  }

  if (intent === "CATEGORY") {
    await showCategories(jid);
    return;
  }

  if (intent === "CATALOG") {
    await showProducts(jid, "");
    return;
  }

  if (intent === "PRODUCT") {
    const searchTerm = extractProductSearchTerm(text);

    if (searchTerm) {
      await showProducts(jid, searchTerm);
    } else {
      await showCategories(jid);
    }

    return;
  }

  if (intent === "TRACKING") {
    conversations.set(jid, { stage: "order_number" });

    await sendText(jid, "Please enter your order number.");
    return;
  }

  if (intent === "SUPPORT") {
    conversations.delete(jid);

    await sendCustomerServiceDetails(
      jid,
      "I'll be happy to help you reach our customer service team."
    );

    return;
  }

  // GENERAL AND TECHNICAL QUESTIONS

  const aiResponse = await askCustomerAI(jid, text);

  await sendText(jid, aiResponse);
}

// ==========================================
// WHATSAPP PAIRING CODE
// ==========================================

async function issuePairingCode() {
  if (
    !sock ||
    !authState ||
    !pendingPairingNumber ||
    pairingRequested ||
    connectionStatus === "connected"
  ) {
    return;
  }

  if (authState.creds.registered) {
    console.error(
      "Cannot request a pairing code: an existing session is registered."
    );

    connectionStatus = "logged_out";
    return;
  }

  if (!qrEventReady) {
    console.log("Waiting for WhatsApp pairing event.");
    return;
  }

  pairingRequested = true;

  try {
    const number = pendingPairingNumber;

    console.log("Requesting WhatsApp pairing code.");

    await sleep(1500);

    if (!sock || !authState || authState.creds.registered) {
      throw new Error(
        "WhatsApp socket is not ready for a new pairing request."
      );
    }

    const code = await sock.requestPairingCode(number);

    pairingCode = code;
    currentQR = null;

    connectionStatus = "pairing_code_ready";

    console.log("WhatsApp pairing code generated successfully.");

  } catch (error) {
    pairingRequested = false;
    pairingCode = null;

    console.error(
      "Pairing code request failed:",
      error?.output?.payload || error.message || error
    );
  }
}

// ==========================================
// REQUEST PAIRING
// ==========================================

export async function requestPairing(phoneNumber) {
  const number = normalizePhone(phoneNumber);

  if (number.length < 10 || number.length > 15) {
    throw new Error(
      "Enter a valid phone number with country code, digits only."
    );
  }

  if (!sock) {
    throw new Error(
      "WhatsApp socket is not initialized. Restart the bot and try again."
    );
  }

  if (connectionStatus === "connected") {
    throw new Error("WhatsApp is already connected.");
  }

  if (authState?.creds?.registered) {
    throw new Error(
      "The saved WhatsApp session is already registered. Clear the active authentication folder before pairing again."
    );
  }

  if (pendingPairingNumber && pairingRequested) {
    throw new Error(
      "A pairing-code request is already in progress. Please wait."
    );
  }

  pendingPairingNumber = number;
  pairingCode = null;
  pairingRequested = false;
  currentQR = null;

  if (qrEventReady) {
    await issuePairingCode();
  }

  return {
    success: true,
    message: qrEventReady
      ? "Pairing code request submitted. Check the admin dashboard shortly."
      : "Phone number saved. Waiting for WhatsApp connection event."
  };
}

// ==========================================
// START WHATSAPP
// ==========================================

export async function startWhatsApp() {
  if (starting) {
    console.log("WhatsApp startup already in progress.");
    return;
  }

  starting = true;

  try {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    loadWelcomedCustomers();

    logStoreClock();

    console.log(
      "Using WhatsApp authentication folder:",
      AUTH_FOLDER
    );

    console.log(
      "Founder welcome image:",
      STORE_OWNER_IMAGE
    );

    console.log(
      "Founder display name:",
      STORE_OWNER_NAME
    );

    console.log(
      "Configured store timezone:",
      STORE_TIMEZONE
    );

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_FOLDER);

    authState = state;

    sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000
    });

    sock.ev.on("creds.update", saveCreds);

    // ======================================
    // CONNECTION EVENTS
    // ======================================

    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {
          qrEventReady = true;

          if (
            pendingPairingNumber &&
            !authState?.creds?.registered
          ) {
            await issuePairingCode();

          } else if (!pairingRequested) {
            try {
              currentQR = await QRCode.toDataURL(qr);

              connectionStatus = "qr_required";

              console.log("WhatsApp QR code generated.");

            } catch (error) {
              console.error(
                "QR generation failed:",
                error.message
              );
            }
          }
        }

        if (connection === "open") {
          starting = false;

          currentQR = null;
          pairingCode = null;

          pendingPairingNumber = null;
          pairingRequested = false;
          qrEventReady = false;

          connectionStatus = "connected";

          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }

          console.log(
            `${STORE_NAME} WhatsApp connected successfully.`
          );

          logStoreClock();
        }

        if (connection === "close") {
          starting = false;

          const disconnectError =
            lastDisconnect?.error;

          const statusCode =
            disconnectError instanceof Boom
              ? disconnectError.output?.statusCode
              : disconnectError?.output?.statusCode;

          const loggedOut =
            statusCode === DisconnectReason.loggedOut;

          currentQR = null;
          pairingCode = null;
          qrEventReady = false;

          connectionStatus = loggedOut
            ? "logged_out"
            : "disconnected";

          console.error(
            "WhatsApp disconnected. Status:",
            statusCode || "unknown",
            "Message:",
            disconnectError?.message || "No error message",
            "Details:",
            disconnectError?.data ||
            disconnectError?.output?.payload ||
            ""
          );

          if (loggedOut) {
            pendingPairingNumber = null;
            pairingRequested = false;

            console.error(
              "WhatsApp session rejected. Stop here and reset the active authentication folder before pairing again."
            );

            return;
          }

          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              startWhatsApp();
            }, 5000);
          }
        }
      }
    );

    // ======================================
    // INCOMING WHATSAPP MESSAGES
    // ======================================

    sock.ev.on(
      "messages.upsert",
      async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const message of messages) {
          try {
            if (
              !message.message ||
              message.key.fromMe
            ) {
              continue;
            }

            const jid = message.key.remoteJid;

            if (
              !jid ||
              jid === "status@broadcast" ||
              jid.endsWith("@g.us") ||
              jid.endsWith("@newsletter")
            ) {
              continue;
            }

            let text = getText(message);

            // AI ENHANCEMENT: automatic voice note
            // transcription and image recognition when
            // the message has no text

            if (!text) {
              text = await extractTextFromMedia(
                message,
                jid
              );
            }

            if (!text) continue;
            if (!isConnected()) continue;
            if (isDuplicateMessage(message)) continue;

            try {
              await sock.readMessages([message.key]);
            } catch (error) {}

            console.log(
              "Incoming WhatsApp customer message received."
            );

            queueIncomingMessage(jid, async () => {
              try {
                if (!isConnected()) return;

                // AI ENHANCEMENT: cancel any pending
                // follow-up reminder for this customer

                clearFollowUpTimer(jid);

                const firstWelcome =
                  await sendFounderWelcome(jid);

                if (
                  firstWelcome &&
                  isGreetingOrAcknowledgement(text)
                ) {
                  return;
                }

                await handleConversation(jid, text);

                // AI ENHANCEMENT: schedule an automatic
                // follow-up reminder if the conversation
                // is waiting for customer input

                const followUpState =
                  conversations.get(jid) || {};

                if (followUpState.stage) {
                  scheduleFollowUp(
                    jid,
                    followUpState.stage
                  );
                }

              } catch (error) {
                console.error(
                  "Customer conversation error:",
                  error.message
                );

                try {
                  await sendText(
                    jid,
                    "Sorry, something went wrong while processing your message. Please try again or type MENU."
                  );
                } catch (sendError) {
                  console.error(
                    "Error sending fallback message:",
                    sendError.message
                  );
                }
              }
            }).catch(error => {
              console.error(
                "Incoming message queue error:",
                error.message
              );
            });

          } catch (error) {
            console.error(
              "Message handling error:",
              error.message
            );
          }
        }
      }
    );

  } catch (error) {
    starting = false;

    console.error("WhatsApp startup error:", error);

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsApp();
      }, 10000);
    }
  }
}