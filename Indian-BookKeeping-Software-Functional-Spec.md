# Indian Double-Entry Bookkeeping Software — Functional Specification
### For Product-Based, Service-Based & Hybrid Businesses (Ind AS / GST Compliant)

---

## 1. Business Model Coverage

Your app needs to serve three business types, each with different workflows on the same double-entry core:

| Type | Examples | Key Difference |
|---|---|---|
| **Product-based** | Retail, wholesale, manufacturing, distribution | Inventory-driven; stock valuation matters |
| **Service-based** | Consulting, agencies, freelancers, SaaS, contractors | Time/milestone-driven; no stock, but WIP & recurring billing matter |
| **Hybrid** | Repair shops, restaurants, IT resellers (hardware + AMC) | Needs both inventory AND service billing on the same invoice |

The architecture below is designed so one core ledger engine serves all three — only the front-end voucher types differ.

---

## 2. Core Double-Entry Engine (Common to All)

- Chart of Accounts (Assets, Liabilities, Equity, Income, Expense) mapped to **Schedule III**
- Every transaction, regardless of module, ultimately posts a journal entry (Dr/Cr) — inventory, sales, and service modules are just **front-ends that generate journal entries automatically**
- Multi-level account groups (Group → Ledger → Sub-ledger) like Tally's structure
- Cost centers / Cost categories (for department-wise or project-wise P&L)
- Multi-currency with Ind AS 21 revaluation
- Financial year lock, edit-log audit trail (mandatory per MCA rules)

---

## 3. PRODUCT-BASED BUSINESS MODULE

### 3.1 Item/Product Master
- Item code, name, description, HSN code, GST rate, UOM (with alternate UOM & conversion factor)
- Item category, brand, item image
- Opening stock (qty + value) per godown
- Sales price list (multiple price levels: retail, wholesale, dealer), purchase price
- Reorder level, min/max stock, lead time
- Barcode/QR generation and scanning support
- Batch/serial number/expiry tracking flags per item

### 3.2 Inventory Transactions
- Stock in: Purchase, Purchase return (from customer... no, from vendor is reversed), Stock transfer in, Manufacturing/production entry, Opening stock, Positive stock adjustment
- Stock out: Sales, Sales return to vendor(purchase return), Stock transfer out, Consumption (BOM), Damage/write-off, Negative adjustment
- Multi-godown transfer voucher (godown A → godown B) with in-transit stock status
- Stock valuation: FIFO / Weighted Average (Ind AS 2 — LIFO not allowed)
- Batch-wise and FIFO-layer-wise costing for accurate COGS

### 3.3 Sales Cycle (Product)
1. **Enquiry/Lead** (optional CRM-lite)
2. **Quotation** → convert to Sales Order
3. **Sales Order** → partial/full delivery tracking
4. **Delivery Challan** (goods movement without invoice — needs e-way bill if value > threshold)
5. **Tax Invoice** (auto GST split: CGST+SGST if intra-state, IGST if inter-state)
6. **E-invoice** generation (IRN + QR code) if turnover threshold applies
7. **Payment receipt** (full/partial/advance)

### 3.4 Purchase Cycle (Product)
1. **Purchase Requisition** (internal, optional)
2. **Purchase Order** to vendor
3. **Goods Receipt Note (GRN)** — stock updated here, before invoice
4. **Purchase Invoice** — 3-way match (PO vs GRN vs Invoice) before approval
5. **Landed cost allocation** — freight/customs/insurance apportioned across items by value or weight
6. **Vendor payment** (full/partial/advance/on credit terms)

### 3.5 Sales & Purchase Returns
- **Sales return** → Credit note → reduces receivable, reverses GST output, adds stock back
- **Purchase return** → Debit note → reduces payable, reverses GST input, removes stock
- Return can be linked to original invoice (partial or full) or standalone
- Return reason codes: wrong item, quality issue, excess supply, damaged in transit

