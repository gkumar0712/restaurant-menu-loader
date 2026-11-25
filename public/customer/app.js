const money = (amount) => `Rs ${Number(amount).toLocaleString("en-IN")}`;
const params = new URLSearchParams(location.search);
const initialTable = Number(params.get("table"));
const cart = new Map();
let menuItems = [];
let selectedDiet = "all";
let toastTimer;

const tableSelect = document.querySelector("#table-number");
const menuContent = document.querySelector("#menu-content");
const cartBar = document.querySelector("#cart-bar");
const cartDialog = document.querySelector("#cart-dialog");
const customerOrdersDialog = document.querySelector("#customer-orders-dialog");
let customerPhone = sessionStorage.getItem("restaurantCustomerPhone") || "";

for (let table = 1; table <= 20; table += 1) {
  const option = document.createElement("option");
  option.value = table;
  option.textContent = `Table ${String(table).padStart(2, "0")}`;
  tableSelect.append(option);
}
const tablePlaceholder = document.createElement("option");
tablePlaceholder.value = "";
tablePlaceholder.textContent = "Choose your table";
tablePlaceholder.disabled = true;
tableSelect.prepend(tablePlaceholder);
const storedTable = Number(sessionStorage.getItem("restaurantTableNumber"));
tableSelect.value = Number.isInteger(initialTable) && initialTable >= 1 && initialTable <= 20
  ? initialTable
  : Number.isInteger(storedTable) && storedTable >= 1 && storedTable <= 20 ? storedTable : "";
