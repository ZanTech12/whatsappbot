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

// ==========================================
// GROQ AI CONFIGURATION
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

  aiHistory.set(jid, history.slice(-MAX_AI_HISTORY));
}

// ==========================================
// AI SYSTEM INSTRUCTIONS
// ==========================================

function getAISystemPrompt() {
  return `
You are the official AI customer service assistant
for ${STORE_NAME}, a solar energy and electrical
products business in Nigeria.

PERSONALITY:
- Friendly, intelligent and professional.
- Natural, conversational, warm and patient.
- Understand Nigerian English and informal expressions.
- Avoid robotic or repetitive responses.
- Do not repeatedly introduce yourself.
- Keep responses concise unless details are needed.

GREETING BEHAVIOUR:
Recognize greetings including:
Hi, Hello, Hey, Good morning, Good afternoon,
Good evening, How are you?, How far?, What's up?,
Happy Sunday, Happy Monday, Happy weekend and Greetings.

Respond naturally and politely.

BUSINESS RESPONSIBILITIES:
You can help customers with:
1. Solar panels.
2. Solar inverters.
3. Lithium batteries.
4. Tubular batteries.
5. Charge controllers.
6. Solar installation.
7. Solar system sizing.
8. Electrical installations.
9. Energy consumption calculations.
10. General solar technology questions.

TECHNICAL GUIDANCE:
Explain technical subjects in simple language.

When calculating solar requirements, ask for relevant information:
- Appliances they want to power.
- Power ratings in watts.
- Hours of usage.
- Required backup duration.
- Available budget, when relevant.

Do not present estimates as guaranteed installation specifications.

IMPORTANT BUSINESS RULES:
- Never invent product prices.
- Never invent product availability.
- Never invent discounts.
- Never invent delivery fees.
- Never invent company contact information.
- Never claim payment has been received without payment confirmation.
- Never claim an order has been created without order API confirmation.
- Never claim to have checked live products unless the product API was called.
- Never invent company policies.
- Never request passwords, OTPs or card details.
- Do not expose private payment information.

LIVE PRODUCT INFORMATION:
Product prices, availability and stock must come from
the actual product API, not from your own knowledge.

If live product information is unavailable, explain
that the information cannot currently be checked.

PURCHASES:
When customers want to purchase products, guide them
through the automated product ordering process.

ORDER TRACKING:
When customers want to track an order, guide them
through the order tracking process.

WHATSAPP FORMATTING:
- Use short paragraphs.
- Use emojis naturally without overusing them.
- Use simple Nigerian English where appropriate.
- Avoid unnecessary technical language.

You represent ${STORE_NAME}.
`;
}

// ==========================================
// ASK GROQ AI
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
// AI MESSAGE INTENT DETECTOR
// ==========================================

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
You are a message intent classifier for ${STORE_NAME}.

Classify into exactly one category:

GREETING
MENU
PRODUCT
TRACKING
SUPPORT
QUESTION

Rules:
- Greeting alone: GREETING.
- Explicit menu request: MENU.
- Product search or purchase: PRODUCT.
- Current product price or availability: PRODUCT.
- Order tracking: TRACKING.
- Customer service request: SUPPORT.
- General solar knowledge question: QUESTION.
- Greeting combined with a request follows the actual request.
- "Good morning, I need an inverter" is PRODUCT.
- "How do solar panels work?" is QUESTION.
- "How far?" alone is GREETING.

