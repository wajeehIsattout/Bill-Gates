# مصاريف الرحلة — Trip Expenses

A small, private, Arabic (RTL), mobile-first web app for splitting trip expenses among ~20 friends.
Everyone can **view** people, expenses, balances and settlement status. Only the **admin** (one shared password) can change anything.

- **Stack:** Node.js + Express 5, SQLite (`better-sqlite3`), plain HTML/CSS/JS (no build step).
- **Data:** one SQLite file, `data/trip.db`.
- **Runs on:** any port (default **4070**) on a plain IP. No domain, HTTPS, or cloud service needed.

---

## 1. Installation

Requirements: **Node.js 20.12 or newer** (22 LTS recommended) and npm.

```bash
cd splitwise
npm install
cp .env.example .env      # then edit .env if needed
```

`better-sqlite3` ships prebuilt binaries for common platforms. If npm has to compile it, install build tools first (`sudo apt install build-essential python3` on Debian/Ubuntu).

## 2. Configuration

Settings are environment variables. The server reads them from `.env` in the project folder. Variables that are already set in the environment take priority over `.env`.

| Variable         | Default   | Meaning |
|------------------|-----------|---------|
| `ADMIN_PASSWORD` | *(none, required)* | Admin password. Initial value in `.env.example`: `helloworld!!` |
| `PORT`           | `4070`    | Port to listen on |
| `HOST`           | `0.0.0.0` | Interface. `0.0.0.0` makes it reachable from phones on the network. Use `127.0.0.1` for local only. |
| `DATA_DIR`       | `data`    | Folder for the SQLite database |
| `COOKIE_SECURE`  | `auto`    | `auto` adds the cookie `Secure` flag only on HTTPS requests. Set `true` if you always serve over HTTPS. |
| `TRUST_PROXY`    | `false`   | Set `true` only behind a reverse proxy (nginx/Caddy), so rate limiting sees real client IPs |
| `SESSION_HOURS`  | `168`     | How long an admin login lasts (7 days) |

Keep `.env` private (`chmod 600 .env`). It is listed in `.gitignore`.

## 3. Database initialization / migration

There is nothing to run by hand. On startup the server creates `DATA_DIR/trip.db` and its tables if they don't exist yet. The schema version is tracked in SQLite's `user_version`, so future schema changes can be applied automatically in `db.js`.

Schema (3 tables plus sessions):

- `people(id, name)`: names are unique (case-insensitive).
- `invoices(id, name, description, total_cents, split_mode, version)`: `description` is optional free text, up to 500 characters.
- `invoice_members(invoice_id, person_id, paid_cents, share_cents, settled_cents)`: one row per participant. Payers are always participants.
- `sessions(token_hash, csrf_token, expires_at)`: admin logins, stored only as SHA-256 hashes.

The app works with **whole numbers only**: any fraction entered is rounded **up** (5.1 → 6, 5.7 → 6). Values are stored as integer cents (always a multiple of 100). No currency symbol is shown. Balances are never stored; the server computes them from these facts on every read. Schema v2 rounds up any fractional values left by older versions, automatically on startup.

## 4. Starting the server

```bash
npm start
# → Trip expenses app running on http://localhost:4070
```

Friends open `http://<server-ip>:4070` on their phones. Make sure the port is open in the server's firewall, e.g. `sudo ufw allow 4070/tcp`.

To keep it running after you log out, use **pm2**:

```bash
npm install -g pm2
pm2 start server.js --name trip
pm2 save && pm2 startup     # restart on reboot
```

Or use a systemd unit with `WorkingDirectory=/path/to/splitwise` and `ExecStart=/usr/bin/node server.js`.

## 5. Changing the admin password

1. Edit `.env` and set `ADMIN_PASSWORD=your-new-password`.
2. Restart the server (`pm2 restart trip`, or stop and run `npm start` again).