const customerOrdersTable = document.querySelector("#customer-orders-table");
const customerTablePlaceholder = document.createElement("option");
customerTablePlaceholder.value = "";
customerTablePlaceholder.textContent = "Choose your table";
customerTablePlaceholder.disabled = true;
customerOrdersTable.append(customerTablePlaceholder);
for (let table = 1; table <= 20; table += 1) {
  const option = document.createElement("option");
  option.value = table;
  option.textContent = `Table ${String(table).padStart(2, "0")}`;
  customerOrdersTable.append(option);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMenu() {
  const search = document.querySelector("#search").value.trim().toLowerCase();
  const cuisine = document.querySelector("#cuisine-filter").value;
  const availableOnly = document.querySelector("#available-only").checked;
  const filtered = menuItems.filter((item) =>
    item.name.toLowerCase().includes(search)
    && (selectedDiet === "all" || item.dietary === selectedDiet)
    && (cuisine === "all" || item.cuisine === cuisine)
    && (!availableOnly || item.available)
  );
  const categories = ["Starter", "Main Course", "Dessert", "Supplementary"];
  menuContent.replaceChildren();
  let visibleCount = 0;
  for (const category of categories) {
    const items = filtered.filter((item) => item.category === category);
    if (!items.length) continue;
    visibleCount += items.length;
    const section = element("section", "category-block");
    const heading = element("div", "category-heading");
    heading.append(element("h3", "", category));
    heading.append(element("span", "", `${items.length} ${items.length === 1 ? "dish" : "dishes"}`));
    section.append(heading);
    const grid = element("div", "dish-grid");
    for (const item of items) {
      const card = element("article", `dish-card${item.available ? "" : " unavailable"}`);
      const top = element("div", "dish-card-top");
      const dietary = element("span", `diet-tag ${item.dietary}`, item.dietary === "veg" ? "VEG" : "NON-VEG");
      top.append(dietary, element("span", "cuisine-tag", item.cuisine));
      card.append(top);
      card.append(element("h4", "dish-name", item.name));
      card.append(element("p", "dish-description", item.description));
      const bottom = element("div", "dish-bottom");
      bottom.append(element("strong", "dish-price", money(item.price)));
      if (!item.available) {
        bottom.append(element("span", "unavailable-label", "Unavailable"));
      } else {
        const addButton = element("button", "add-button", cart.has(item.id) ? `Added · ${cart.get(item.id)}` : "Add +");
        addButton.type = "button";
        addButton.setAttribute("aria-label", `Add ${item.name} to order`);
        addButton.addEventListener("click", () => {
          cart.set(item.id, (cart.get(item.id) || 0) + 1);
          renderMenu();
          renderCart();
        });
        bottom.append(addButton);
      }
      card.append(bottom);
      grid.append(card);
    }
    section.append(grid);
    menuContent.append(section);
  }
  if (!visibleCount) menuContent.append(element("p", "empty-state", "No dishes match your search. Try another name or filter."));
}

function renderCart() {
  let count = 0;
  let total = 0;
  for (const [id, quantity] of cart) {
    const item = menuItems.find((dish) => dish.id === id);
    if (!item || !item.available) continue;
    count += quantity;
    total += item.price * quantity;
  }
  document.querySelector("#cart-count").textContent = count;
  document.querySelector("#cart-total").textContent = money(total);
  cartBar.hidden = count === 0;
  const tableNumber = Number(tableSelect.value);
  document.querySelector("#cart-table-label").textContent = tableSelect.value
    ? String(tableNumber).padStart(2, "0")
    : "not selected";
  const lines = document.querySelector("#cart-lines");
  lines.replaceChildren();
  for (const [id, quantity] of cart) {
    const item = menuItems.find((dish) => dish.id === id);
    if (!item || !item.available) continue;
    const line = element("div", "cart-line");
    const info = element("div");
    info.append(element("strong", "", item.name));
    info.append(element("small", "", `${quantity} × ${money(item.price)}`));
    const controls = element("div", "quantity-controls");
    const decrement = element("button", "quantity-button", "−");
    decrement.type = "button";
    decrement.setAttribute("aria-label", `Remove one ${item.name}`);
    decrement.addEventListener("click", () => {
      const next = cart.get(id) - 1;
      if (next <= 0) cart.delete(id);
      else cart.set(id, next);
      renderMenu();
      renderCart();
    });
    const increment = element("button", "quantity-button", "+");
    increment.type = "button";
    increment.setAttribute("aria-label", `Add one ${item.name}`);
    increment.addEventListener("click", () => {
      cart.set(id, cart.get(id) + 1);
      renderMenu();
      renderCart();
    });
    controls.append(decrement, element("span", "", quantity), increment);
    line.append(info, controls);
    lines.append(line);
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

async function loadMenu() {
  const response = await fetch("/api/menu");
  if (!response.ok) throw new Error("Could not load the menu.");
  menuItems = await response.json();
  for (const id of cart.keys()) {
    const item = menuItems.find((dish) => dish.id === id);
    if (!item || !item.available) cart.delete(id);
  }
  renderMenu();
  renderCart();
}

document.querySelector("#search").addEventListener("input", renderMenu);
document.querySelector("#cuisine-filter").addEventListener("change", renderMenu);
document.querySelector("#available-only").addEventListener("change", renderMenu);
document.querySelector("#diet-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-diet]");
  if (!button) return;
  selectedDiet = button.dataset.diet;
  document.querySelectorAll(".filter-chip").forEach((chip) => chip.classList.toggle("active", chip === button));
  renderMenu();
});
tableSelect.addEventListener("change", renderCart);
tableSelect.addEventListener("change", () => sessionStorage.setItem("restaurantTableNumber", tableSelect.value));
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("#search").focus();
  }
});
document.querySelector("#open-cart").addEventListener("click", () => {
  document.querySelector("#cart-error").textContent = "";
  document.querySelector("#phone-number").value = customerPhone;
  cartDialog.showModal();
});
document.querySelector("#open-customer-orders").addEventListener("click", async () => {
  customerOrdersDialog.showModal();
  document.querySelector("#customer-orders-table").value = tableSelect.value || "";
  document.querySelector("#customer-orders-phone").value = customerPhone;
  document.querySelector("#customer-orders-error").textContent = "";
  if (customerPhone && tableSelect.value) {
    try {
      await loadCustomerOrders();
    } catch (error) {
      document.querySelector("#customer-orders-error").textContent = error.message;
    }
  }
});
document.querySelector("#load-customer-orders").addEventListener("click", async () => {
  try {
    await loadCustomerOrders();
  } catch (error) {
    document.querySelector("#customer-orders-error").textContent = error.message;
  }
});
document.querySelector("#add-more-food").addEventListener("click", () => {
  tableSelect.value = document.querySelector("#customer-orders-table").value;
  customerPhone = document.querySelector("#customer-orders-phone").value.trim();
  sessionStorage.setItem("restaurantCustomerPhone", customerPhone);
  sessionStorage.setItem("restaurantTableNumber", tableSelect.value);
  renderCart();
  customerOrdersDialog.close();
  document.querySelector("#menu").scrollIntoView({ behavior: "smooth" });
});

