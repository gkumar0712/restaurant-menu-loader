const money = (amount) => `Rs ${Number(amount).toLocaleString("en-IN")}`;
let menuItems = [];
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function renderMenu() {
  const search = document.querySelector("#owner-menu-search").value.trim().toLowerCase();
  const category = document.querySelector("#owner-category-filter").value;
  const availability = document.querySelector("#owner-availability-filter").value;
  const filtered = menuItems.filter((item) =>
    item.name.toLowerCase().includes(search)
    && (category === "all" || item.category === category)
    && (availability === "all" || (item.available ? "available" : "unavailable") === availability)
  );
  const container = document.querySelector("#owner-menu-list");
  container.replaceChildren();
  if (!filtered.length) {
    container.append(element("p", "empty-state", "No menu items match these filters."));
    return;
  }

  for (const item of filtered) {
    const row = element("div", "admin-menu-row");
    const details = element("div");
    details.append(element("strong", "", item.name));
    details.append(element("small", "", `${item.category} · ${item.cuisine} · ${item.dietary} · ${money(item.price)} · Updated ${new Date(item.updated_at).toLocaleString()}`));
    const label = element("label", "switch-label", item.available ? "Available" : "Unavailable");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = item.available;
    input.setAttribute("aria-label", `${item.name} availability`);
    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        const updated = await requestJson(`/api/menu/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ available: input.checked })
        });
        menuItems = menuItems.map((menuItem) => menuItem.id === updated.id ? updated : menuItem);
        document.querySelector("#owner-menu-error").textContent = "";
        showToast(`${updated.name} is now ${updated.available ? "available" : "unavailable"}.`);
        renderMenu();
      } catch (error) {
        input.checked = !input.checked;
        input.disabled = false;
        document.querySelector("#owner-menu-error").textContent = error.message;
      }
    });
    label.prepend(input);
    row.append(details, label);
    container.append(row);
  }
}

async function loadMenu() {
  const error = document.querySelector("#owner-menu-error");
  error.textContent = "";
  try {
    menuItems = await requestJson("/api/menu");
    renderMenu();
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

document.querySelector("#owner-menu-search").addEventListener("input", renderMenu);
document.querySelector("#owner-category-filter").addEventListener("change", renderMenu);
document.querySelector("#owner-availability-filter").addEventListener("change", renderMenu);
document.querySelector("#refresh-owner-menu").addEventListener("click", loadMenu);
loadMenu();