### 3.6 Damage / Loss / Write-off
- Separate voucher type — **not** a sale or purchase
- Reduces stock quantity and value, books to "Loss on Damaged Goods" expense account
- **Critical GST rule**: Input Tax Credit (ITC) already claimed on damaged/lost/stolen/free-sample goods must be **reversed** under Section 17(5)(h) — system must auto-calculate and post ITC reversal entry
- Reason codes: transit damage, expiry, theft, fire, manufacturing defect, free sample given
- Optional linkage to insurance claim tracking (claim raised, claim received, shortfall written off)

---

## 4. SERVICE-BASED BUSINESS MODULE

This is the part most Indian software (Tally, Busy) handles weakly — worth doing well.

### 4.1 Service/Item Master (Non-stock)
- Service code, name, SAC code, GST rate
- Billing basis: Fixed fee / Hourly / Milestone / Retainer (recurring)
- Standard rate card per service, per client-tier

### 4.2 Project/Engagement Tracking
- Each client engagement = a "Project" with budget, start/end date, assigned team
- **Timesheet module**: employee logs hours against project/task, billable vs non-billable flag
- **Work-in-Progress (WIP)** tracking — unbilled hours/costs sitting on the balance sheet until invoiced (relevant under Ind AS 115)
- Expense capture against project (travel, subcontractor cost) for reimbursable billing

### 4.3 Service Billing Cycle
1. **Proposal/Quotation** for scope of work
2. **Engagement letter / Service agreement** (document attachment)
3. **Billing methods:**
   - **Milestone billing** — invoice raised on completion of defined stage (% completion method, Ind AS 115)
   - **Time & Material** — invoice from timesheet hours × rate
   - **Retainer/AMC** — recurring auto-invoice generation (monthly/quarterly/annual) — critical for AMC, subscriptions, SaaS
   - **Advance/Retainer against future work** — booked as liability until adjusted
4. **Tax Invoice** with SAC code, GST (usually no e-way bill needed for pure services)
5. **Revenue recognition**: recognize revenue over time (% completion) vs point in time, per Ind AS 115 — this needs an "unbilled revenue" / "deferred revenue" ledger logic
6. **Receipt against invoice**, with TDS deduction handling (client deducts TDS u/s 194J/194C — software should track TDS receivable and reconcile against Form 26AS)

### 4.4 Service Returns / Adjustments (Credit Notes)
- No physical "return," but credit note needed for: service not rendered, dispute/discount post-invoice, overbilling correction
- Reduces receivable and reverses GST output tax on the credited portion

### 4.5 Recurring/Subscription Billing (AMC, SaaS, Retainers)
- Auto-generate invoices on a schedule (monthly/quarterly/annual)
- Auto-apply annual rate escalation if configured
- Dunning/reminder workflow for overdue recurring invoices
- Pause/resume/cancel subscription mid-cycle with pro-rata billing

---

## 5. HYBRID INVOICE SUPPORT

A single invoice must support **both stock items and service line items together** (e.g., "Laptop repair" = spare part [stock, HSN] + labor charge [service, SAC]) with correct GST rate applied per line, not per invoice.

---

## 6. MULTI-PAYMENT OPTIONS

- **Modes**: Cash, Cheque, NEFT/RTGS/IMPS, UPI (with QR generation), Debit/Credit Card, Net Banking, Wallets (Paytm/PhonePe), Payment gateway link (Razorpay/PayU/Cashfree)
- **Split payment**: one invoice settled across multiple modes (e.g., ₹5,000 cash + ₹15,000 UPI)
- **Advance/token payment**: booked as liability, later adjusted against invoice (with GST on advance for services, per Section 13 time-of-supply rules where applicable)
- **Post-dated cheque (PDC) management**: register, maturity alerts, bounce/re-presentation handling, bounce charges
- **Partial payment & payment schedule** for large invoices (installments/EMI)
- **Auto-reconciliation** via payment gateway webhook or bank statement import
- **TDS-adjusted receipt**: client pays invoice minus TDS — receipt entry should auto-split into Bank Dr + TDS Receivable Dr against full invoice value

---

## 7. REPORTS (By Category)

