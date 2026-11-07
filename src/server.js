
import "dotenv/config";
import express from "express";

import {
  startWhatsApp,
  getWhatsAppStatus,
  getCurrentQR,
  requestPairing,
  sendWhatsAppOTP,
  sendWhatsAppNotification
} from "./bot.js";

const app = express();

// ==========================================
// CONFIGURATION
// ==========================================

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BOT_API_SECRET = process.env.BOT_API_SECRET;

const MAX_PDF_SIZE = 7 * 1024 * 1024;
const SERVER_STARTED_AT = new Date().toISOString();

app.use(express.json({ limit: "12mb" }));

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace(
    /^Bearer\s+/i,
    ""
  );

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();
}

// ==========================================
// INTERNAL BOT SERVICE AUTHENTICATION
// ==========================================

function botServiceAuth(req, res, next) {
  const secret = req.headers["x-bot-secret"];

  if (!BOT_API_SECRET || secret !== BOT_API_SECRET) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized bot service request."
    });
  }

  next();
}

// ==========================================
// PHONE VALIDATION
// ==========================================

function isValidPhone(phone) {
  return (
    typeof phone === "string" &&
    /^\+?\d{10,15}$/.test(phone.trim())
  );
}

// ==========================================
// PUBLIC ROUTES
// ==========================================

app.get("/", (req, res) => {
  res.status(200).send(
    "Divine Solar Hub WhatsApp Bot is running."
  );
});

// ==========================================
// UPTIMEROBOT HEALTH CHECK
// ==========================================

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "online",
    service: "Divine Solar Hub WhatsApp Bot",

    server: {
      status: "running",
      uptime: Math.floor(process.uptime()),
      startedAt: SERVER_STARTED_AT
    },

    whatsapp: getWhatsAppStatus().status,

    timestamp: new Date().toISOString()
  });
});

// ==========================================
// INTERNAL WHATSAPP OTP ENDPOINT
// ==========================================

app.post(
  "/internal/send-otp",
  botServiceAuth,
  async (req, res) => {
    try {
      const { phone, otp, name } = req.body || {};

      if (!phone || !otp) {
        return res.status(400).json({
          success: false,
          message: "Phone number and OTP are required."
        });
      }

      if (!/^\d{6}$/.test(String(otp))) {
        return res.status(400).json({
          success: false,
          message: "Invalid OTP format."
        });
      }

      if (!isValidPhone(phone)) {
        return res.status(400).json({
          success: false,
          message: "Invalid phone number."
        });
      }

      if (name !== undefined && typeof name !== "string") {
        return res.status(400).json({
          success: false,
          message: "Invalid customer name."
        });
      }

      await sendWhatsAppOTP(
        phone,
        otp,
        name || "Customer"
      );

      return res.status(200).json({
        success: true,
        message: "WhatsApp OTP sent successfully."
      });

    } catch (error) {
      console.error(
        "WHATSAPP OTP DELIVERY ERROR:",
        error.message
      );

      return res.status(503).json({
        success: false,
        message: "WhatsApp OTP delivery failed."
      });
    }
  }
);

// ==========================================
// INTERNAL ORDER / PAYMENT NOTIFICATION
// ==========================================

app.post(
  "/internal/send-notification",
  botServiceAuth,
  async (req, res) => {
    try {
      const {
        phone,
        message,
        pdfBase64,
        fileName
      } = req.body || {};

      // Validate customer phone.
      if (!isValidPhone(phone)) {
        return res.status(400).json({
          success: false,
          message: "A valid customer phone number is required."
        });
      }

      // Validate notification message.
      if (
        typeof message !== "string" ||
        !message.trim() ||
        message.length > 10000
      ) {
        return res.status(400).json({
          success: false,
          message: "A valid notification message is required."
        });
      }

      let pdfBuffer = null;

      // ======================================
      // OPTIONAL PDF RECEIPT VALIDATION
      // ======================================

      if (pdfBase64 !== undefined && pdfBase64 !== null) {
        if (
          typeof pdfBase64 !== "string" ||
          !pdfBase64.trim()
        ) {
          return res.status(400).json({
            success: false,
            message: "Invalid PDF receipt data."
          });
        }

        // Estimate decoded Base64 size.
        const estimatedSize = Math.floor(
          pdfBase64.length * 0.75
        );

        if (estimatedSize > MAX_PDF_SIZE) {
          return res.status(413).json({
            success: false,
            message: "PDF receipt exceeds the 7MB limit."
          });
        }

        // Decode Base64.
        pdfBuffer = Buffer.from(pdfBase64, "base64");

        // Validate actual decoded size.
        if (
          !pdfBuffer.length ||
          pdfBuffer.length > MAX_PDF_SIZE
        ) {
          return res.status(400).json({
            success: false,
            message: "Invalid or oversized PDF receipt."
          });
        }

        // Validate PDF signature.
        if (
          pdfBuffer.subarray(0, 5).toString() !== "%PDF-"
        ) {
          return res.status(400).json({
            success: false,
            message: "The supplied document is not a valid PDF."
          });
        }
      }

      // ======================================
      // SAFE FILE NAME
      // ======================================

      const safeFileName =
        typeof fileName === "string" && fileName.trim()
          ? fileName
              .replace(/[^a-zA-Z0-9._-]/g, "_")
              .slice(0, 100)
          : "Divine-Solar-Hub-Receipt.pdf";

      // ======================================
      // SEND WHATSAPP NOTIFICATION
      // ======================================

      await sendWhatsAppNotification(
        phone,
        message.trim(),
        pdfBuffer,
        safeFileName
      );

      return res.status(200).json({
        success: true,
        message: pdfBuffer
          ? "WhatsApp notification and PDF receipt sent successfully."
          : "WhatsApp notification sent successfully.",
        receiptSent: Boolean(pdfBuffer)
      });

    } catch (error) {
      console.error(
        "WHATSAPP NOTIFICATION ERROR:",
        error.message
      );

      return res.status(503).json({
        success: false,
        message: "WhatsApp notification delivery failed."
      });
    }
  }
);

