const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 3000);
const TABLE_COUNT = 20;
const CANCELLATION_WINDOW_MS = 4 * 60 * 1000;
const ORDER_ACTIVE_MS = 6 * 60 * 60 * 1000;
const DB_PATH = process.env.RESTAURANT_DB_PATH || path.join(__dirname, "restaurant_details.db");
const QR_CODE_PATH = process.env.QR_CODE_PATH || path.join(__dirname, "restaurant-menu-qr.png");
const PUBLIC_DIR = path.join(__dirname, "public");

const seedMenu = [
  ["Paneer Tikka", "Starter", "North Indian", "veg", "Smoky paneer, peppers and house spices", 220, 1],
  ["Vegetable Spring Rolls", "Starter", "Chinese", "veg", "Crispy rolls with sweet chilli dip", 180, 1],
  ["Chicken 65", "Starter", "South Indian", "non-veg", "Spicy fried chicken with curry leaves", 260, 1],
  ["Chilli Chicken", "Starter", "Chinese", "non-veg", "Chicken tossed with peppers and chilli sauce", 280, 1],
  ["Tomato Soup", "Starter", "Italian", "veg", "Slow-simmered tomato and basil soup", 150, 0],
  ["Margherita Pizza", "Main Course", "Italian", "veg", "Stone-baked pizza with mozzarella and basil", 350, 1],
  ["Farmhouse Pizza", "Main Course", "Italian", "veg", "Loaded with peppers, onion, mushroom and corn", 420, 1],
  ["Classic Chicken Burger", "Main Course", "Italian", "non-veg", "Grilled chicken, lettuce and house sauce", 320, 1],
  ["Veggie Burger", "Main Course", "Italian", "veg", "Crispy vegetable patty with fresh lettuce", 260, 1],
  ["Butter Chicken", "Main Course", "North Indian", "non-veg", "Creamy tomato gravy with tender chicken", 390, 1],
  ["Paneer Butter Masala", "Main Course", "North Indian", "veg", "Paneer in a rich, mildly spiced tomato gravy", 320, 1],
  ["Dal Makhani", "Main Course", "North Indian", "veg", "Slow-cooked black lentils finished with cream", 280, 1],
  ["Chicken Biryani", "Main Course", "South Indian", "non-veg", "Fragrant basmati rice with spiced chicken", 360, 1],
  ["Masala Dosa", "Main Course", "South Indian", "veg", "Crisp rice crepe with potato masala and chutneys", 220, 1],
  ["Idli Sambar", "Main Course", "South Indian", "veg", "Steamed idlis with sambar and coconut chutney", 160, 1],
  ["Veg Hakka Noodles", "Main Course", "Chinese", "veg", "Wok-tossed noodles with seasonal vegetables", 240, 1],
  ["Gulab Jamun", "Dessert", "North Indian", "veg", "Warm milk dumplings in rose-cardamom syrup", 120, 1],
  ["Chocolate Brownie", "Dessert", "Italian", "veg", "Warm chocolate brownie with a soft centre", 180, 0],
  ["Papad", "Supplementary", "North Indian", "veg", "Roasted crunchy lentil papad", 40, 1],
  ["Garden Salad", "Supplementary", "North Indian", "veg", "Cucumber, tomato, onion and lemon", 90, 1],
  ["Coconut Chutney", "Supplementary", "South Indian", "veg", "Fresh coconut and curry leaf chutney", 50, 1]
];