Return ONLY one category name.
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
      "MENU",
      "PRODUCT",
      "TRACKING",
      "SUPPORT",
      "QUESTION"
    ];

    return allowed.includes(intent) ? intent : "QUESTION";

  } catch (error) {
    console.error(
      "AI intent detection error:",
      error.message
    );

    return "QUESTION";
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

// ==========================================
// PUBLIC STATUS FUNCTIONS
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
// GENERAL HELPERS
// ==========================================

function formatNaira(amount) {
  const numericAmount = Number(amount || 0);

  return `\u20A6${Number.isFinite(numericAmount)
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
  } catch (error) {
    // Typing indicator is optional.
  }

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
    } catch (error) {
      // Ignore presence update errors.
    }
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
        throw new Error(
          "WhatsApp service is not connected."
        );
      }

      try {
        await sock.sendPresenceUpdate("composing", jid);
      } catch (error) {
        // Continue if presence is unavailable.
      }

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
// INCOMING DUPLICATE PROTECTION
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
// PER-CUSTOMER INCOMING QUEUE
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
// SEND ACCOUNT VERIFICATION OTP
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
// SEND NOTIFICATION AND OPTIONAL PDF RECEIPT
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
    throw new Error(
      "Invalid WhatsApp recipient phone number."
    );
  }

  if (
    typeof message !== "string" ||
    !message.trim()
  ) {
    throw new Error(
      "WhatsApp notification message is required."
    );
  }

  if (message.length > 10000) {
    throw new Error(
      "WhatsApp notification message is too long."
    );
  }

  const jid = `${number}@s.whatsapp.net`;

  await sendText(jid, message.trim());

  console.log("WhatsApp notification message sent.");

  if (pdfBuffer !== null && pdfBuffer !== undefined) {
    if (!Buffer.isBuffer(pdfBuffer)) {
      throw new Error(
        "PDF receipt must be supplied as a Buffer."
      );
    }

    if (
      !pdfBuffer.length ||
      pdfBuffer.length > MAX_PDF_SIZE
    ) {
      throw new Error(
        "PDF receipt is empty or exceeds the 7MB limit."
      );
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
// PRODUCT HELPERS
// ==========================================

// Your Vercel endpoint returns:
// {
//   success: true,
//   total: 10,
//   page: 1,
//   pages: 1,
//   products: [...]
// }
//
// Only accept this exact response structure.
// Do not interpret unrelated arrays as products.

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
    product.name
  );
}

function productPrice(product) {
  const discount = Number(product.discountPrice || 0);
  const price = Number(product.price || 0);

  return (
    Number.isFinite(discount) &&
    Number.isFinite(price) &&
    discount > 0 &&
    discount < price
  )
    ? discount
    : price;
}

// ==========================================
// PRODUCT SEARCH PHRASE CLEANER
// ==========================================

function extractProductSearchTerm(message = "") {
  let search = String(message || "")
    .toLowerCase()
    .trim()
    .replace(/[?!.,]/g, " ");

  const prefixes = [
    /^(please\s+)?(can you\s+)?(show|find|search|list|get|display)\s+(me\s+)?/i,
    /^(please\s+)?(do you have|have you got)\s+/i,
    /^(please\s+)?(i want|i need|i am looking for|i'm looking for|looking for)\s+/i,
    /^(please\s+)?(what is the price of|how much is|how much does)\s+/i
  ];

  for (const prefix of prefixes) {
    search = search.replace(prefix, "");
  }

  search = search
    .replace(
      /\b(available|availability|in stock|please|for sale)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  return search;
}

// ==========================================
// PRODUCT SEARCH DETECTION
// ==========================================

function isProductSearchMessage(message) {
  const text = String(message || "")
    .toLowerCase()
    .trim();

  if (!text) return false;

  const technicalQuestion =
    /\b(how does|how do|how can|how to|what is|what are|why does|why do|explain|calculate|calculate for me|difference between|work|works|working|function|functions|operate|operates|operating|install|installation|size|sizing)\b/i;

  const purchaseIntent =
    /\b(buy|purchase|order|book|checkout|i want|i need|looking for|show me|find me|search for|do you have|have you got|available|availability|in stock|price|prices|cost|how much|list products|browse products)\b/i;

  const productTerms =
    /\b(inverter|inverters|battery|batteries|lithium|tubular|solar panel|solar panels|panel|panels|charge controller|controller|controllers|solar light|solar lights|cable|cables|wire|wires|breaker|breakers|generator|generators|ups|kva|kw|watt|watts|product|products)\b/i;

  const hasProduct = productTerms.test(text);
  const hasPurchaseIntent = purchaseIntent.test(text);

  // Technical questions should normally be handled by Groq.
  if (
    technicalQuestion.test(text) &&
    !hasPurchaseIntent
  ) {
    return false;
  }

  return hasPurchaseIntent || hasProduct;
}

// ==========================================
// PAIRING CODE
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
// PRODUCT SEARCH AND BROWSING
// ==========================================

async function showProducts(jid, search = "") {
  const state = conversations.get(jid) || {};

  // Clear previous search results immediately.
  state.products = [];
  state.product = null;
  state.stage = "search";

  conversations.set(jid, state);

  const searchTerm = extractProductSearchTerm(search);

  try {
    console.log(
      "Searching Vercel product API:",
      searchTerm || "ALL PRODUCTS"
    );

    const result = await searchProducts(searchTerm);

    // Strictly read the products returned by the backend.
    const products = getProducts(result);

    console.log(
      "Products returned by API:",
      products.map(product => ({
        id: String(product._id),
        name: product.name,
        sku: product.sku,
        price: product.price,
        stock: product.countInStock
      }))
    );

    if (!products.length) {
      state.products = [];
      state.stage = "search";

      conversations.set(jid, state);

      await sendText(
        jid,
        searchTerm
          ? `I couldn't find "${searchTerm}" in our product database. Please try another product name or category.`
          : "There are currently no active products available in our store."
      );

      return;
    }

    // Backend already filters isActive:true.
    // Keep only valid product records from its response.
    const available = products
      .filter(product =>
        product._id &&
        product.name &&
        Number.isFinite(Number(product.price))
      )
      .slice(0, 8);

    if (!available.length) {
      state.products = [];
      state.stage = "search";

      conversations.set(jid, state);

      await sendText(
        jid,
        "No valid products were returned by our product database."
      );

      return;
    }

    state.products = available;
    state.stage = "select_product";

    conversations.set(jid, state);

    let response = searchTerm
      ? `*${STORE_NAME} - PRODUCT SEARCH RESULTS*\n\n`
      : `*${STORE_NAME} - AVAILABLE PRODUCTS*\n\n`;

    available.forEach((product, index) => {
      const stock = Number(product.countInStock || 0);

      response +=
        `*${index + 1}. ${product.name}*\n` +
        `Price: ${formatNaira(productPrice(product))}\n` +
        `Stock: ${stock > 0 ? stock : "Out of stock"}\n`;

      if (product.sku) {
        response += `SKU: ${product.sku}\n`;
      }

      response += "\n";
    });

    response +=
      "Reply with the product number to select it.\n\n" +
      "Type MENU to return to the main menu.";

    await sendText(jid, response);

  } catch (error) {
    console.error(
      "Product search error:",
      error.message
    );

    state.products = [];
    state.stage = "search";

    conversations.set(jid, state);

    await sendText(
      jid,
      "Sorry, I cannot check products at the moment. Please try again shortly."
    );
  }
}

