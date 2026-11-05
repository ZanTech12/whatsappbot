
import "dotenv/config";

import express from "express";

import {
  startWhatsApp,
  getWhatsAppStatus,
  getCurrentQR,
  requestPairing,
  sendWhatsAppOTP
} from "./bot.js";

const app = express();

app.use(express.json({ limit: "20kb" }));

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BOT_API_SECRET = process.env.BOT_API_SECRET;

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");

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
// Used by Vercel backend for OTP delivery
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
// PUBLIC ROUTES
// ==========================================

app.get("/", (req, res) => {
  res.send("Divine Solar Hub WhatsApp Bot is running.");
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "Divine Solar Hub WhatsApp Bot",
    whatsapp: getWhatsAppStatus().status,
    time: new Date().toISOString()
  });
});

// ==========================================
// INTERNAL WHATSAPP OTP ENDPOINT
// Called by Vercel e-commerce backend
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

      if (typeof phone !== "string" || phone.length > 30) {
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

      await sendWhatsAppOTP(phone, otp, name || "Customer");

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
    <input id="token" type="password" placeholder="Enter your Render ADMIN_TOKEN">

    <button class="secondary" onclick="checkStatus()">
      Check connection status
    </button>

    <div id="status" class="status">Not checked yet.</div>

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
        (data.pairingCode ? "\\nPairing code: " + data.pairingCode : "");
    } catch (error) {
      document.getElementById("status").innerText = error.message;
    }
  }

  async function pairWhatsApp() {
    const phone = document.getElementById("phone").value.trim();
    const result = document.getElementById("pairResult");

    result.innerText = "Requesting pairing code...";

    try {
      const data = await api("/admin/pair", {
        method: "POST",
        body: JSON.stringify({ phoneNumber: phone })
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
        throw new Error(data.message || "QR code is not ready.");
      }

      img.src = data.qr;
      img.style.display = "block";
    } catch (error) {
      document.getElementById("status").innerText = error.message;
    }
  }

  setInterval(() => {
    if (tokenInput.value.trim()) checkStatus();
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
    const { phoneNumber } = req.body;

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp bot listening on port ${PORT}`);

  startWhatsApp();
});