function createDatabase() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      cuisine TEXT NOT NULL,
      dietary TEXT NOT NULL CHECK (dietary IN ('veg', 'non-veg')),
      description TEXT NOT NULL,
      price INTEGER NOT NULL CHECK (price >= 0),
      available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS table_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number INTEGER NOT NULL CHECK (table_number BETWEEN 1 AND 20),
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'occupied' CHECK (status IN ('occupied', 'vacated')),
      opened_at INTEGER NOT NULL,
      left_at INTEGER,
      expired_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_number INTEGER NOT NULL CHECK (table_number BETWEEN 1 AND 20),
      phone TEXT NOT NULL,
      session_id INTEGER REFERENCES table_sessions(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      cancellation_deadline INTEGER NOT NULL,
      menu_changed_at INTEGER,
      added_at INTEGER NOT NULL,
      modified_at INTEGER,
      cancelled_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      order_item_id INTEGER REFERENCES order_items(id),
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'queued'
    );
  `);

  const orderColumns = db.prepare("PRAGMA table_info(orders)").all();
  const hasLegacyBillId = orderColumns.some((column) => column.name === "bill_id");
  if (!orderColumns.some((column) => column.name === "session_id")) {
    db.exec("ALTER TABLE orders ADD COLUMN session_id INTEGER REFERENCES table_sessions(id)");
  }
  if (!orderColumns.some((column) => column.name === "expires_at")) {
    db.exec("ALTER TABLE orders ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0");
    db.exec(`UPDATE orders SET expires_at = created_at + ${ORDER_ACTIVE_MS} WHERE expires_at = 0`);
  }
  const sessionColumns = db.prepare("PRAGMA table_info(table_sessions)").all();
  if (!sessionColumns.some((column) => column.name === "expired_at")) {
    db.exec("ALTER TABLE table_sessions ADD COLUMN expired_at INTEGER");
  }

  const insertLegacySession = db.prepare(`
    INSERT INTO table_sessions (table_number, phone, status, opened_at, left_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((table) => table.name);
  if (tableNames.includes("table_bills")) {
    const billColumns = db.prepare("PRAGMA table_info(table_bills)").all();
    if (!billColumns.some((column) => column.name === "session_id")) {
      db.exec("ALTER TABLE table_bills ADD COLUMN session_id INTEGER REFERENCES table_sessions(id)");
    }

    const legacySessionGroups = db.prepare(`
      SELECT table_number, phone, MIN(opened_at) AS opened_at,
        MAX(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS has_open_bill
      FROM table_bills
      WHERE session_id IS NULL
      GROUP BY table_number, phone
      ORDER BY table_number, MIN(opened_at)
    `).all();
    const linkLegacyBills = db.prepare(`
      UPDATE table_bills SET session_id = ?
      WHERE table_number = ? AND phone = ? AND session_id IS NULL
    `);
    for (const legacySession of legacySessionGroups) {
      const status = legacySession.has_open_bill ? "occupied" : "vacated";
      const sessionId = Number(insertLegacySession.run(
        legacySession.table_number,
        legacySession.phone,
        status,
        legacySession.opened_at,
        status === "vacated" ? legacySession.opened_at : null
      ).lastInsertRowid);
      linkLegacyBills.run(sessionId, legacySession.table_number, legacySession.phone);
    }

    if (hasLegacyBillId) {
      db.exec(`
        UPDATE orders
        SET session_id = (
          SELECT table_bills.session_id
          FROM table_bills
          WHERE table_bills.id = orders.bill_id
        )
        WHERE session_id IS NULL AND bill_id IS NOT NULL;
      `);
    }
  }

  const unassignedOrderGroups = db.prepare(`
    SELECT table_number, phone, MIN(created_at) AS opened_at
    FROM orders
    WHERE session_id IS NULL
    GROUP BY table_number, phone
    ORDER BY table_number, MIN(created_at)
  `).all();
  for (const group of unassignedOrderGroups) {
    const existing = db.prepare(`
      SELECT id FROM table_sessions
      WHERE table_number = ? AND phone = ? AND status = 'occupied'
      ORDER BY id DESC LIMIT 1
    `).get(group.table_number, group.phone);
    const sessionId = existing
      ? existing.id
      : Number(db.prepare(`
        INSERT INTO table_sessions (table_number, phone, opened_at)
        VALUES (?, ?, ?)
      `).run(group.table_number, group.phone, group.opened_at).lastInsertRowid);
    db.prepare(`
      UPDATE orders SET session_id = ?
      WHERE table_number = ? AND phone = ? AND session_id IS NULL
    `).run(sessionId, group.table_number, group.phone);
  }

  const itemColumns = db.prepare("PRAGMA table_info(order_items)").all();
  if (!itemColumns.some((column) => column.name === "added_at")) {
    db.exec("ALTER TABLE order_items ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE order_items
      SET added_at = COALESCE(
        (SELECT created_at FROM orders WHERE orders.id = order_items.order_id),
        ${Date.now()}
      )
      WHERE added_at = 0;
    `);
  }
  if (!itemColumns.some((column) => column.name === "modified_at")) {
    db.exec("ALTER TABLE order_items ADD COLUMN modified_at INTEGER");
  }
  if (!itemColumns.some((column) => column.name === "cancelled_at")) {
    db.exec("ALTER TABLE order_items ADD COLUMN cancelled_at INTEGER");
  }

  const count = db.prepare("SELECT COUNT(*) AS count FROM menu_items").get().count;
  if (count === 0) {
    const insertItem = db.prepare(`
      INSERT INTO menu_items (name, category, cuisine, dietary, description, price, available, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const item of seedMenu) insertItem.run(...item, now);
  }
  expireOldOrders(db);
  return db;
}

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function menuItemRow(row) {
  return { ...row, available: Boolean(row.available) };
}

function getLanAddress() {
  const adapters = Object.entries(os.networkInterfaces()).map(([name, addresses]) => ({
    name,
    addresses: (addresses || [])
      .filter((address) =>
        address.family === "IPv4"
        && !address.internal
        && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)
      )
      .map((address) => address.address)
  })).filter((adapter) => adapter.addresses.length > 0);
  const preferred = adapters.filter((adapter) =>
    /wi-?fi|ethernet/i.test(adapter.name)
    && !/virtual|vmware|virtualbox|hyper-v|wsl|docker|vpn|loopback|bluetooth/i.test(adapter.name)
  );
  const otherPhysical = adapters.filter((adapter) =>
    !/virtual|vmware|virtualbox|hyper-v|wsl|docker|vpn|loopback|bluetooth/i.test(adapter.name)
  );
  return [...preferred, ...otherPhysical]
    .flatMap((adapter) => adapter.addresses)[0];
}