The password is never written to the database or sent to the browser. At startup the server derives a salted scrypt hash in memory and removes the plaintext from `process.env`.

To also sign out every existing admin session, delete all rows from the `sessions` table while the server is stopped: `sqlite3 data/trip.db "DELETE FROM sessions;"`.

## 6. Changing the port

Set `PORT=5000` (or any free port) in `.env` and restart. You can also override it for a single run: `PORT=5000 npm start`.

## 7. Backups

```bash
npm run backup                   # → backups/trip-YYYY-MM-DD-HH-MM-SS.db
npm run backup -- /path/copy.db  # custom destination
```

This makes a consistent copy even while the server is running. You can also stop the server and copy `data/trip.db`.

**Restore:** stop the server, replace `data/trip.db` with the backup file, delete any leftover `data/trip.db-wal` and `data/trip.db-shm`, then start the server.

### Starting over for a new trip

When logged in as admin, scroll to the bottom of the page and tap **↺ إعادة ضبط البيانات**. The confirmation window has two choices:

- **حذف المصروفات فقط** deletes all expenses and settlements but keeps the list of people (useful when the same friends travel again).
- **حذف كل شيء** deletes expenses, settlements, and people.

Before every reset, the server saves a full copy of the database to `data/backups/before-reset-<date>.db`. To undo a reset, restore that file as described above. The reset API (`POST /api/reset`) is admin-only and requires an explicit confirmation field, like every other change.

## 8. Tests

```bash
npm test
```

The tests start a real server on a temporary database and cover the required scenarios:

- **A.** Equal split of 100 among 20 people.
- **B.** Only the selected participants are affected.
- **C.** Manual split of 25: 15 + 10 is accepted, and so are 24 and 26 (the difference is shown). An all-zero split is rejected.
- **D.** Multiple payers: 120 + 80 of 200 gives +70 / +30 / −50 / −50.
- **Rounding.** 100 ÷ 3 gives 34 each. Decimal totals, shares, and payments are rounded up.
- **E, F, G.** Partial, full, and over-settlement.
- **H.** Every admin API is rejected without a session, with a forged cookie, or without a valid CSRF token.
- **I.** Wrong and correct passwords.
- **J.** Data persists across a restart.
- **Reset.** Admin only, needs confirmation, and saves a backup first.
- **Payments section.** The pay/paid and receive/received totals per person are checked against hand-calculated values.
- **Final bill.** Result = paid for others − paid by others, and recording payments never changes it.
- **Final payment.** One amount per person is spread over his expenses: netting, oldest first, partial payments, overpayment, zero balance, and authorization are all checked.

They also check input validation, ID tampering, edit conflicts, and login rate limiting.

---

## How the accounting works

For every expense:

1. **Participants** are the people who share the cost. The expense has a name and an optional **description** (الوصف) of what it included, shown on its card.
2. **Payers** are chosen from the participants. The amounts they paid must add up exactly to the total.
3. **Shares:**
   - **Automatic:** each participant's share is total ÷ number of participants, rounded **up** to a whole number (100 ÷ 3 = 34 each, so the shares add up to 102).
   - **Manual:** you enter each share (0 is allowed). The shares **do not** have to add up to the total: more or less is accepted, as long as they are not all zero. The admin can start from the automatic result and edit any value; this switches the split to manual.
   - When the shares don't add up to the total, the expense card shows the difference in amber.
4. **Net balance = amount paid − share.** Positive (green, "يستلم") means the person should receive money. Negative (red, "يدفع") means they should pay. What the payers paid must still add up exactly to the total. Because shares may differ from the total, the balances of one expense don't necessarily add up to zero.
5. **Settlement:** for each person the admin records how much they actually paid (if they owe) or received (if they are owed). The **✓ تم** button records the full amount, which the server calculates itself.
   - **Remaining** = amount required − amount recorded.
   - The **total difference** at the bottom of each card is Σ(recorded − required). Zero means balanced, negative means money is still missing (red), and positive means overpaid (green).
   - The footer lists who still has to pay (red) and who is still waiting to receive money (amber).
