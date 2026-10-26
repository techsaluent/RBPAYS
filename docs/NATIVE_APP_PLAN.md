# TutiPays — Native Mobile App Plan

A native Android/iOS app is a **separate project** from this API/panel
codebase, but it runs entirely on the APIs that already exist here. This is
the plan, the API contract it uses, and the store/branding checklist — so the
app can be built (in-house or by a vendor) without reverse-engineering
anything.

---

## 1. Recommendation

- **Framework:** React Native (or Flutter). One codebase → Android + iOS.
  Fastest path given the API is plain REST + JWT.
- **Scope v1 (retailer app):** login, wallet balance + add-money request,
  do a transaction (recharge / BBPS / DMT / payout), transaction history +
  receipt, disputes, profile/KYC, notifications inbox.
- **Scope v2:** distributor/MD network views, reports, white-label theming
  (pull brand from the tenant — see white-label doc).
- **Interim option (no store):** ship the existing panel as an installable
  **PWA** first (add-to-home-screen, icon, offline shell) for a native-like
  experience with zero app-store delay, then build native in parallel.

## 2. API contract (everything the app needs already exists)

Base: `https://tutipays.com/api/v1` · Auth: `Authorization: Bearer <JWT>`

| Feature | Endpoint(s) |
|---|---|
| Login / refresh / OTP | `POST /auth/login`, `/auth/refresh`, `/auth/*` |
| Wallet | `GET /wallet`, `POST /topup/requests` |
| Transactions | `POST /recharge`, `/bbps/pay`, `/dmt`, `/payout`, … |
| History + receipt | `GET /transactions`, `GET /transactions/:id/receipt` |
| Beneficiaries | `/beneficiaries/*` |
| KYC | `/kyc/*` |
| Disputes | `/disputes/*` |
| Notifications (inbox) | `/notifications/*` |
| Network (dist/MD) | `/network/*` |

- Same request/response shapes as the web panel — the app is a second client
  on the same API, nothing new server-side for v1.
- Money in rupees on input, paise in the ledger; 15-char reference per txn.
- Push notifications: add an FCM/APNs token endpoint + fan-out (small server
  addition) when the app needs push; until then the in-app inbox covers it.

## 3. Security

- Short-lived access JWT + refresh token (already issued by `/auth`).
- Device binding + optional biometric unlock (app-side).
- Transaction MPIN already supported server-side (`security_require_txn_mpin`).
- Certificate pinning to the API domain (app-side).
- **Screen-capture blocking (true block — app-only).** Unlike the web panels
  (where a page can only deter + watermark, never block an OS screenshot), the
  native apps hard-block capture:
  - **Android:** set `FLAG_SECURE` on the app window
    (`getWindow().setFlags(LayoutParams.FLAG_SECURE, …)`; in React Native use
    `expo-screen-capture` `preventScreenCaptureAsync()` or
    `react-native-screenshot-prevent`). This blocks screenshots **and** screen
    recording, and shows a blank frame in the app switcher / screen mirroring.
  - **iOS:** screenshots can't be blocked, but detect them
    (`UIApplication.userDidTakeScreenshotNotification`) and detect active
    recording/mirroring (`UIScreen.main.isCaptured`) → blur the UI with a
    secure overlay while captured (`expo-screen-capture` exposes both). Hide
    sensitive views behind the app-switcher snapshot
    (`applicationWillResignActive` → cover with a splash/blur view).
  - Apply globally, or at least on balance, statement, card and OTP screens.
  - This complements the web layer (`web/panel/privacy.js`: identity
    watermark, copy/context-menu block, hide-on-background, print block), which
    is the strongest a browser allows.

## 4. Store & branding checklist (per brand / white-label tenant)

- App name, bundle id / package name (e.g. `com.yourbrand.pay`).
- App icon (1024×1024) + adaptive icon; splash screen.
- Brand colours + logo (pulled from the tenant brand record — see white-label
  doc Stage 1).
- Privacy policy + account-deletion URL (already live: `/privacy.html`,
  `/delete-account.html`) — **required by both stores**.
- Play Store: data-safety form, financial-app declaration, target API level.
- App Store: App Privacy nutrition labels, financial-services review notes,
  demo account for review.
- Support contact + marketing copy + screenshots.

## 5. Suggested milestones

1. PWA of the existing panel (installable) — days.
2. RN/Flutter shell + auth + wallet + one service — ~2–3 weeks.
3. All retailer services + history/receipt/disputes — ~2–3 weeks.
4. Push notifications + KYC capture — ~1–2 weeks.
5. Store submission (both) + white-label theming — ~1–2 weeks.

*(Estimates assume one experienced mobile dev and the existing API unchanged.)*
