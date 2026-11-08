
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

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

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
- Do not repeat the same greeting unnecessarily.

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

3. LIVE PRODUCT DATABASE

The application has access to the real store catalogue.

Product names, prices, discounts, brands, descriptions,
categories, SKUs and stock quantities must come from
the actual ecommerce database.

Never invent products.

Never invent prices.

Never claim a product is available unless the application
has checked the actual product API.

Never pretend that you have checked the database.

If the customer asks for a product, the application
will search the actual product API.

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
// IMPORTANT: RUN BEFORE PRODUCT SEARCH
// ==========================================

function isCategoryBrowseRequest(message) {
  const text = normalizeMessage(message);

  const patterns = [
    /\bthe products? in (this|your|the) store\b/,
    /\bproducts? in (this|your|the) store\b/,
    /\bproducts? available in (this|your|the) store\b/,
    /\bwhat products? do you have\b/,
    /\bwhat products? are available\b/,
    /\bwhat items? do you sell\b/,
    /\bwhat do you sell\b/,
    /\bwhat do you offer\b/,
    /\bwhat can i buy (here|from you|in this store)\b/,
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
    /\bi want to browse your products\b/
  ];

  return patterns.some(pattern => pattern.test(text));
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
    /\bi want to see all products\b/
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
  if (isCatalogBrowseRequest(text)) return false;
  if (isGreetingOrAcknowledgement(text)) return false;
  if (isTechnicalQuestion(text)) return false;

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

  if (isCategoryBrowseRequest(text)) return "CATEGORY";
  if (isCatalogBrowseRequest(text)) return "CATALOG";

  if (isGreetingOrAcknowledgement(text)) {
    return "GREETING";
  }

  if (
    /\b(track|tracking|order status|where is my order|my order|check my order)\b/i.test(text)
  ) {
    return "TRACKING";
  }

  if (
    /\b(customer support|speak to someone|human agent|representative|complaint|talk to a person)\b/i.test(text)
  ) {
    return "SUPPORT";
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
The customer wants to see the store's product categories.

Examples:
"The products in this store"
"What do you sell?"
"What categories do you have?"
"Show me all categories"
"List your product categories"
"What products are available in your store?"

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
The customer wants human assistance.

GREETING:
Greetings and simple acknowledgements.

QUESTION:
Technical questions, general enquiries, vague requests
and anything that does not fit the other categories.

IMPORTANT:
A technical question about how a product works is
QUESTION, not PRODUCT.

"The products in this store" is CATEGORY, not PRODUCT.

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

// Supports categories returned as strings or objects.
// Category names still come exclusively from the API.
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
// BROWSE CATEGORIES FROM MONGODB
// ==========================================

async function showCategories(jid) {
  const state = conversations.get(jid) || {};

  state.stage = "loading_categories";
  state.categories = [];

  conversations.set(jid, state);

  try {
    console.log("Fetching ALL categories from MongoDB API.");

    const result = await getCategories();

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
    console.error("Category retrieval error:", error.message);

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
// DISPLAY PRODUCTS FROM MONGODB
// ==========================================

async function showProducts(
  jid,
  search = "",
  page = 1,
  category = ""
) {
  const state = conversations.get(jid) || {};

  const searchTerm = String(search || "").trim();

  state.products = [];
  state.product = null;
  state.stage = "loading_products";

  conversations.set(jid, state);

  try {
    console.log("Fetching products from ecommerce backend:", {
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
      "MongoDB products returned:",
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

  await sendText(
    jid,
    `Welcome to *${STORE_NAME}*! ☀️\n\n` +
    `Thank you for contacting us.\n\n` +
    `How can we assist you today?\n\n` +
    `1️⃣ Search for a product\n` +
    `2️⃣ Browse all products\n` +
    `3️⃣ Browse product categories\n` +
    `4️⃣ Track an order\n` +
    `5️⃣ Customer support\n\n` +
    `You can also ask questions about solar energy, ` +
    `electrical systems, installations and our products.\n\n` +
    `You can type your request naturally. For example:\n` +
    `"I need a solar system for my house."\n\n` +
    `We're happy to help! 😊`
  );
}

// ==========================================
// CUSTOMER CONVERSATION
// ==========================================

async function handleConversation(jid, text) {
  const normalized = normalizeMessage(text);

  let state = conversations.get(jid) || {};

  // ========================================
  // GLOBAL MENU COMMAND
  // ========================================

  if (
    ["menu", "start", "main menu", "home"].includes(normalized)
  ) {
    clearAIHistory(jid);
    await showMainMenu(jid);
    return;
  }

  // ========================================
  // STOP CURRENT CONVERSATION
  // ========================================

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
  // GLOBAL CATEGORY REQUEST
  // MUST RUN BEFORE PRODUCT SEARCH AND
  // BEFORE CONVERSATION STAGE HANDLING
  // ========================================

  if (isCategoryBrowseRequest(text)) {
    console.log("Customer requested database categories:", text);

    await showCategories(jid);
    return;
  }

  // ========================================
  // GLOBAL FULL CATALOGUE REQUEST
  // ========================================

  if (isCatalogBrowseRequest(text)) {
    console.log("Customer requested complete catalogue:", text);

    await showProducts(jid, "");
    return;
  }

  // ========================================
  // CATEGORY SELECTION
  // ========================================

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

    // Allow customer to search for a different product
    // instead of forcing a category number.
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

  // ========================================
  // PRODUCT PAGINATION AND SELECTION
  // ========================================

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
      // Allow a new product search while browsing.
      if (isExplicitProductRequest(text)) {
        await showProducts(
          jid,
          extractProductSearchTerm(text)
        );

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

  // ========================================
  // ACTIVE SEARCH STAGE
  // ========================================

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

  // ========================================
  // QUANTITY
  // ========================================

  if (state.stage === "quantity") {
    const quantity = Number(text);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 100 ||
      quantity > Number(state.product.countInStock || 0)
    ) {
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

  // ========================================
  // CUSTOMER NAME
  // ========================================

  if (state.stage === "full_name") {
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

  // ========================================
  // CUSTOMER PHONE
  // ========================================

  if (state.stage === "phone") {
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

  // ========================================
  // DELIVERY ADDRESS
  // ========================================

  if (state.stage === "address") {
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

  // ========================================
  // CITY
  // ========================================

  if (state.stage === "city") {
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

  // ========================================
  // STATE
  // ========================================

  if (state.stage === "state") {
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

  // ========================================
  // POSTCODE AND ORDER SUBMISSION
  // ========================================

  if (state.stage === "zipCode") {
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

  // ========================================
  // ORDER NUMBER
  // ========================================

  if (state.stage === "order_number") {
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

  // ========================================
  // ORDER TRACKING
  // ========================================

  if (state.stage === "order_phone") {
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

  // ========================================
  // CUSTOMER SUPPORT
  // ========================================

  if (state.stage === "support") {
    const aiResponse = await askCustomerAI(
      jid,
      `The customer needs support. Their message is: ${text}`
    );

    await sendText(jid, aiResponse);

    conversations.delete(jid);
    return;
  }

  // ========================================
  // MAIN MENU SHORTCUTS
  // ========================================

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

    await sendText(
      jid,
      "Please describe what you need. Our assistant will help you."
    );

    return;
  }

  // ========================================
  // DIRECT PRODUCT SEARCH ROUTING
  // ========================================

  if (isExplicitProductRequest(text)) {
    const searchTerm = extractProductSearchTerm(text);

    if (!searchTerm) {
      await showCategories(jid);
      return;
    }

    console.log("Explicit product search detected:", {
      message: text,
      searchTerm
    });

    await showProducts(jid, searchTerm);
    return;
  }

  // ========================================
  // STANDALONE PRODUCT NAMES / BRANDS / SKU
  // ========================================

  if (shouldTryCatalogSearch(text)) {
    const searchTerm = extractProductSearchTerm(text);

    console.log("Possible product search:", {
      message: text,
      searchTerm
    });

    await showProducts(jid, searchTerm);
    return;
  }

  // ========================================
  // GROQ INTENT DETECTION
  // ========================================

  const intent = await detectMessageIntent(text);

  console.log("Detected customer intent:", intent);

  // ========================================
  // GREETING / ACKNOWLEDGEMENT
  // ========================================

  if (intent === "GREETING") {
    const aiResponse = await askCustomerAI(jid, text);

    await sendText(jid, aiResponse);
    return;
  }

  // ========================================
  // CATEGORY
  // ========================================

  if (intent === "CATEGORY") {
    await showCategories(jid);
    return;
  }

  // ========================================
  // FULL CATALOGUE
  // ========================================

  if (intent === "CATALOG") {
    await showProducts(jid, "");
    return;
  }

  // ========================================
  // PRODUCT SEARCH
  // ========================================

  if (intent === "PRODUCT") {
    const searchTerm = extractProductSearchTerm(text);

    if (searchTerm) {
      await showProducts(jid, searchTerm);
    } else {
      await showCategories(jid);
    }

    return;
  }

  // ========================================
  // ORDER TRACKING
  // ========================================

  if (intent === "TRACKING") {
    conversations.set(jid, { stage: "order_number" });

    await sendText(jid, "Please enter your order number.");
    return;
  }

  // ========================================
  // SUPPORT
  // ========================================

  if (intent === "SUPPORT") {
    conversations.set(jid, { stage: "support" });

    await sendText(
      jid,
      "Please describe what you need. Our customer service assistant will help you."
    );

    return;
  }

  // ========================================
  // GENERAL QUESTIONS / TECHNICAL QUESTIONS
  // ========================================

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

    console.log(
      "Using WhatsApp authentication folder:",
      AUTH_FOLDER
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

            const text = getText(message);

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

                await handleConversation(jid, text);

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