6. **إجمالي الرحلة** (trip summary): each person's net across all expenses, plus what is still open after the recorded settlements.
7. **الدفع والاستلام** (payments & receipts, at the end of the page): for each person, two separate totals across all expenses.
   - **عليه أن يدفع:** the total they must pay, how much they have paid, and what remains.
   - **له أن يستلم:** the total they must receive, how much they have received, and what remains.
   - These are not netted. Someone who owes 30 in one expense and is owed 300 in another sees both.
   - A card at the top shows the totals for everyone.
8. **الحساب النهائي** (final bill, below that): what each person pays or receives at the end of the trip. It depends **only on the expenses**; recording payments never changes it.
   - It is one card, closed by default, showing the overall totals. Tapping it drops down the list of people.
   - Each person shows his final result (يجب أن يدفع / يجب أن يستلم). Tapping him opens every expense he took part in, with what he pays or gets for each one, followed by his totals. Tapping again closes it.
   - **مصروفه الشخصي:** his own share of all expenses (what he spent on himself).
   - **دفع من جيبه:** everything he paid.
   - **إجمالي ما يجب أن يدفعه:** what others paid for him (the sum of the expenses where he pays).
   - **إجمالي ما يجب أن يستلمه:** what he paid for others (the sum of the expenses where he gets money back).
   - **Result** = total to receive − total to pay (= paid − share): **يجب أن يستلم** (green) or **يجب أن يدفع** (red).
   - **Final payment (admin):** under each person's result, the admin enters the one amount the person paid (if he owes overall) or received (if he is owed overall), or taps **✓ الكل** for the full amount. The server spreads it over all his expenses:
     - What he is owed in some expenses is **netted** against what he owes in others.
     - The rest is applied to his oldest expenses first.
     - Any extra shows as an overpayment on his last expense.
     - Like the per-expense fields, the amount is the total paid so far, not an addition.
   - **Status line (everyone):** shows how much has been paid or received toward the final amount and what remains, e.g. "دفع 1,000 من 2,230 · متبقي 1,230".

Deleting a person who appears in any expense is blocked, so past expenses stay intact. Remove them from those expenses first. Renaming is always allowed. When an expense is edited, recorded settlements are kept for everyone who is still in it.

## Security summary

- **Server-side authorization.** Every mutating endpoint requires a valid admin session. Hiding buttons in the UI is not the protection.
- **Admin session.** A random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` over HTTPS). Only its hash is stored. A new token is issued on every login.
- **CSRF.** Mutations need a per-session token in the `X-CSRF-Token` header and a JSON body. Requests with a foreign `Origin` are rejected.
- **Login rate limiting.** Up to 5 failed attempts per IP per 15 minutes, a global cap, and a delay after each failure. The password comparison is constant-time.
- **Untrusted input.** The server validates and normalizes every input: IDs must exist and belong to the expense, amounts use a strict number format (no negative, NaN, or Infinity values, and no scientific notation) and are rounded up to whole numbers, and totals are re-checked. The server recomputes all financial values and ignores client-sent balances.
- **SQL injection.** Only parameterized queries are used.
- **XSS.** The UI inserts data only as text nodes (never `innerHTML`). A strict Content-Security-Policy is set (no inline scripts), along with `nosniff`, `X-Frame-Options: DENY`, and `no-referrer`.
- **Concurrency.** Each change runs in a SQLite transaction. Expense edits carry a version number, so two admins editing the same expense can't silently overwrite each other.
- **Errors.** Responses carry short Arabic messages only; stack traces are never sent to the browser.

> Without HTTPS the password travels unencrypted on the network (fine on a trusted network for a private trip app). If you later add a domain, put Caddy or nginx with HTTPS in front and set `TRUST_PROXY=true` and `COOKIE_SECURE=true`.
