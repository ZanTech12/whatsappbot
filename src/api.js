
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
// CONFIGURATION
// ==========================================

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
const REQUEST_TIMEOUT = 20000;

// ==========================================
// COMMON API REQUEST
// ==========================================

async function request(path, options = {}) {
  if (!API_URL || !BOT_SECRET) {
    throw new Error(
      "Missing VERCEL_API_URL or BOT_API_SECRET."
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-bot-secret": BOT_SECRET,
        ...options.headers
      }
    });

    const raw = await response.text();

    let data;

    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(
        `Backend returned invalid JSON. HTTP ${response.status}.`
      );
    }

    if (!response.ok) {
      throw new Error(
        data?.message ||
        data?.error ||
        `Backend returned HTTP ${response.status}.`
      );
    }

    if (!data || typeof data !== "object") {
      throw new Error(
        "Backend returned an empty or invalid response."
      );
    }

    if (data.success === false) {
      throw new Error(
        data.message || "The API request was unsuccessful."
      );
    }

    return data;

  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Backend request timed out.");
    }

    console.error(
      `WhatsApp API error [${path}]:`,
      error.message
    );

    throw error;

  } finally {
    clearTimeout(timeout);
  }
}

// ==========================================
// HELPERS
// ==========================================

function safeNumber(value, fallback, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(number)));
}

function encode(value) {
  return encodeURIComponent(String(value));
}

// ==========================================
// 1. SEARCH / BROWSE PRODUCTS
// ==========================================

export async function searchProducts(
  search = "",
  page = 1,
  limit = DEFAULT_LIMIT,
  category = ""
) {
  const params = new URLSearchParams();

  const normalizedSearch = String(search || "").trim();
  const normalizedCategory = String(category || "").trim();

  const currentPage = safeNumber(page, 1, 1, 100000);
  const currentLimit = safeNumber(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  params.set("page", String(currentPage));
  params.set("limit", String(currentLimit));

  if (normalizedSearch) {
    params.set("search", normalizedSearch);
  }

  if (normalizedCategory) {
    params.set("category", normalizedCategory);
  }

  const endpoint = `/api/whatsapp/products?${params.toString()}`;

  console.log("WhatsApp product API request:", {
    search: normalizedSearch,
    page: currentPage,
    limit: currentLimit,
    category: normalizedCategory,
    endpoint
  });

  const data = await request(endpoint);

  const products = Array.isArray(data.products)
    ? data.products
    : [];

  console.log("WhatsApp product API response:", {
    success: data.success,
    total: data.total,
    returned: products.length
  });

  return {
    ...data,
    products,
    total: Number(data.total) || products.length,
    page: Number(data.page) || currentPage,
    limit: Number(data.limit) || currentLimit
  };
}

// ==========================================
// 2. GET PRODUCT CATEGORIES
// ==========================================

export async function getCategories() {
  const data = await request(
    "/api/whatsapp/categories"
  );

  return {
    ...data,
    categories: Array.isArray(data.categories)
      ? data.categories
      : []
  };
}

// ==========================================
// 3. GET SINGLE PRODUCT DETAILS
// ==========================================

export async function getProductDetails(productId) {
  if (!productId) {
    throw new Error("Product ID is required.");
  }

  return request(
    `/api/whatsapp/products/${encode(productId)}`
  );
}

// ==========================================
// 4. CREATE GUEST ORDER
// ==========================================

export async function createGuestOrder(orderData) {
  if (
    !orderData ||
    typeof orderData !== "object" ||
    Array.isArray(orderData)
  ) {
    throw new Error(
      "Valid order information is required."
    );
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
    `/api/whatsapp/orders/${encode(orderNumber)}?${params.toString()}`
  );
}

// ==========================================
// 6. GET ALL PRODUCTS
// ==========================================

export async function getAllProducts() {
  return searchProducts("", 1, MAX_LIMIT);
}

// ==========================================
// 7. SEARCH PRODUCTS BY CATEGORY
// ==========================================

export async function searchProductsByCategory(
  category,
  page = 1,
  limit = DEFAULT_LIMIT
) {
  if (!category) {
    throw new Error("Category is required.");
  }

  return searchProducts(
    "",
    page,
    limit,
    category
  );
}

// ==========================================
// 8. SEARCH PRODUCTS BY NAME
// ==========================================

export async function findProducts(search) {
  if (!String(search || "").trim()) {
    return searchProducts("", 1, DEFAULT_LIMIT);
  }

  return searchProducts(
    search,
    1,
    DEFAULT_LIMIT
  );
}
