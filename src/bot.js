
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";
import QRCode from "qrcode";
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
  return `\u20A6${Number(amount || 0).toLocaleString("en-NG")}`;
}

function normalizePhone(phone) {
  let number = String(phone || "").replace(/\D/g, "");

  // Convert Nigerian local mobile numbers to international format.
  // Example: 08031234567 becomes 2348031234567.
  if (number.startsWith("0") && number.length === 11) {
    number = `234${number.slice(1)}`;
  }

  return number;
}

function getText(message) {
  const content = message.message;

  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.buttonsResponseMessage?.selectedButtonId ||
    content?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  ).trim();
}

async function sendText(jid, text) {
  if (!sock || connectionStatus !== "connected") {
    return;
  }

  await sock.sendMessage(jid, { text });
}

// ==========================================
// SEND ACCOUNT VERIFICATION OTP
// ==========================================

export async function sendWhatsAppOTP(
  phone,
  otp,
  name = "Customer"
) {
  if (!sock || connectionStatus !== "connected") {
    throw new Error(
      "WhatsApp service is not connected."
    );
  }

  const number = normalizePhone(phone);

  if (
    number.length < 10 ||
    number.length > 15
  ) {
    throw new Error(
      "Invalid WhatsApp phone number."
    );
  }

  if (!/^\d{6}$/.test(String(otp))) {
    throw new Error(
      "Invalid OTP format."
    );
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

  const jid = `${number}@s.whatsapp.net`;

  await sock.sendMessage(jid, {
    text: message
  });

  console.log(
    "WhatsApp verification message sent."
  );

  return {
    success: true
  };
}

// ==========================================
// SEND ORDER / PAYMENT / TRACKING MESSAGE
// AND OPTIONAL PDF RECEIPT
// ==========================================

export async function sendWhatsAppNotification(
  phone,
  message,
  pdfBuffer = null,
  fileName = "Divine-Solar-Hub-Receipt.pdf"
) {
  // Check WhatsApp connection.
  if (!sock || connectionStatus !== "connected") {
    throw new Error(
      "WhatsApp service is not connected."
    );
  }

  // Validate phone number.
  const number = normalizePhone(phone);

  if (
    number.length < 10 ||
    number.length > 15
  ) {
    throw new Error(
      "Invalid WhatsApp recipient phone number."
    );
  }

  // Validate message.
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

  // Send the notification message.
  await sock.sendMessage(jid, {
    text: message.trim()
  });

  console.log(
    "WhatsApp notification message sent."
  );

  // ========================================
  // OPTIONAL PDF RECEIPT
  // ========================================

  if (pdfBuffer !== null && pdfBuffer !== undefined) {
    if (!Buffer.isBuffer(pdfBuffer)) {
      throw new Error(
        "PDF receipt must be supplied as a Buffer."
      );
    }

    const MAX_PDF_SIZE = 7 * 1024 * 1024;

    if (
      !pdfBuffer.length ||
      pdfBuffer.length > MAX_PDF_SIZE
    ) {
      throw new Error(
        "PDF receipt is empty or exceeds the 7MB limit."
      );
    }

    // Validate PDF signature.
    if (
      pdfBuffer.subarray(0, 5).toString() !== "%PDF-"
    ) {
      throw new Error(
        "Invalid PDF receipt file."
      );
    }

    // Sanitize document filename.
    let safeFileName =
      String(fileName || "Divine-Solar-Hub-Receipt.pdf")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 100);

    if (!safeFileName.toLowerCase().endsWith(".pdf")) {
      safeFileName += ".pdf";
    }

    // Send PDF document.
    await sock.sendMessage(jid, {
      document: pdfBuffer,
      mimetype: "application/pdf",
      fileName: safeFileName,
      caption: "Your Divine Solar Hub PDF receipt."
    });

    console.log(
      "WhatsApp PDF receipt sent."
    );
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

function getProducts(data) {
  if (Array.isArray(data)) {
    return data;
  }

  const products =
    data?.products ??
    data?.data?.products ??
    data?.data;

  return Array.isArray(products) ? products : [];
}

function productPrice(product) {
  const discount = Number(product.discountPrice || 0);
  const price = Number(product.price || 0);

  return discount > 0 && discount < price
    ? discount
    : price;
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

    await new Promise(resolve => setTimeout(resolve, 1500));

    if (!sock || !authState || authState.creds.registered) {
      throw new Error(
        "WhatsApp socket is not ready for a new pairing request."
      );
    }

    const code = await sock.requestPairingCode(number);

    pairingCode = code;
    currentQR = null;

    connectionStatus = "pairing_code_ready";

    console.log(
      "WhatsApp pairing code generated successfully."
    );

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
  try {
    const result = await searchProducts(search);

    const products = getProducts(result);

    if (!products.length) {
      await sendText(
        jid,
        search
          ? `I couldn't find "${search}". Please try another product name or category.`
          : "There are currently no products available. Please check again later."
      );

      return;
    }

    const available = products
      .filter(product => product.isActive !== false)
      .slice(0, 8);

    if (!available.length) {
      await sendText(
        jid,
        "No active products are currently available."
      );

      return;
    }

    let response = search
      ? `*${STORE_NAME} - PRODUCT SEARCH RESULTS*\n\n`
      : `*${STORE_NAME} - AVAILABLE PRODUCTS*\n\n`;

    available.forEach((product, index) => {
      response +=
        `*${index + 1}. ${product.name}*\n` +
        `Price: ${formatNaira(productPrice(product))}\n` +
        `Stock: ${
          Number(product.countInStock || 0) > 0
            ? product.countInStock
            : "Out of stock"
        }\n\n`;
    });

    response +=
      "Reply with the product number to select it.\n\n" +
      "Type MENU to return to the main menu.";

    const state = conversations.get(jid) || {};

    state.products = available;
    state.stage = "select_product";

    conversations.set(jid, state);

    await sendText(jid, response);

  } catch (error) {
    console.error("Product search:", error.message);

    await sendText(
      jid,
      "Sorry, I cannot check products at the moment. Please try again shortly."
    );
  }
}

// ==========================================
// CREATE CUSTOMER ORDER
// ==========================================

async function createOrderFromConversation(jid, state) {
  try {
    const orderData = {
      items: [
        {
          productId: state.product._id,
          quantity: state.quantity
        }
      ],

      shippingAddress: {
        fullName: state.fullName,
        phone: state.phone,
        street: state.address,
        city: state.city,
        state: state.state,
        country: "Nigeria"
      },

      paymentMethod: "monnify",

      whatsappPhone: jid.split("@")[0]
    };

    const result = await createGuestOrder(orderData);

    const order =
      result.order ||
      result.data?.order ||
      result.data ||
      {};

    const checkoutUrl =
      result.checkoutUrl ||
      order.checkoutUrl;

    if (!checkoutUrl) {
      throw new Error(
        "No Monnify checkout URL was returned."
      );
    }

    await sendText(
      jid,
      `*${STORE_NAME} - ORDER CREATED*\n\n` +
      `Order: ${order.orderNumber || result.orderNumber || "Created"}\n` +
      `Product: ${state.product.name}\n` +
      `Quantity: ${state.quantity}\n` +
      `Total: ${formatNaira(order.totalAmount || result.totalAmount)}\n\n` +
      `Please complete your payment using this secure link:\n` +
      `${checkoutUrl}\n\n` +
      `Your order will be confirmed after Monnify verifies the payment.`
    );

    conversations.delete(jid);

  } catch (error) {
    console.error("Order creation:", error.message);

    await sendText(
      jid,
      "I couldn't complete your order. Please try again or contact our sales team."
    );
  }
}

// ==========================================
// CUSTOMER CONVERSATION
// ==========================================

async function handleConversation(jid, text) {
  const normalized = text.toLowerCase().trim();

  let state = conversations.get(jid) || {};

  // ========================================
  // MAIN MENU
  // ========================================

  if (
    [
      "hi",
      "hello",
      "hey",
      "good morning",
      "good afternoon",
      "good evening",
      "menu",
      "start"
    ].includes(normalized)
  ) {
    conversations.set(jid, {});

    await sendText(
      jid,
      `Welcome to *${STORE_NAME}*!\n\n` +
      `How can we help you?\n\n` +
      `1. Search products\n` +
      `2. Browse products\n` +
      `3. Track an order\n` +
      `4. Customer support\n\n` +
      `You can also type a product name directly.`
    );

    return;
  }

  // ========================================
  // SEARCH PRODUCTS
  // ========================================

  if (
    [
      "1",
      "search",
      "search products",
      "find products"
    ].includes(normalized)
  ) {
    conversations.set(jid, {
      stage: "search"
    });

    await sendText(
      jid,
      "What product are you looking for?\n\nEnter a product name or category."
    );

    return;
  }

  // ========================================
  // BROWSE PRODUCTS
  // ========================================

  if (
    [
      "2",
      "browse",
      "browse products",
      "view products",
      "all products"
    ].includes(normalized)
  ) {
    conversations.set(jid, {});

    await showProducts(jid, "");

    return;
  }

  // ========================================
  // TRACK ORDER
  // ========================================

  if (
    [
      "3",
      "track",
      "track order",
      "track an order"
    ].includes(normalized)
  ) {
    conversations.set(jid, {
      stage: "order_number"
    });

    await sendText(
      jid,
      "Please enter your order number."
    );

    return;
  }

  // ========================================
  // CUSTOMER SUPPORT
  // ========================================

  if (
    [
      "4",
      "support",
      "customer support",
      "contact support"
    ].includes(normalized)
  ) {
    conversations.set(jid, {
      stage: "support"
    });

    await sendText(
      jid,
      "Please describe what you need. Our sales representative will assist you."
    );

    return;
  }

  // ========================================
  // STOP CURRENT CONVERSATION
  // ========================================

  if (
    [
      "stop",
      "cancel",
      "exit"
    ].includes(normalized)
  ) {
    conversations.delete(jid);

    await sendText(
      jid,
      "Your current automated conversation has been stopped. Send MENU whenever you want to start again."
    );

    return;
  }

  // ========================================
  // SEARCH INPUT
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

  // ========================================
  // CUSTOMER SUPPORT MESSAGE
  // ========================================

  if (state.stage === "support") {
    await sendText(
      jid,
      "Thank you for contacting Divine Solar Hub. Your message has been received. Please contact our sales team for further assistance."
    );

    conversations.delete(jid);

    return;
  }

  // ========================================
  // PRODUCT SELECTION
  // ========================================

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
        "Sorry, this product is out of stock."
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

    await sendText(
      jid,
      "Please enter your full name."
    );

    return;
  }

  // ========================================
  // FULL NAME
  // ========================================

  if (state.stage === "full_name") {
    if (text.length < 3 || text.length > 100) {
      await sendText(
        jid,
        "Please enter your full name."
      );

      return;
    }

    state.fullName = text;
    state.stage = "phone";

    conversations.set(jid, state);

    await sendText(
      jid,
      "Enter your delivery phone number."
    );

    return;
  }

  // ========================================
  // DELIVERY PHONE
  // ========================================

  if (state.stage === "phone") {
    const phone = normalizePhone(text);

    if (phone.length < 10 || phone.length > 15) {
      await sendText(
        jid,
        "Please enter a valid phone number."
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

    state.address = text;
    state.stage = "city";

    conversations.set(jid, state);

    await sendText(
      jid,
      "Which city or town?"
    );

    return;
  }

  // ========================================
  // CITY
  // ========================================

  if (state.stage === "city") {
    state.city = text;
    state.stage = "state";

    conversations.set(jid, state);

    await sendText(
      jid,
      "Which state in Nigeria?"
    );

    return;
  }

  // ========================================
  // STATE AND ORDER CREATION
  // ========================================

  if (state.stage === "state") {
    state.state = text;

    conversations.set(jid, state);

    await sendText(
      jid,
      "Please wait while I prepare your order and payment link."
    );

    await createOrderFromConversation(jid, state);

    return;
  }

  // ========================================
  // ORDER NUMBER
  // ========================================

  if (state.stage === "order_number") {
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
  // ORDER STATUS
  // ========================================

  if (state.stage === "order_phone") {
    try {
      const phone = normalizePhone(text);

      if (phone.length < 10 || phone.length > 15) {
        await sendText(
          jid,
          "Please enter a valid phone number."
        );

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

      await sendText(
        jid,
        `*ORDER STATUS*\n\n` +
        `Order: ${order.orderNumber}\n` +
        `Status: ${order.status}\n` +
        `Payment: ${order.paymentStatus}\n` +
        `Total: ${formatNaira(order.totalAmount)}`
      );

      conversations.delete(jid);

    } catch (error) {
      console.error(
        "Order lookup:",
        error.message
      );

      await sendText(
        jid,
        "I couldn't verify this order. Please check your order number and phone number."
      );
    }

    return;
  }

  // ========================================
  // DEFAULT: DIRECT PRODUCT SEARCH
  // ========================================

  await showProducts(jid, text);
}

// ==========================================
// WHATSAPP STARTUP
// ==========================================

export async function startWhatsApp() {
  if (starting) {
    console.log(
      "WhatsApp startup already in progress."
    );

    return;
  }

  starting = true;

  try {
    fs.mkdirSync(
      AUTH_FOLDER,
      { recursive: true }
    );

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

        // QR EVENT

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

              console.log(
                "WhatsApp QR code generated."
              );

            } catch (error) {
              console.error(
                "QR generation failed:",
                error.message
              );
            }
          }
        }

        // CONNECTION OPEN

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

        // CONNECTION CLOSED

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

            if (connectionStatus !== "connected") {
              continue;
            }

            await sock.readMessages([
              message.key
            ]);

            console.log(
              "Incoming WhatsApp customer message received."
            );

            await handleConversation(jid, text);

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
