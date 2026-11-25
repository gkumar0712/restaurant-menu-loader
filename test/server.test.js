const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const assert = require("node:assert/strict");

test("shared restaurant QR, table selection, database outbox, and per-item cancellation flow", async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "restaurant-menu-"));
  const databasePath = path.join(temporaryDirectory, "restaurant_details.db");
  const qrCodePath = path.join(temporaryDirectory, "restaurant-menu-qr.png");
  const port = 31000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      RESTAURANT_DB_PATH: databasePath,
      QR_CODE_PATH: qrCodePath,
      PUBLIC_BASE_URL: `http://menu.example.test:${port}/base/path`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/menu`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, `server did not start: ${output}`);

  const menuResponse = await fetch(`${baseUrl}/api/menu`);
  const menu = await menuResponse.json();
  assert.ok(menu.length >= 20);
  assert.ok(menu.some((item) => item.category === "Supplementary"));
  assert.ok(menu.some((item) => item.dietary === "non-veg"));
  assert.ok(menu.some((item) => item.available === false));

  const qrResponse = await fetch(`${baseUrl}/api/qr`);
  const qr = await qrResponse.json();
  assert.equal(qrResponse.status, 200);
  assert.equal(qr.menuUrl, `http://menu.example.test:${port}/`);
  assert.doesNotMatch(qr.menuUrl, /table=/);
  assert.match(qr.qrDataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(
    fs.readFileSync(qrCodePath).subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  );
  const qrPageResponse = await fetch(`${baseUrl}/qr`);
  assert.equal(qrPageResponse.status, 200);
  assert.match(await qrPageResponse.text(), /download-qr/);
  const ordersPageResponse = await fetch(`${baseUrl}/orders`);
  assert.equal(ordersPageResponse.status, 200);
  assert.equal(ordersPageResponse.url, `${baseUrl}/menu`);
  const ownerPageResponse = await fetch(`${baseUrl}/owner`);
  assert.equal(ownerPageResponse.status, 200);
  assert.equal(ownerPageResponse.url, `${baseUrl}/staff`);
  const staffPageResponse = await fetch(`${baseUrl}/staff`);
  assert.equal(staffPageResponse.status, 200);
  assert.equal(staffPageResponse.url, `${baseUrl}/staff`);
  const ownerPage = await ownerPageResponse.text();
  assert.match(ownerPage, /Menu.*availability/);
  assert.match(ownerPage, /\/public\/staff\/app\.js/);
  assert.doesNotMatch(ownerPage, /href="\/orders"|href="\/"|ordered food|Restaurant QR/);
  const customerMenuResponse = await fetch(`${baseUrl}/menu`);
  const customerMenu = await customerMenuResponse.text();
  assert.match(customerMenu, /View your orders/);
  assert.match(customerMenu, /Add more food/);
  assert.match(customerMenu, /\/public\/customer\/app\.js/);
  assert.doesNotMatch(customerMenu, /href="\/orders"|Owner menu|\/staff/);
  const customerScriptResponse = await fetch(`${baseUrl}/public/customer/app.js`);
  assert.equal(customerScriptResponse.status, 200);
  const staffScriptResponse = await fetch(`${baseUrl}/public/staff/app.js`);
  assert.equal(staffScriptResponse.status, 200);
  const sharedStylesResponse = await fetch(`${baseUrl}/public/shared/styles.css`);
  assert.equal(sharedStylesResponse.status, 200);
  const ownerOrderApiResponse = await fetch(`${baseUrl}/api/orders`);
  assert.equal(ownerOrderApiResponse.status, 404);

  const availableItem = menu.find((item) => item.available);
  const unavailableItem = menu.find((item) => !item.available);
  const unavailableOrderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableNumber: 5, phone: "9876543210", items: [{ id: unavailableItem.id, quantity: 1 }] })
  });
  assert.equal(unavailableOrderResponse.status, 409);

  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tableNumber: 5,
      phone: "+91 98765 43210",
      items: [{ id: availableItem.id, quantity: 2 }, { id: menu.find((item) => item.available && item.id !== availableItem.id).id, quantity: 1 }]
    })
  });
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();
  assert.equal(order.table_number, 5);
  assert.equal(order.items.length, 2);
  assert.ok(order.session_id);
  assert.ok(order.items.every((item) => item.added_at > 0));
  assert.ok(order.items.every((item) => item.cancellation_deadline - item.added_at === 4 * 60 * 1000));

  const phoneAlreadyInUseResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tableNumber: 6,
      phone: "+91-98765-43210",
      items: [{ id: availableItem.id, quantity: 1 }]
    })
  });
  assert.equal(phoneAlreadyInUseResponse.status, 409);
  assert.match((await phoneAlreadyInUseResponse.json()).error, /active session at table 5/i);

  const messagesResponse = await fetch(`${baseUrl}/api/messages`);
  const messages = await messagesResponse.json();
  assert.equal(messages.filter((message) => message.event_type === "order_submitted").length, 2);
  assert.ok(messages.some((message) => message.message.includes("+91 98765 43210")));

  const itemToChange = order.items[0];
  const updateResponse = await fetch(`${baseUrl}/api/menu/${itemToChange.menu_item_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ available: false })
  });
  assert.equal(updateResponse.status, 200);
  const updatedOrderResponse = await fetch(
    `${baseUrl}/api/customer/orders?table=5&phone=${encodeURIComponent("+91 98765 43210")}`
  );
  const updatedSession = await updatedOrderResponse.json();
  const changedItem = updatedSession.orders[0].items.find((item) => item.id === itemToChange.id);
  assert.equal(changedItem.status, "menu_changed");
  assert.ok(changedItem.modified_at);
  assert.ok(changedItem.modified_at >= changedItem.added_at);
  assert.ok(changedItem.cancellation_deadline > Date.now() + 230_000);

  const cancelResponse = await fetch(`${baseUrl}/api/orders/${order.id}/items/${itemToChange.id}/cancel`, { method: "POST" });
  assert.equal(cancelResponse.status, 200);
  const cancelledOrder = await cancelResponse.json();
  const cancelledItem = cancelledOrder.items.find((item) => item.id === itemToChange.id);
  assert.equal(cancelledItem.status, "cancelled");
  assert.ok(cancelledItem.cancelled_at);
  assert.ok(cancelledOrder.items.some((item) => item.status === "pending"));

  const customerOrdersResponse = await fetch(
    `${baseUrl}/api/customer/orders?table=5&phone=${encodeURIComponent("+91-98765-43210")}`
  );
  assert.equal(customerOrdersResponse.status, 200);
  const customerSession = await customerOrdersResponse.json();
  assert.equal(customerSession.id, order.session_id);
  assert.equal(customerSession.orders.length, 1);
  assert.ok(customerSession.orders[0].items.some((item) => item.cancelled_at));

  const differentNumberLookup = await fetch(
    `${baseUrl}/api/customer/orders?table=5&phone=${encodeURIComponent("5551234567")}`
  );
  assert.equal(differentNumberLookup.status, 404);

  const retainedItem = order.items.find((item) => item.id !== itemToChange.id);
  const modifyResponse = await fetch(`${baseUrl}/api/orders/${order.id}/items/${retainedItem.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity: retainedItem.quantity + 1 })
  });
  assert.equal(modifyResponse.status, 200);
  const modifiedOrder = await modifyResponse.json();
  const modifiedItem = modifiedOrder.items.find((item) => item.id === retainedItem.id);
  assert.equal(modifiedItem.quantity, retainedItem.quantity + 1);
  assert.ok(modifiedItem.modified_at >= modifiedItem.added_at);
  assert.equal(modifiedItem.cancellation_deadline - modifiedItem.modified_at, 4 * 60 * 1000);
  const sessionAfterModificationResponse = await fetch(
    `${baseUrl}/api/customer/orders?table=5&phone=${encodeURIComponent("+91 98765 43210")}`
  );
  const sessionAfterModification = await sessionAfterModificationResponse.json();
  assert.ok(sessionAfterModification.orders[0].items.find((item) => item.id === retainedItem.id).modified_at);
  assert.equal(sessionAfterModification.subtotal, modifiedItem.unit_price * modifiedItem.quantity);

  const addedOrderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tableNumber: 5,
      phone: "+91 98765 43210",
      items: [{ id: retainedItem.menu_item_id, quantity: 2 }]
    })
  });
  assert.equal(addedOrderResponse.status, 201);
  const addedOrder = await addedOrderResponse.json();
  assert.equal(addedOrder.session_id, order.session_id);
  assert.ok(addedOrder.items[0].added_at >= retainedItem.added_at);
  const secondAddedOrderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tableNumber: 5,
      phone: "+91 (98765) 43210",
      items: [{ id: retainedItem.menu_item_id, quantity: 1 }]
    })
  });
  assert.equal(secondAddedOrderResponse.status, 201);
  const secondAddedOrder = await secondAddedOrderResponse.json();
  assert.equal(secondAddedOrder.session_id, order.session_id);

  const updatedContactOrderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableNumber: 5, phone: "5551234567", items: [{ id: retainedItem.menu_item_id, quantity: 1 }] })
  });
  assert.equal(updatedContactOrderResponse.status, 201);
  const updatedContactOrder = await updatedContactOrderResponse.json();
  assert.equal(updatedContactOrder.session_id, order.session_id);

  const originalContactLookup = await fetch(
    `${baseUrl}/api/customer/orders?table=5&phone=${encodeURIComponent("+91 98765 43210")}`
  );
  assert.equal(originalContactLookup.status, 200);
  const originalContactSession = await originalContactLookup.json();
  assert.equal(originalContactSession.id, order.session_id);
  assert.equal(originalContactSession.orders.length, 4);
  const additionalContactLookup = await fetch(
    `${baseUrl}/api/customer/orders?table=5&phone=5551234567`
  );
  assert.equal(additionalContactLookup.status, 200);
  const additionalContactSession = await additionalContactLookup.json();
  assert.equal(additionalContactSession.id, order.session_id);
  assert.equal(additionalContactSession.orders.length, 4);
  assert.ok(additionalContactSession.orders.some((sessionOrder) => sessionOrder.phone === "5551234567"));
  assert.ok(additionalContactSession.orders.some((sessionOrder) => sessionOrder.phone === "+91 98765 43210"));

  const updatedPhoneOtherTableResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableNumber: 6, phone: "5551234567", items: [{ id: retainedItem.menu_item_id, quantity: 1 }] })
  });
  assert.equal(updatedPhoneOtherTableResponse.status, 409);
  assert.match((await updatedPhoneOtherTableResponse.json()).error, /active session at table 5/i);

  const activeSessionsResponse = await fetch(`${baseUrl}/api/table-sessions`);
  const activeSessions = await activeSessionsResponse.json();
  assert.equal(activeSessions.length, 1);
  const occupiedSession = activeSessions[0];
  assert.equal(occupiedSession.table_number, 5);
  assert.equal(occupiedSession.phone, "+91 98765 43210");
  assert.equal(occupiedSession.orders.length, 4);
  assert.equal(occupiedSession.subtotal, retainedItem.unit_price * 6);

  const unsupportedPaymentResponse = await fetch(`${baseUrl}/api/bills/1/pay`, { method: "POST" });
  assert.equal(unsupportedPaymentResponse.status, 404);
  const unsupportedBillingListResponse = await fetch(`${baseUrl}/api/bills`);
  assert.equal(unsupportedBillingListResponse.status, 404);

  const departureResponse = await fetch(
    `${baseUrl}/api/table-sessions/${occupiedSession.id}/departure`,
    { method: "POST" }
  );
  assert.equal(departureResponse.status, 200);
  const departedSession = await departureResponse.json();
  assert.equal(departedSession.status, "vacated");
  assert.ok(departedSession.left_at);
  const sessionsAfterDepartureResponse = await fetch(`${baseUrl}/api/table-sessions`);
  assert.deepEqual(await sessionsAfterDepartureResponse.json(), []);

  const nextCustomerOrderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableNumber: 5, phone: "5551234567", items: [{ id: retainedItem.menu_item_id, quantity: 1 }] })
  });
  assert.equal(nextCustomerOrderResponse.status, 201);
  const nextCustomerOrder = await nextCustomerOrderResponse.json();
  assert.notEqual(nextCustomerOrder.session_id, order.session_id);
  const newSessionResponse = await fetch(`${baseUrl}/api/table-sessions`);
  const newSessions = await newSessionResponse.json();
  assert.equal(newSessions.length, 1);
  assert.notEqual(newSessions[0].id, occupiedSession.id);
  assert.equal(newSessions[0].phone, "5551234567");

  const menuAfterAvailabilityUpdate = await (await fetch(`${baseUrl}/api/menu`)).json();
  const expiryTestItem = menuAfterAvailabilityUpdate.find((item) => item.available);
  const expiringOrderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableNumber: 7, phone: "5557654321", items: [{ id: expiryTestItem.id, quantity: 1 }] })
  });
  assert.equal(expiringOrderResponse.status, 201);
  const expiringOrder = await expiringOrderResponse.json();
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE orders SET expires_at = ? WHERE id = ?").run(Date.now() - 1, expiringOrder.id);
  database.close();

  const expiredSessionResponse = await fetch(
    `${baseUrl}/api/customer/orders?table=7&phone=5557654321`
  );
  assert.equal(expiredSessionResponse.status, 200);
  const expiredSession = await expiredSessionResponse.json();
  assert.equal(expiredSession.expired, true);
  assert.equal(expiredSession.orders.length, 0);
  assert.equal(expiredSession.subtotal, 0);
  const expiryDatabase = new DatabaseSync(databasePath);
  assert.equal(expiryDatabase.prepare("SELECT status FROM orders WHERE id = ?").get(expiringOrder.id).status, "expired");
  assert.equal(expiryDatabase.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?").get(expiringOrder.id).count, 1);
  expiryDatabase.close();

  const expiredModifyResponse = await fetch(
    `${baseUrl}/api/orders/${expiringOrder.id}/items/${expiringOrder.items[0].id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 2 })
    }
  );
  assert.equal(expiredModifyResponse.status, 409);
  const expiredCancelResponse = await fetch(
    `${baseUrl}/api/orders/${expiringOrder.id}/items/${expiringOrder.items[0].id}/cancel`,
    { method: "POST" }
  );
  assert.equal(expiredCancelResponse.status, 409);

  const nextAfterExpiryResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableNumber: 7, phone: "5550001111", items: [{ id: expiryTestItem.id, quantity: 1 }] })
  });
  assert.equal(nextAfterExpiryResponse.status, 201);
  const nextAfterExpiry = await nextAfterExpiryResponse.json();
  assert.notEqual(nextAfterExpiry.session_id, expiringOrder.session_id);

  const invalidOrder = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tableNumber: 21, phone: "9876543210", items: [{ id: availableItem.id, quantity: 1 }] })
  });
  assert.equal(invalidOrder.status, 400);
});