// ==========================================
// CREATE CUSTOMER ORDER
// MATCHES YOUR VERCEL ORDER CONTROLLER
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

    console.log(
      "Submitting WhatsApp order to Vercel:",
      {
        productId: state.product._id,
        quantity: state.quantity,
        whatsappPhone
      }
    );

    const result = await createGuestOrder(orderData);

    if (!result || result.success !== true || !result.order) {
      throw new Error(
        result?.message || "The order API did not confirm the order."
      );
    }

    const order = result.order;

    // The current backend does not return a Monnify checkout URL.
    // Therefore, do not invent one or claim payment has been completed.
    const totalAmount = Number(order.totalAmount || 0);

    await sendText(
      jid,
      `*${STORE_NAME} - ORDER CREATED* ☀️\n\n` +
      `Your order has been successfully recorded.\n\n` +
      `Order Number: *${order.orderNumber || "Pending"}*\n` +
      `Product: ${state.product.name}\n` +
      `Quantity: ${state.quantity}\n` +
      `Total: ${formatNaira(totalAmount)}\n` +
      `Order Status: ${order.status || "pending"}\n` +
      `Payment Status: ${order.paymentStatus || "pending"}\n\n` +
      `Your order is currently awaiting payment. ` +
      `Our payment process must be completed before the order can be confirmed.\n\n` +
      `Please keep your order number for reference.`
    );

    conversations.delete(jid);
    clearAIHistory(jid);

  } catch (error) {
    console.error(
      "Order creation error:",
      error.message
    );

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
    `1️⃣ Search products\n` +
    `2️⃣ Browse products\n` +
    `3️⃣ Track an order\n` +
    `4️⃣ Customer support\n\n` +
    `You can also ask me questions about solar energy, ` +
    `inverters, batteries and electrical products.\n\n` +
    `We're happy to help! 😊`
  );
}

// ==========================================
// CUSTOMER CONVERSATION
// ==========================================