### Financial
- Trial Balance, P&L, Balance Sheet, Cash Flow Statement, Notes to Accounts
- Day Book, Cash Book, Bank Book
- Ratio analysis (current ratio, DSO, inventory turnover)

### Inventory (Product businesses)
- Stock summary (item/godown/category-wise), stock ledger, valuation report
- Reorder report, fast/slow/dead stock, batch expiry report
- Damage/write-off report with ITC reversal amount

### Sales & Purchase
- Sales/Purchase register (GST-return-ready format)
- Party-wise, item-wise, salesperson-wise, project-wise analysis
- Return/credit note summary with reason-wise breakup
- Outstanding receivables/payables with aging (0-30/31-60/60-90/90+)

### Service-Specific
- Project profitability report (billed vs cost vs budget)
- Timesheet utilization report (billable vs non-billable %)
- WIP/unbilled revenue report
- Recurring billing schedule and renewal forecast
- TDS receivable reconciliation (vs Form 26AS)

### Tax/Compliance
- GSTR-1, GSTR-3B, GSTR-2A/2B reconciliation reports
- ITC reversal report (Section 17(5))
- E-invoice/IRN register, e-way bill register
- TDS/TCS deduction and challan reports

### Payments
- Payment mode-wise collection report
- PDC register (pending/matured/bounced)
- Advance received/adjusted report

---

## 8. TECHNICAL ARCHITECTURE NOTES (Developer POV)