function getMenuUrl() {
  const configuredBaseUrl = process.env.PUBLIC_BASE_URL;
  if (configuredBaseUrl) {
    const publicUrl = new URL(configuredBaseUrl);
    if (!["http:", "https:"].includes(publicUrl.protocol)) {
      throw new Error("PUBLIC_BASE_URL must use HTTP or HTTPS.");
    }
    return new URL("/", publicUrl).toString();
  }
  const hostname = getLanAddress() || "localhost";
  return `http://${hostname}:${PORT}`;
}

function createServer(db) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    try {
      if (request.method === "GET" && url.pathname === "/api/menu") {
        const rows = db.prepare("SELECT * FROM menu_items ORDER BY category, cuisine, name").all();
        return sendJson(response, 200, rows.map(menuItemRow));
      }

      if (request.method === "GET" && url.pathname === "/api/qr") {
        const menuUrl = getMenuUrl();
        const qrOptions = { width: 1200, margin: 4 };
        await QRCode.toFile(QR_CODE_PATH, menuUrl, qrOptions);
        const qrDataUrl = await QRCode.toDataURL(menuUrl, qrOptions);
        return sendJson(response, 200, { menuUrl, qrDataUrl });
      }

      if (request.method === "POST" && url.pathname === "/api/orders") {
        expireOldOrders(db);
        const body = await readJson(request);
        const tableNumber = Number(body.tableNumber);
        const phone = String(body.phone || "").trim();
        const items = body.items;
        if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > TABLE_COUNT) {
          return sendJson(response, 400, { error: "Choose a valid table number (1-20)." });
        }
        if (!/^[+()\d\s-]{7,20}$/.test(phone) || phone.replace(/\D/g, "").length < 7) {
          return sendJson(response, 400, { error: "Enter a valid phone number to place your order." });
        }
        if (!Array.isArray(items) || items.length === 0) {
          return sendJson(response, 400, { error: "Add at least one available menu item." });
        }

        const uniqueItems = new Map();
        for (const item of items) {
          const id = Number(item.id);
          const quantity = Number(item.quantity);
          if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
            return sendJson(response, 400, { error: "Each item needs a valid quantity (1-20)." });
          }
          uniqueItems.set(id, (uniqueItems.get(id) || 0) + quantity);
        }
        if ([...uniqueItems.values()].some((quantity) => quantity > 20)) {
          return sendJson(response, 400, { error: "An item quantity cannot exceed 20." });
        }

        const selectedItems = [];
        for (const [id, quantity] of uniqueItems) {
          const item = db.prepare("SELECT * FROM menu_items WHERE id = ?").get(id);
          if (!item) return sendJson(response, 400, { error: "A selected menu item no longer exists." });
          if (!item.available) {
            return sendJson(response, 409, { error: `${item.name} is currently unavailable. Remove it from your order.` });
          }
          selectedItems.push({ ...item, quantity });
        }

        const now = Date.now();
        const phoneDigits = phone.replace(/\D/g, "");
        const activePhoneSession = db.prepare(`
          SELECT table_sessions.*, orders.phone AS order_phone
          FROM table_sessions
          LEFT JOIN orders ON orders.session_id = table_sessions.id
          WHERE table_sessions.status = 'occupied' AND table_sessions.expired_at IS NULL
          ORDER BY table_sessions.id DESC
        `).all().find((session) =>
          session.phone.replace(/\D/g, "") === phoneDigits
          || (session.order_phone && session.order_phone.replace(/\D/g, "") === phoneDigits)
        );
        if (activePhoneSession && activePhoneSession.table_number !== tableNumber) {
          return sendJson(response, 409, {
            error: `This phone number already has an active session at table ${activePhoneSession.table_number}. Finish that session before ordering from another table.`
          });
        }

        const occupiedSessions = db.prepare(`
          SELECT * FROM table_sessions
          WHERE table_number = ? AND status = 'occupied' AND expired_at IS NULL
          ORDER BY id DESC
        `).all(tableNumber);
        if (occupiedSessions.length > 1) {
          return sendJson(response, 409, {
            error: `Table ${tableNumber} has multiple active sessions. Staff must resolve them before placing another order.`
          });
        }
        const activeSession = occupiedSessions[0];

        db.exec("BEGIN");
        try {
          const sessionId = activeSession
            ? activeSession.id
            : Number(db.prepare(`
              INSERT INTO table_sessions (table_number, phone, opened_at)
              VALUES (?, ?, ?)
            `).run(tableNumber, phone, now).lastInsertRowid);
          const result = db.prepare(`
            INSERT INTO orders (table_number, phone, session_id, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(tableNumber, phone, sessionId, now, now + ORDER_ACTIVE_MS);
          const orderId = Number(result.lastInsertRowid);
          const insertLine = db.prepare(`
            INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price, cancellation_deadline, added_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          const insertMessage = db.prepare(`
            INSERT INTO messages (order_id, order_item_id, event_type, message, created_at)
            VALUES (?, ?, 'order_submitted', ?, ?)
          `);
          for (const item of selectedItems) {
            const lineResult = insertLine.run(orderId, item.id, item.name, item.quantity, item.price, now + CANCELLATION_WINDOW_MS, now);
            const lineId = Number(lineResult.lastInsertRowid);
            const message = [
              `New order #${orderId} submitted.`,
              `Occupied table session: #${sessionId}.`,
              `Table: ${tableNumber}.`,
              `Customer phone: ${phone}.`,
              `Item: ${item.name} (${item.dietary}, ${item.cuisine}).`,
              `Quantity: ${item.quantity}.`,
              `Unit price: Rs ${item.price}; line total: Rs ${item.price * item.quantity}.`,
              "Status: pending restaurant confirmation.",
              "This item can be cancelled for 4 minutes after submission, or for 4 minutes after a relevant menu change."
            ].join(" ");
            insertMessage.run(orderId, lineId, message, now);
          }
          db.exec("COMMIT");
          return sendJson(response, 201, getOrder(db, orderId));
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/table-sessions") {
        expireOldOrders(db);
        const sessions = db.prepare(`
          SELECT id FROM table_sessions
          WHERE status = 'occupied' AND expired_at IS NULL
          ORDER BY table_number, id
        `).all();
        return sendJson(response, 200, sessions.map((session) => getTableSession(db, session.id)));
      }

      const sessionDepartureMatch = url.pathname.match(/^\/api\/table-sessions\/(\d+)\/departure$/);
      if (request.method === "POST" && sessionDepartureMatch) {
        expireOldOrders(db);
        const sessionId = Number(sessionDepartureMatch[1]);
        const session = db.prepare("SELECT * FROM table_sessions WHERE id = ?").get(sessionId);
        if (!session) return sendJson(response, 404, { error: "Occupied table session not found." });
        if (session.status !== "occupied") return sendJson(response, 409, { error: "This table session is already closed." });
        const latestOrder = db.prepare("SELECT id FROM orders WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId);
        if (!latestOrder) return sendJson(response, 409, { error: "This table session has no orders to close." });
        const now = Date.now();
        db.exec("BEGIN");
        try {
          const result = db.prepare(`
            UPDATE table_sessions SET status = 'vacated', left_at = ?
            WHERE id = ? AND status = 'occupied'
          `).run(now, sessionId);
          if (result.changes !== 1) {
            db.exec("ROLLBACK");
            return sendJson(response, 409, { error: "This table session is already closed." });
          }
          db.prepare(`
            INSERT INTO messages (order_id, event_type, message, created_at)
            VALUES (?, 'customer_left', ?, ?)
          `).run(
            latestOrder.id,
            `Table ${session.table_number} is vacant. Customer number ${session.phone} has left; table session #${sessionId} is closed.`,
            now
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(response, 200, getTableSession(db, sessionId));
      }

      if (request.method === "GET" && url.pathname === "/api/customer/orders") {
        expireOldOrders(db);
        const tableNumber = Number(url.searchParams.get("table"));
        const phone = String(url.searchParams.get("phone") || "").trim();
        if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > TABLE_COUNT) {
          return sendJson(response, 400, { error: "Choose a valid table number (1-20)." });
        }
        if (!/^[+()\d\s-]{7,20}$/.test(phone) || phone.replace(/\D/g, "").length < 7) {
          return sendJson(response, 400, { error: "Enter the contact number used for this table." });
        }
        const phoneDigits = phone.replace(/\D/g, "");
        const session = db.prepare(`
          SELECT table_sessions.*, orders.phone AS order_phone
          FROM table_sessions
          LEFT JOIN orders ON orders.session_id = table_sessions.id
          WHERE table_sessions.table_number = ?
          ORDER BY table_sessions.id DESC
        `).all(tableNumber).find((candidate) =>
          candidate.phone.replace(/\D/g, "") === phoneDigits
          || (candidate.order_phone && candidate.order_phone.replace(/\D/g, "") === phoneDigits)
        );
        if (!session) return sendJson(response, 404, { error: "No active table session matches that table and contact number." });
        return sendJson(response, 200, getTableSession(db, session.id));
      }

      const itemUpdateMatch = url.pathname.match(/^\/api\/orders\/(\d+)\/items\/(\d+)$/);
      if (request.method === "PATCH" && itemUpdateMatch) {
        expireOldOrders(db);
        const orderId = Number(itemUpdateMatch[1]);
        const lineId = Number(itemUpdateMatch[2]);
        const body = await readJson(request);
        const quantity = Number(body.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
          return sendJson(response, 400, { error: "Choose an item quantity from 1 to 20." });
        }
        const line = db.prepare(`
          SELECT oi.*, o.table_number, o.phone, o.session_id, o.expires_at,
            s.status AS session_status, s.expired_at AS session_expired_at
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          LEFT JOIN table_sessions s ON s.id = o.session_id
          WHERE oi.id = ? AND oi.order_id = ?
        `).get(lineId, orderId);
        if (!line) return sendJson(response, 404, { error: "Order item not found." });
        if (line.expires_at <= Date.now() || line.session_expired_at) return sendJson(response, 409, { error: "This order has expired from the active table session." });
        if (line.session_status === "vacated") return sendJson(response, 409, { error: "This table session is closed." });
        if (line.status === "cancelled") return sendJson(response, 409, { error: "This item has already been cancelled." });
        const now = Date.now();
        if (now > line.cancellation_deadline) {
          return sendJson(response, 409, { error: "The 4-minute modification window for this item has ended." });
        }

        db.exec("BEGIN");
        try {
          db.prepare(`
            UPDATE order_items
            SET quantity = ?, modified_at = ?, cancellation_deadline = ?
            WHERE id = ?
          `).run(quantity, now, now + CANCELLATION_WINDOW_MS, lineId);
          db.prepare(`
            INSERT INTO messages (order_id, order_item_id, event_type, message, created_at)
            VALUES (?, ?, 'item_modified', ?, ?)
          `).run(
            orderId,
            lineId,
            `Order #${orderId} modified by the customer at table ${line.table_number}: ${line.item_name} quantity changed from ${line.quantity} to ${quantity}. Customer phone: ${line.phone}. The item can be modified or cancelled for 4 minutes from this change.`,
            now
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(response, 200, getOrder(db, orderId));
      }

      const cancelMatch = url.pathname.match(/^\/api\/orders\/(\d+)\/items\/(\d+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        expireOldOrders(db);
        const orderId = Number(cancelMatch[1]);
        const lineId = Number(cancelMatch[2]);
        const line = db.prepare(`
          SELECT oi.*, o.table_number, o.phone, o.session_id, o.expires_at,
            s.status AS session_status, s.expired_at AS session_expired_at
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          LEFT JOIN table_sessions s ON s.id = o.session_id
          WHERE oi.id = ? AND oi.order_id = ?
        `).get(lineId, orderId);
        if (!line) return sendJson(response, 404, { error: "Order item not found." });
        if (line.expires_at <= Date.now() || line.session_expired_at) return sendJson(response, 409, { error: "This order has expired from the active table session." });
        if (line.session_status === "vacated") return sendJson(response, 409, { error: "This table session is closed." });
        if (line.status === "cancelled") return sendJson(response, 409, { error: "This item has already been cancelled." });
        if (Date.now() > line.cancellation_deadline) {
          return sendJson(response, 409, { error: "The 4-minute cancellation window for this item has ended." });
        }

        const now = Date.now();
        db.exec("BEGIN");
        try {
          db.prepare("UPDATE order_items SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now, lineId);
          db.prepare(`
            INSERT INTO messages (order_id, order_item_id, event_type, message, created_at)
            VALUES (?, ?, 'item_cancelled', ?, ?)
          `).run(orderId, lineId,
            `Cancellation requested for order #${orderId}: ${line.item_name} (quantity ${line.quantity}) at table ${line.table_number}. Customer phone: ${line.phone}. The item was cancelled within its validation window.`,
            now);
          const remaining = db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = ? AND status != 'cancelled'").get(orderId).count;
          if (remaining === 0) db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(response, 200, getOrder(db, orderId));
      }

      const menuUpdateMatch = url.pathname.match(/^\/api\/menu\/(\d+)$/);
      if (request.method === "PATCH" && menuUpdateMatch) {
        expireOldOrders(db);
        const itemId = Number(menuUpdateMatch[1]);
        const body = await readJson(request);
        if (typeof body.available !== "boolean") {
          return sendJson(response, 400, { error: "Availability must be true or false." });
        }
        const item = db.prepare("SELECT * FROM menu_items WHERE id = ?").get(itemId);
        if (!item) return sendJson(response, 404, { error: "Menu item not found." });
        if (Boolean(item.available) !== body.available) {
          const now = Date.now();
          db.exec("BEGIN");
          try {
            db.prepare("UPDATE menu_items SET available = ?, updated_at = ? WHERE id = ?").run(Number(body.available), now, itemId);
            const affected = db.prepare(`
              SELECT oi.id, oi.order_id, oi.quantity, o.table_number, o.phone
              FROM order_items oi
              JOIN orders o ON o.id = oi.order_id
              JOIN table_sessions s ON s.id = o.session_id
              WHERE oi.menu_item_id = ? AND oi.status IN ('pending', 'menu_changed')
                AND s.status = 'occupied' AND s.expired_at IS NULL AND o.expires_at > ?
            `).all(itemId, Date.now());
            const updateLine = db.prepare(`
              UPDATE order_items
              SET status = 'menu_changed', menu_changed_at = ?, modified_at = ?, cancellation_deadline = ?
              WHERE id = ?
            `);
            const insertMessage = db.prepare(`
              INSERT INTO messages (order_id, order_item_id, event_type, message, created_at)
              VALUES (?, ?, 'menu_changed', ?, ?)
            `);
            const availability = body.available ? "available" : "unavailable";
            for (const line of affected) {
              updateLine.run(now, now, now + CANCELLATION_WINDOW_MS, line.id);
              insertMessage.run(line.order_id, line.id,
                `Menu update affects order #${line.order_id}: ${item.name} is now ${availability}. Table ${line.table_number}; customer phone ${line.phone}; quantity ${line.quantity}. The customer has 4 minutes from this update to cancel this item.`,
                now);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
        return sendJson(response, 200, menuItemRow(db.prepare("SELECT * FROM menu_items WHERE id = ?").get(itemId)));
      }

      if (request.method === "GET" && url.pathname === "/api/messages") {
        return sendJson(response, 200, db.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 100").all());
      }

      if (request.method === "GET" && url.pathname === "/orders") {
        response.writeHead(302, { Location: "/menu" });
        return response.end();
      }

      if (request.method === "GET" && url.pathname === "/owner") {
        response.writeHead(302, { Location: "/staff" });
        return response.end();
      }

      if (request.method === "GET" && (
        url.pathname === "/" || url.pathname === "/menu" || url.pathname === "/qr" || url.pathname === "/staff"
      )) {
        const filePath = url.pathname === "/qr"
          ? path.join(PUBLIC_DIR, "customer", "qr.html")
          : url.pathname === "/staff"
            ? path.join(PUBLIC_DIR, "staff", "index.html")
            : path.join(PUBLIC_DIR, "customer", "index.html");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return fs.createReadStream(filePath).pipe(response);
      }

      if (request.method === "GET" && url.pathname.startsWith("/public/")) {
        const requestedPath = path.resolve(PUBLIC_DIR, url.pathname.slice("/public/".length));
        if (!requestedPath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(response, 403, { error: "Forbidden." });
        const contentTypes = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
        if (!fs.existsSync(requestedPath)) return sendJson(response, 404, { error: "File not found." });
        response.writeHead(200, { "Content-Type": contentTypes[path.extname(requestedPath)] || "application/octet-stream" });
        return fs.createReadStream(requestedPath).pipe(response);
      }

      return sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { error: "Something went wrong while processing the request." });
    }
  });
}

function getOrder(db, orderId) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return null;
  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(orderId);
  return { ...order, items };
}

function getTableSession(db, sessionId) {
  const session = db.prepare("SELECT * FROM table_sessions WHERE id = ?").get(sessionId);
  if (!session) return null;
  const orders = db.prepare(`
    SELECT id FROM orders
    WHERE session_id = ? AND expires_at > ?
    ORDER BY created_at, id
  `).all(sessionId, Date.now())
    .map((order) => getOrder(db, order.id));
  const subtotal = orders.reduce((total, order) => total + order.items.reduce((orderTotal, item) =>
    orderTotal + (item.status === "cancelled" ? 0 : item.unit_price * item.quantity), 0), 0);
  return { ...session, expired: Boolean(session.expired_at), orders, subtotal };
}

function expireOldOrders(db, now = Date.now()) {
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE orders SET status = 'expired'
      WHERE expires_at <= ? AND status != 'expired'
    `).run(now);
    db.prepare(`
      UPDATE table_sessions
      SET expired_at = ?
      WHERE status = 'occupied' AND expired_at IS NULL
        AND EXISTS (SELECT 1 FROM orders WHERE orders.session_id = table_sessions.id)
        AND NOT EXISTS (
          SELECT 1 FROM orders
          WHERE orders.session_id = table_sessions.id AND orders.expires_at > ?
        )
    `).run(now, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const db = createDatabase();
const server = createServer(db);
if (require.main === module) {
  const expiryTimer = setInterval(() => {
    try {
      expireOldOrders(db);
    } catch (error) {
      console.error("Could not expire old restaurant orders:", error);
    }
  }, 60_000);
  expiryTimer.unref();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Restaurant menu demo running at http://localhost:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
  });
}

module.exports = { createDatabase, createServer, getOrder, getMenuUrl, CANCELLATION_WINDOW_MS };