async function handleConversation(jid, text) {
  const normalized = String(text || "").toLowerCase().trim();

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
  // ACTIVE TRANSACTION STAGES
  // ========================================

  if (state.stage === "search") {
    if (normalized.length < 2) {
      await sendText(
        jid,
        "Please enter a product name or category."
      );

      return;
    }

    await showProducts(jid, text);
    return;
  }

  if (state.stage === "select_product") {
    const index = Number(text) - 1;

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= state.products.length
    ) {
      await sendText(
        jid,
        "Please enter a valid product number, or type MENU to return to the main menu."
      );

      return;
    }

    const product = state.products[index];

    if (Number(product.countInStock || 0) < 1) {
      await sendText(
        jid,
        "Sorry, this product is out of stock. Please select another product."
      );

      return;
    }

    state.product = product;
    state.stage = "quantity";

    conversations.set(jid, state);

    await sendText(
      jid,
      `You selected *${product.name}*.\n` +
      `Price: ${formatNaira(productPrice(product))}\n\n` +
      `How many would you like?`
    );

    return;
  }

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
      "Please enter your delivery postcode or ZIP code.\n\nIf your area does not have a postcode, enter the appropriate postcode for your delivery location."
    );

    return;
  }

  if (state.stage === "zipCode") {
    if (text.trim().length < 2 || text.trim().length > 20) {
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

  if (state.stage === "support") {
    await sendText(
      jid,
      "Thank you for contacting Divine Solar Hub. Your message has been received. Please contact our sales team for further assistance."
    );

    conversations.delete(jid);
    return;
  }

  // ========================================
  // MENU SHORTCUTS BEFORE GROQ
  // ========================================

  if (
    ["1", "search", "search products", "find products"].includes(normalized)
  ) {
    conversations.set(jid, { stage: "search" });

    await sendText(
      jid,
      "What product are you looking for?\n\nEnter a product name or category."
    );

    return;
  }

  if (
    ["2", "browse", "browse products", "view products", "all products"].includes(normalized)
  ) {
    conversations.set(jid, {});
    await showProducts(jid, "");
    return;
  }

  if (
    ["3", "track", "track order", "track an order"].includes(normalized)
  ) {
    conversations.set(jid, { stage: "order_number" });

    await sendText(jid, "Please enter your order number.");
    return;
  }

  if (
    ["4", "support", "customer support", "contact support"].includes(normalized)
  ) {
    conversations.set(jid, { stage: "support" });

    await sendText(
      jid,
      "Please describe what you need. Our sales representative will assist you."
    );

    return;
  }

  // ========================================
  // DIRECT PRODUCT SEARCH BEFORE GROQ
  // ========================================

  if (isProductSearchMessage(text)) {
    const searchTerm = extractProductSearchTerm(text);

    await showProducts(jid, searchTerm);
    return;
  }

  // ========================================
  // GROQ FOR GREETINGS AND GENERAL QUESTIONS
  // ========================================

  const intent = await detectMessageIntent(text);

  if (intent === "GREETING") {
    const aiResponse = await askCustomerAI(jid, text);

    conversations.set(jid, { stage: "ai_chat" });

    await sendText(jid, aiResponse);
    return;
  }

  if (intent === "MENU") {
    clearAIHistory(jid);
    await showMainMenu(jid);
    return;
  }

  if (intent === "PRODUCT") {
    const searchTerm = extractProductSearchTerm(text);

    await showProducts(jid, searchTerm);
    return;
  }

  if (intent === "TRACKING") {
    conversations.set(jid, { stage: "order_number" });

    await sendText(jid, "Please enter your order number.");
    return;
  }

  if (intent === "SUPPORT") {
    conversations.set(jid, { stage: "support" });

    await sendText(
      jid,
      "Please describe what you need. Our sales representative will assist you."
    );

    return;
  }

  // General question or ongoing AI conversation.
  const aiResponse = await askCustomerAI(jid, text);

  conversations.set(jid, { stage: "ai_chat" });

  await sendText(jid, aiResponse);
}

// ==========================================
// WHATSAPP STARTUP
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
            "Divine Solar Hub WhatsApp connected successfully."
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
            } catch (error) {
              // Read receipt failure should not block conversation.
            }

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

    console.error(
      "WhatsApp startup error:",
      error
    );

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsApp();
      }, 10000);
    }
  }
}