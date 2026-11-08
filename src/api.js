
const API_URL = process.env.VERCEL_API_URL?.replace(/\/+$/, "");
const BOT_SECRET = process.env.BOT_API_SECRET;

async function request(path, options = {}) {
  if (!API_URL || !BOT_SECRET) {
    throw new Error("Vercel API configuration is missing.");
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-bot-secret": BOT_SECRET,
      ...options.headers
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message || `Backend returned ${response.status}`
    );
  }

  return data;
}

export async function searchProducts(
  search = "",
  page = 1,
  limit = 8,
  category = ""
) {
  const params = new URLSearchParams();

  params.set("page", String(page));
  params.set("limit", String(limit));

  if (search) params.set("search", search);
  if (category) params.set("category", category);

  return request(
    `/api/whatsapp/products?${params.toString()}`
  );
}

export async function getCategories() {
  return request("/api/whatsapp/categories");
}

export async function getProductDetails(productId) {
  return request(
    `/api/whatsapp/products/${encodeURIComponent(productId)}`
  );
}

export async function createGuestOrder(orderData) {
  return request("/api/whatsapp/orders", {
    method: "POST",
    body: JSON.stringify(orderData)
  });
}

export async function getOrderStatus(orderNumber, whatsappPhone) {
  return request(
    `/api/whatsapp/orders/${encodeURIComponent(orderNumber)}` +
    `?whatsappPhone=${encodeURIComponent(whatsappPhone)}`
  );
}
