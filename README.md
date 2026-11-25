# Table & Thyme — restaurant menu demo

A shared restaurant QR menu and ordering demo backed by a local SQLite database.

## Run locally

Requires Node.js 22.13 or newer.

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The customer app is at
`/menu`; open `/qr` to download or print the shared restaurant QR. The owner
and chef staff app is at `/staff`. These are separate frontend apps served by
the same server and connected to the same API and SQLite database. The first
start creates `restaurant_details.db` in the project directory and seeds the
demo menu. Set `PORT` or `RESTAURANT_DB_PATH` to use a different port or
database file.

By default, the QR uses the computer's detected Wi-Fi/Ethernet address and
server port so phones on the same network can open it. If no LAN address is
available, it falls back to localhost, which only works on the computer running
the server. To use a specific reachable address, set `PUBLIC_BASE_URL` (for
example `http://192.168.1.20:3000` on the same Wi-Fi, or the public HTTPS origin
for a hosted deployment). For local phone testing, allow the app through the
computer's firewall.

## Demo features

- A dedicated `/qr` page creates one shared, downloadable/printable restaurant
  QR code. It opens the customer menu on a phone and saves the generated image
  to `restaurant-menu-qr.png` using the active server URL. Guests select their
  table number (1-20) in the menu and enter a contact phone number when placing
  an order.
- The menu includes Starter, Main Course, Dessert, and Supplementary sections;
  Chinese, Italian, North Indian, and South Indian dishes; veg/non-veg filters;
  name search; cuisine filtering; and visible unavailable items.
- Guests add items, provide a phone number, and submit an order. Orders and
  detailed per-item messages are recorded in SQLite rather than sent to AMQ.
- Multiple customers at one table can place orders with their own contact
  numbers and access the same table session using the number they ordered with.
  Orders retain their original contact numbers, and each number remains linked
  to the session until it is closed or expires. A linked number cannot place
  orders from another table while the session is active. Payment is handled by
  a separate app and is not recorded here.
- Every ordered item stores its added, modified, and cancelled times. Guests
  can cancel an item during the four-minute window after it is added or
  modified; a menu availability change resets that item's window. The customer
  menu includes a view of the session orders and item cancellation controls.
- Each order remains active for six hours after submission. Expired food items
  no longer appear in the customer order view and no longer contribute to its
  subtotal; their database records are retained. The table session expires when
  all of its orders have expired, and a new customer can then start a session.
- Customers can see and manage the shared table orders in the menu's **View
  your orders** panel, using their table and a contact number they used to
  order. There is no staff-facing order list.
- Customer frontend files are kept in `public/customer`, staff frontend files
  in `public/staff`, and shared styles in `public/shared`. Restaurant owners
  can manage dish availability from `/staff`; changes are saved in SQLite and
  reset the four-minute modification/cancellation window for affected active
  order items.

## Database

The `restaurant_details.db` SQLite file contains `menu_items`, `table_sessions`,
`orders`, `order_items`, and `messages` tables. Order items retain their
four-minute cancellation deadline and added/modified/cancelled timestamps.
Messages are stored with a `queued` delivery status to leave a clear integration
point for a future messaging system. Existing databases are migrated on startup.

## Important demo limitations

This is a local demo, not a production ordering system. The `/orders` dashboard
has no authentication, and customer phone numbers are stored in the local
database and included in order messages. Before deploying, add staff/customer
authentication, secure transport, privacy and retention controls, and a
production-grade messaging/fulfillment workflow.

Run the API and QR/order flow test with:

```sh
npm test
```