- **Ledger-first design**: every module (inventory, sales, service billing, payments) is a wrapper that generates immutable journal entries — never let a module bypass the ledger
- **Decimal precision** (never float) for all currency and quantity fields
- **Voucher numbering**: sequential, no gaps, financial-year-scoped, per Companies Act requirement
- **Audit trail**: every edit/delete logged with user, timestamp, before/after value (mandatory since MCA's 2023 audit trail rule)
- **Rate history tables**: GST rate, TDS rate, and price list changes must be date-effective (a June invoice must use the rate that was valid then, even if rates changed later)
- **Multi-GSTIN / multi-branch** data segregation with consolidated reporting
- **API-first**: GSTN (GSP/ASP) for e-invoice/e-way bill, bank statement import (MT940/CSV/OCR), payment gateway webhooks
- **Role-based access control**: separate permissions for accountant, sales staff, inventory staff, auditor (read-only), admin
- **Offline-first option**: useful for retail/field sales apps with sync-on-reconnect

---

## 9. PARTY (CUSTOMER/VENDOR) MANAGEMENT MODULE

### 9.1 Party Master
- Party type: Customer / Vendor / Both (some parties are both) / Employee / Other
- Legal name, trade name, PAN, GSTIN (with auto-fetch of registered name via GSTIN validation API), GST registration type (Regular/Composition/Unregistered/SEZ)
- Multiple addresses per party (billing, shipping, registered office) — each can have a different GSTIN if party has multi-state presence
- Multiple contact persons per party (name, designation, phone, email) — useful for B2B where purchase/accounts/logistics contacts differ
- Bank account details (for vendor payments — with penny-drop/bank verification before first payment)
- Credit terms: credit limit, credit period (days), interest on overdue (if applicable)
- Price list/category assignment (retail/wholesale/dealer) — auto-applies correct rates on invoicing
- Party grouping (by region, industry, sales zone, salesperson)
- Opening balance (Dr/Cr) with as-on date
- KYC document storage (PAN card, GST certificate, MSME certificate, cancelled cheque)
- MSME/Udyam registration flag — triggers MSME Act payment-delay interest calculation automatically (45-day rule)
- TDS applicability flag per party (whether you deduct TDS on payments to them, and rate)
- Blacklist/hold flag (stop billing to defaulters automatically)

### 9.2 Party Ledger & Statements
- Real-time running ledger per party with running balance
- Auto-generated **party statement** (PDF/WhatsApp/Email) for a date range, on demand or scheduled (e.g., auto-send statement on 1st of every month)
- Ledger confirmation/reconciliation request (send "confirm balance" requests to parties — useful at year-end audit)
- Aging-wise outstanding view directly on party screen (0-30/31-60/60-90/90+)
- Payment/collection reminders (auto SMS/WhatsApp/email at X days overdue) — big ease-of-use win for Indian SMEs
- Party-wise profitability (for customers: margin earned; for vendors: purchase volume/discount earned)
- Duplicate-party detection (same PAN/GSTIN entered twice)
- Merge-party utility (if same party got created twice by mistake, merge ledgers safely with audit trail)

### 9.3 Ease-of-Use Features (Client-Facing)
- **WhatsApp integration**: send invoice, payment receipt, and reminders directly on WhatsApp (huge in Indian SME workflow)
- **Voice-to-invoice / quick entry**: minimal-tap invoice creation for small retailers (search item, tap qty, done)
- **Smart auto-suggest**: item/party name auto-complete with recent/frequent items first
- **Bulk import**: parties, items, opening balances via Excel/CSV template with validation preview before commit
- **Duplicate invoice/voucher number warning** in real time
- **One-tap "collect payment"** with UPI QR shown to customer at counter, auto-reconciled on payment
- **Dashboard**: today's sales, collections, top overdue parties, low-stock alerts, cash-in-hand — single-screen view on app open
- **Multi-language support** (Hindi + regional languages) for vernacular business owners
- **Dark mode, offline mode with auto-sync**, and a simple/advanced UI toggle (simple mode hides ledger jargon for non-accountant shop owners)
- **Undo/edit window**: allow correction of last voucher within a short window before it hard-locks (balanced against audit trail requirement — edits after lock always go through proper credit/debit note, not silent edit)
- **Smart reminders**: renewal due for AMC, PDC maturing tomorrow, GST return due in 3 days, stock below reorder level — proactive notifications instead of user having to check reports

---

## 10. SECURITY ARCHITECTURE (Client + Server)

A quick reality check before the list: **no system connected to the internet is unhackable.** The honest engineering goal is to make an attack (a) very hard, (b) detectable fast, and (c) limited in damage if it happens. Below is what "as strong as realistically achievable" looks like for a financial app, split client vs server.

### 10.1 Client-Side (Mobile App / Web Frontend)
- **No sensitive data stored on device**: no plaintext financial data, tokens, or passwords in local storage; use platform secure storage (Android Keystore / iOS Keychain) only for encrypted session tokens
- **Certificate pinning** on mobile apps — prevents man-in-the-middle attacks even on compromised networks/proxies
- **Biometric app-lock** (fingerprint/face) in addition to login, especially before showing financial reports
- **Screenshot/screen-recording block** on sensitive screens (bank details, reports) — Android `FLAG_SECURE` / iOS equivalent
- **Jailbreak/root detection** — restrict or warn on compromised devices
- **Obfuscated/minified code** (ProGuard/R8 for Android, code obfuscation for web JS) to slow down reverse engineering
- **Input validation & sanitization** on every field client-side (defense-in-depth; never trust client validation alone — server must re-validate)
- **Auto-logout** after inactivity period, especially on shared/POS devices
- **Content Security Policy (CSP), Subresource Integrity (SRI)** for the web app to block injected scripts

### 10.2 Server-Side
- **Authentication**: 
  - Password hashing with bcrypt/Argon2 (never MD5/SHA1, never plaintext)
  - Mandatory MFA/OTP (especially for admin, high-value actions like large payments or user-role changes)
  - Short-lived JWT access tokens + refresh token rotation; immediate revocation list for logout/compromise
- **Authorization**:
  - Role-Based Access Control (RBAC) enforced server-side, never trust client-sent role/permission
  - Row-level/tenant-level isolation — every query scoped by company/GSTIN ID, tested against cross-tenant data leakage
- **Data protection**:
  - Encryption at rest (AES-256) for the database, especially PAN, bank details, GSTIN
  - Encryption in transit — TLS 1.2+/1.3 only, HSTS enforced, no mixed content
  - Field-level encryption for the most sensitive fields (bank account numbers, PAN) even within an encrypted DB — so a DB dump alone isn't enough
  - Secrets management via a vault (AWS Secrets Manager/HashiCorp Vault) — never hardcode API keys/DB credentials in code or config files
- **Application security**:
  - Parameterized queries/ORM only — zero raw SQL string concatenation (prevents SQL injection)
  - Output encoding to prevent XSS; strict CSP
  - CSRF tokens on all state-changing requests
  - Rate limiting & brute-force lockout on login, OTP, and API endpoints
  - Idempotency keys on payment/invoice-creation APIs to prevent duplicate transactions from retries
  - Regular dependency scanning (Snyk/Dependabot) — most breaches happen via outdated third-party libraries, not custom code
- **Infrastructure**:
  - WAF (Web Application Firewall) in front of the API — blocks common attack patterns automatically
  - Network segmentation — database never directly internet-facing; accessible only from application layer via private network
  - DDoS protection (Cloudflare/AWS Shield)
  - Automated, encrypted, geographically-redundant backups with tested restore process (backup you've never restored isn't a backup)
  - Immutable audit logs shipped to a separate system (so even an attacker with DB access can't erase their tracks)
- **Process & monitoring**:
  - Intrusion detection/anomaly monitoring (unusual login location, bulk data export, odd-hour admin actions trigger alerts)
  - Regular third-party penetration testing and VAPT (Vulnerability Assessment & Penetration Testing) — genuinely important for Indian fintech-adjacent apps and often expected for compliance
  - Bug bounty or responsible disclosure program once you have users, to catch issues before malicious actors do
  - SOC 2 / ISO 27001 alignment as you scale, especially if you'll pitch to businesses that care about data security certifications
- **Compliance-specific**:
  - India's **Digital Personal Data Protection (DPDP) Act, 2023** — consent for personal data, breach notification obligations, data localization considerations
  - RBI/NPCI guidelines if you integrate UPI/payment collection directly
  - GST data retention (72 months) and Companies Act retention (8 years) with tamper-evident storage

---

## 12. AI / SMART AUTOMATION FEATURES

### 12.1 Location-Based Party Intelligence
- **Geo-tagged party addresses**: capture GPS coordinates when a party is created (field sales rep visits shop → tap "use current location" → auto-fills address, pin dropped on map)
- **Geofencing for auto-party-selection**: define a small radius (e.g., 50–100m) around each party's saved location; when a salesperson opens "New Sale" while physically within that radius, the app auto-suggests/auto-selects that party instead of manual search
- **Multi-party proximity handling**: if two parties are geofenced close together (e.g., shops in the same market), show a ranked shortlist (nearest first) rather than force-picking one incorrectly
- **Route-based visit planning**: for field sales teams, auto-sequence the day's party visits by proximity (traveling-salesman-style route optimization) and log actual visit vs planned visit
- **Geo-stamped invoice/visit proof**: timestamp + location stored on the sale voucher itself — useful for sales-team accountability and dispute resolution ("did the rep actually visit?")
- **Offline geofencing**: cache party locations locally so geofence detection still works without live internet (common in tier-2/3 town field sales), sync the sale once back online

### 12.2 Bank Statement AI Extraction & Auto-Reconciliation
- Upload bank statement as PDF/CSV/scanned image (OCR fallback for scanned/photographed statements)
- AI parses each row and extracts: **date, value date, narration/description, reference/UTR number, amount, Dr/Cr**
- **Smart party matching**: parses the narration text (e.g., "UPI/RAJESH TRADERS/402198273") to fuzzy-match against existing party names/UPI IDs/account numbers already in the system, and suggests the matching party
- **Auto-fill reference number field**: extracted UTR/transaction ID auto-pasted into the payment voucher's reference field — exactly as you described
- **Auto-suggest voucher matching**: matches the bank amount against open/unpaid invoices of the matched party (by amount and rough date proximity) and proposes "mark Invoice #INV-2031 as paid" for one-tap confirmation
- **Anomaly flagging**: unrecognized narration, amount mismatch, or duplicate reference number gets flagged for manual review instead of silently auto-posting
- **Learning loop**: each manual correction (user picks the right party when AI guessed wrong) feeds back to improve future matching accuracy for that narration pattern

### 12.3 Other High-Value AI Features
- **Invoice/bill OCR (vendor bills)**: photograph a paper purchase bill → AI extracts vendor name, GSTIN, invoice number, date, line items, amounts, GST → auto-creates draft purchase entry for review
- **Voice-to-voucher entry**: speak "Sold 5 bags of cement to Sharma Traders, cash" → AI parses intent and drafts the sale voucher
- **Predictive stock reordering**: AI forecasts demand (based on sales velocity + seasonality) and auto-suggests purchase orders before stockouts
- **Cash flow forecasting**: AI projects next 30/60/90-day cash position based on receivables aging, payables due dates, and recurring expenses
- **Anomaly/fraud detection**: flags unusual entries — a sale at way below normal margin, a round-number cash entry pattern, a voucher edited late at night, duplicate vendor bills — for owner/auditor review
- **Smart GST reconciliation**: auto-matches GSTR-2A/2B data against purchase register and highlights mismatches (vendor didn't file, amount mismatch) automatically each month
- **Natural-language reports**: owner types/asks "How much did I sell to Sharma Traders last month?" or "Which customers haven't paid in 60 days?" and gets a direct answer/report instead of navigating menus
- **Automated collection reminders with tone selection**: AI drafts a polite/firm reminder message based on how overdue the payment is, sent via WhatsApp/SMS automatically
- **Receipt/expense capture via photo**: snap a photo of a petty-cash receipt → AI extracts amount, vendor, category → auto-books the expense entry
- **Duplicate/near-duplicate detection**: AI catches near-duplicate parties ("Sharma Traders" vs "Sharma Trader's") or duplicate invoices before they corrupt reports

### 12.4 Implementation Notes (Developer POV)
- Bank statement parsing: combine a **PDF/CSV parser** for digital statements with an **OCR + LLM extraction pipeline** for scanned/photographed statements; validate extracted totals against the statement's stated opening/closing balance as a sanity check before accepting
- Party-name fuzzy matching: use a **string-similarity algorithm** (e.g., Levenshtein/Jaro-Winkler) combined with known aliases (UPI handle, account number) stored per party, not just name matching alone
- Geofencing: implement via device GPS + a background location-check service (respect battery and OS background-location permission limits on Android/iOS — this needs careful permission-flow design, not just "always-on" tracking, or app-store approval will be rejected)
- **Privacy-by-design**: location tracking must be opt-in, clearly disclosed, limited to work hours/sales-rep role, and compliant with the **DPDP Act, 2023** consent requirements — this is sensitive personal data
- All AI suggestions (party match, reconciliation match, OCR extraction) should be **propose-and-confirm**, never silent auto-post, for anything touching money — keeps a human in the loop and preserves the audit trail integrity discussed in Section 10

---

## 13. SUGGESTED BUILD PHASING (MVP → Full)

1. **Phase 1 (MVP)**: Core ledger, Chart of Accounts, basic sales/purchase invoice, GST calculation, simple inventory, cash/bank payment
2. **Phase 2**: Multi-payment modes, returns/credit-debit notes, damage/ITC reversal, GSTR reports
3. **Phase 3**: Service module — projects, timesheets, milestone/recurring billing, WIP
4. **Phase 4**: E-invoicing, e-way bill, TDS automation, multi-godown, batch/serial tracking
5. **Phase 5**: Advanced reporting, budgeting, audit trail hardening, role-based access, offline sync
6. **Phase 6**: Party module (statements, reminders, WhatsApp integration), full security hardening (MFA, encryption, WAF), and VAPT before public launch
7. **Phase 7**: AI features — bank statement auto-extraction/reconciliation, geofenced party auto-selection for field sales, OCR bill capture, predictive stock/cash-flow forecasting
