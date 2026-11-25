async function loadRestaurantQr() {
  const error = document.querySelector("#qr-error");
  try {
    const response = await fetch("/api/qr");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not create the restaurant QR code.");

    const image = document.querySelector("#restaurant-qr-image");
    image.src = result.qrDataUrl;
    document.querySelector("#restaurant-menu-link").href = result.menuUrl;
    document.querySelector("#restaurant-menu-link").textContent = result.menuUrl;
    document.querySelector("#open-customer-menu").href = result.menuUrl;
    const download = document.querySelector("#download-qr");
    download.href = result.qrDataUrl;
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

document.querySelector("#print-qr").addEventListener("click", () => window.print());
loadRestaurantQr();