// ==========================================
// ADMIN DASHBOARD
// ==========================================

app.get("/admin", (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Divine Solar Hub WhatsApp Admin</title>

  <style>
    body {
      font-family: Arial, sans-serif;
      background: #f4f6f8;
      padding: 25px;
      margin: 0;
    }

    .container {
      max-width: 480px;
      margin: 30px auto;
      background: white;
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 4px 20px #0001;
    }

    input, button {
      box-sizing: border-box;
      width: 100%;
      padding: 13px;
      margin: 8px 0;
      border-radius: 7px;
      border: 1px solid #ccc;
      font-size: 15px;
    }

    button {
      background: #087b45;
      color: white;
      border: 0;
      cursor: pointer;
    }

    button.secondary {
      background: #185abd;
    }

    #qr {
      width: 260px;
      max-width: 100%;
      display: none;
      margin: 20px auto;
    }

    .status {
      padding: 12px;
      background: #f0f4f6;
      border-radius: 7px;
      margin: 15px 0;
    }

    .hint {
      color: #666;
      font-size: 13px;
      line-height: 1.5;
    }
  </style>
</head>

<body>

  <div class="container">

    <h2>Divine Solar Hub</h2>
    <h3>WhatsApp Connection</h3>

    <label>Admin token</label>

    <input
      id="token"
      type="password"
      placeholder="Enter your Render ADMIN_TOKEN"
    >

    <button class="secondary" onclick="checkStatus()">
      Check connection status
    </button>

    <div id="status" class="status">
      Not checked yet.
    </div>

    <hr>

    <h3>Option 1: Pair using phone number</h3>

    <input
      id="phone"
      type="tel"
      placeholder="2348012345678"
    >

    <button onclick="pairWhatsApp()">
      Generate pairing code
    </button>

    <div id="pairResult" class="status">
      Your pairing code will appear here.
    </div>

    <p class="hint">
      Enter your number with country code, digits only.
      For Nigeria, use 234 followed by your number.
    </p>

    <hr>

    <h3>Option 2: Connect with QR code</h3>

    <button class="secondary" onclick="loadQR()">
      Display QR code
    </button>

    <img id="qr" alt="WhatsApp QR code">

    <p class="hint">
      Open WhatsApp Business → Linked Devices →
      Link a Device and scan the QR code.
    </p>

  </div>

<script>
  const tokenInput = document.getElementById("token");

  async function api(path, options = {}) {
    const token = tokenInput.value.trim();

    if (!token) {
      throw new Error("Enter your admin token first.");
    }

    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        ...(options.headers || {})
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.message || "Request failed");
    }

    return data;
  }

  async function checkStatus() {
    try {
      const data = await api("/admin/status");

      document.getElementById("status").innerText =
        "WhatsApp status: " + data.status +
        (data.pairingCode
          ? "\\nPairing code: " + data.pairingCode
          : "");

    } catch (error) {
      document.getElementById("status").innerText =
        error.message;
    }
  }

  async function pairWhatsApp() {
    const phone = document.getElementById("phone").value.trim();
    const result = document.getElementById("pairResult");

    result.innerText = "Requesting pairing code...";

    try {
      const data = await api("/admin/pair", {
        method: "POST",
        body: JSON.stringify({
          phoneNumber: phone
        })
      });

      result.innerText = data.message;

      setTimeout(checkStatus, 3000);
      setTimeout(checkStatus, 8000);

    } catch (error) {
      result.innerText = error.message;
    }
  }

  async function loadQR() {
    const img = document.getElementById("qr");

    try {
      const data = await api("/admin/qr");

      if (!data.qr) {
        img.style.display = "none";

        throw new Error(
          data.message || "QR code is not ready."
        );
      }

      img.src = data.qr;
      img.style.display = "block";

    } catch (error) {
      document.getElementById("status").innerText =
        error.message;
    }
  }

  // Refresh WhatsApp connection status.
  setInterval(() => {
    if (tokenInput.value.trim()) {
      checkStatus();
    }
  }, 15000);
</script>

</body>
</html>
  `);
});

// ==========================================
// ADMIN STATUS
// ==========================================

app.get("/admin/status", adminAuth, (req, res) => {
  res.json({
    success: true,
    ...getWhatsAppStatus()
  });
});

// ==========================================
// ADMIN QR CODE
// ==========================================

app.get("/admin/qr", adminAuth, (req, res) => {
  const qr = getCurrentQR();

  if (!qr) {
    return res.json({
      success: false,
      message: "QR code is not currently available."
    });
  }

  res.json({
    success: true,
    qr
  });
});

// ==========================================
// ADMIN PAIRING
// ==========================================

app.post("/admin/pair", adminAuth, async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required."
      });
    }

    const result = await requestPairing(phoneNumber);

    res.json(result);

  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// ==========================================
// START SERVER AND WHATSAPP
// ==========================================

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Divine Solar Hub WhatsApp Bot listening on port ${PORT}`
  );

  console.log("Health check: /health");

  startWhatsApp();
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

function shutdown(signal) {
  console.log(`${signal} received. Shutting down server...`);

  server.close(() => {
    console.log("Express server closed.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