async function loadCustomerOrders() {
  const tableNumber = document.querySelector("#customer-orders-table").value;
  const phone = document.querySelector("#customer-orders-phone").value.trim();
  const error = document.querySelector("#customer-orders-error");
  const list = document.querySelector("#customer-orders-list");
  error.textContent = "";
  if (!tableNumber) {
    document.querySelector("#customer-orders-table").reportValidity();
    return;
  }
  if (!document.querySelector("#customer-orders-phone").reportValidity()) return;

  const query = new URLSearchParams({ table: tableNumber, phone });
  const response = await fetch(`/api/customer/orders?${query}`);
  const session = await response.json();
  if (!response.ok) {
    document.querySelector("#add-more-food").disabled = true;
    list.replaceChildren();
    throw new Error(session.error || "Could not load your orders.");
  }
  customerPhone = phone;
  sessionStorage.setItem("restaurantCustomerPhone", phone);
  sessionStorage.setItem("restaurantTableNumber", tableNumber);
  tableSelect.value = tableNumber;
  renderCart();
  document.querySelector("#add-more-food").disabled = session.status !== "occupied" || session.expired;
  list.replaceChildren();

  if (session.expired) {
    list.append(element("p", "empty-state", "This table session expired after 6 hours. Active food orders and the subtotal are now zero."));
    return;
  }
  if (!session.orders.length) {
    list.append(element("p", "empty-state", "No items have been ordered for this table session yet."));
    return;
  }
  for (const order of session.orders) {
    const card = element("article", "customer-order-card");
    card.append(element("strong", "", `Order #${order.id} · ${new Date(order.created_at).toLocaleString()}`));
    for (const item of order.items) {
      const row = element("div", `customer-order-item${item.status === "cancelled" ? " cancelled" : ""}`);
      const details = element("div");
      details.append(element("strong", "", `${item.quantity} × ${item.item_name}`));
      details.append(element("small", "", `${money(item.unit_price * item.quantity)} · ${item.status.replaceAll("_", " ")}`));
      details.append(element("small", "", `Added ${new Date(item.added_at).toLocaleTimeString()}`));
      if (item.modified_at) details.append(element("small", "", `Modified ${new Date(item.modified_at).toLocaleTimeString()}`));

      const actions = element("div", "customer-order-item-actions");
      if (item.status === "cancelled") {
        actions.append(element("small", "", `Cancelled ${item.cancelled_at ? new Date(item.cancelled_at).toLocaleTimeString() : ""}`));
      } else if (item.cancellation_deadline > Date.now()) {
        const remaining = Math.ceil((item.cancellation_deadline - Date.now()) / 1000);
        actions.append(element("small", "deadline-note", `Cancel ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} left`));
        const quantityControls = element("div", "customer-quantity-controls");
        const decrement = element("button", "small-cancel-button", "−");
        decrement.type = "button";
        decrement.disabled = item.quantity <= 1;
        decrement.setAttribute("aria-label", `Remove one ${item.item_name}`);
        decrement.addEventListener("click", () => updateCustomerOrderItem(order.id, item.id, item.quantity - 1));
        const count = element("span", "", String(item.quantity));
        const increment = element("button", "small-cancel-button", "+");
        increment.type = "button";
        increment.disabled = item.quantity >= 20;
        increment.setAttribute("aria-label", `Add one ${item.item_name}`);
        increment.addEventListener("click", () => updateCustomerOrderItem(order.id, item.id, item.quantity + 1));
        quantityControls.append(decrement, count, increment);
        actions.append(quantityControls);
        const cancel = element("button", "small-cancel-button", "Cancel item");
        cancel.type = "button";
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try {
            const cancelResponse = await fetch(`/api/orders/${order.id}/items/${item.id}/cancel`, { method: "POST" });
            const result = await cancelResponse.json();
            if (!cancelResponse.ok) throw new Error(result.error || "Could not cancel this item.");
            await loadCustomerOrders();
          } catch (requestError) {
            actions.replaceChildren(element("small", "form-error", requestError.message));
          }
        });
        actions.append(cancel);
      } else {
        actions.append(element("small", "", "Cancellation window ended"));
      }
      row.append(details, actions);
      card.append(row);
    }
    list.append(card);
  }
}

async function updateCustomerOrderItem(orderId, itemId, quantity) {
  try {
    const response = await fetch(`/api/orders/${orderId}/items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not modify this item.");
    await loadCustomerOrders();
  } catch (error) {
    document.querySelector("#customer-orders-error").textContent = error.message;
  }
}

document.querySelector("#submit-order").addEventListener("click", async () => {
  const error = document.querySelector("#cart-error");
  error.textContent = "";
  if (!tableSelect.value) {
    tableSelect.reportValidity();
    error.textContent = "Choose your table number before placing the order.";
    cartDialog.close();
    tableSelect.focus();
    return;
  }
  const phoneInput = document.querySelector("#phone-number");
  if (!phoneInput.reportValidity()) return;
  const payload = {
    tableNumber: Number(tableSelect.value),
    phone: phoneInput.value,
    items: [...cart].map(([id, quantity]) => ({ id, quantity }))
  };
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not place your order.");
    customerPhone = phoneInput.value.trim();
    sessionStorage.setItem("restaurantCustomerPhone", customerPhone);
    sessionStorage.setItem("restaurantTableNumber", tableSelect.value);
    cart.clear();
    cartDialog.close();
    renderMenu();
    renderCart();
    showToast(`Order #${result.id} added to your Table ${String(result.table_number).padStart(2, "0")} session.`);
    customerOrdersDialog.showModal();
    document.querySelector("#customer-orders-table").value = String(result.table_number);
    document.querySelector("#customer-orders-phone").value = customerPhone;
    await loadCustomerOrders();
  } catch (requestError) {
    error.textContent = requestError.message;
    await loadMenu();
  }
});

loadMenu().catch((error) => {
  menuContent.replaceChildren(element("p", "form-error", error.message));
});
