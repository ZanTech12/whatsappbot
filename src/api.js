
"use strict";

// ==========================================
// DIVINE SOLAR HUB
// WHATSAPP BOT API CONNECTION
// ==========================================

const API_URL = process.env.VERCEL_API_URL
  ?.trim()
  .replace(/\/+$/, "");

const BOT_SECRET = process.env.BOT_API_SECRET;

// ==========================================
// COMMON API REQUEST
// ==========================================

async function request(path, options = {}) {
  if (!API_URL || !BOT_SECRET) {
    throw new Error(
      "Vercel API configuration is missing. Check VERCEL_API_URL and BOT_API_SECRET."
    );
  }

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-bot-secret": BOT_SECRET,
        ...options.headers
      }
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        data?.message ||
        `Backend returned HTTP ${response.status}`
      );
    }

    if (!data) {
      throw new Error(
        "Backend returned an invalid JSON response."
      );
    }

    return data;

  } catch (error) {
    console.error(
      `WhatsApp API request failed (${path}):`,
      error.message
    );

    throw error;
  }
}

// ==========================================
// 1. SEARCH / BROWSE PRODUCTS
// ==========================================

export async function searchProducts(
  search = "",
  page = 1,
  limit = 8,
  category = ""
) {
  const params = new URLSearchParams();

  params.set("page", String(page));
  params.set("limit", String(limit));

  if (String(search).trim()) {
    params.set("search", String(search).trim());
  }

  if (String(category).trim()) {
    params.set("category", String(category).trim());
  }

  const endpoint =
    `/api/whatsapp/products?${params.toString()}`;

  console.log("WhatsApp product API request:", {
    search,
    page,
    limit,
    category,
    endpoint
  });

  const data = await request(endpoint);

  console.log("WhatsApp product API response:", {
    success: data.success,
    total: data.total,
    returned: data.products?.length
  });

  return data;
}

// ==========================================
// 2. GET PRODUCT CATEGORIES
// ==========================================

export async function getCategories() {
  return request("/api/whatsapp/categories");
}

// ==========================================
// 3. GET SINGLE PRODUCT DETAILS
// ==========================================

export async function getProductDetails(productId) {
  if (!productId) {
    throw new Error("Product ID is required.");
  }

  return request(
    `/api/whatsapp/products/${encodeURIComponent(productId)}`
  );
}

// ==========================================
// 4. CREATE GUEST ORDER
// ==========================================

export async function createGuestOrder(orderData) {
  if (!orderData || typeof orderData !== "object") {
    throw new Error("Valid order information is required.");
  }

  return request("/api/whatsapp/orders", {
    method: "POST",
    body: JSON.stringify(orderData)
  });
}

// ==========================================
// 5. TRACK ORDER
// ==========================================

export async function getOrderStatus(
  orderNumber,
  whatsappPhone
) {
  if (!orderNumber || !whatsappPhone) {
    throw new Error(
      "Order number and WhatsApp phone are required."
    );
  }

  const params = new URLSearchParams();

  params.set("whatsappPhone", whatsappPhone);

  return request(
    `/api/whatsapp/orders/${encodeURIComponent(orderNumber)}` +
    `?${params.toString()}`
  );
}
