# Connected Banking

Link a corporate/current bank account (directly or via a banking aggregator)
so the platform can track its balance + statement, **collect** into per-member
virtual accounts, and (future) fund payouts from it. Money is integer paise.

## Concepts

- **Bank connection** — one linked account. `owner_user_id` NULL = the
  platform's own account; set = a distributor/partner who connected theirs.
  `driver` selects the integration (`manual` = admin-maintained; provider
  drivers plug in later). Account numbers are stored **masked only**.
- **Virtual account (VA)** — a collection account mapped to one member. Money
  landing in it auto-loads that member's wallet.
- **Statement** — read-model lines pulled/pushed from the bank (reconciliation).
- **Collection** — an inbound bank credit that funds a member's wallet.
  Idempotent on `(connection, external_id)`.

## Admin (console → Finance → Connected Banking)

- Connect an account, set/refresh its balance, edit, disable.
- Assign virtual accounts to members.
- View statement + collections; record a collection manually (reconciliation);
  apply an unmatched collection to a member.

All money-moving actions are audited.

## Collection webhook

A bank / aggregator posts inbound credits to:

```
POST /api/v1/webhooks/bank/<connection-id>
```

**Auth** (from the connection's `extra`):
- `webhook_secret` set → HMAC-SHA256 of the raw body in `X-Webhook-Signature`
  (a `sha256=` prefix is accepted).
- else `webhook_ips` set (comma list or array; exact IPs or CIDR) → caller-IP
  allowlist.
- else none — secured only by the unguessable connection id. Configure a
  secret or IP list for production.

**Body** — flexible key names are accepted and mapped:

| Field | Accepted keys |
|---|---|
| amount | `amount_paise`/`amountPaise` (paise), or `amount`/`amount_rupees`/`credit_amount`/`txn_amount` (rupees) |
| external id (idempotency) | `external_id`/`reference`/`rrn`/`utr`/`transaction_id`/`txn_id`/`id` |
| virtual account | `va_number`/`virtual_account`/`vpa`/`to_account`/`account_number` |
| utr | `utr`/`rrn`/`bank_reference` |
| payer | `payer`/`sender`/`remitter`/`from` |

**Behaviour** — resolves the member from the VA (or an explicit `user_id`) and
auto-credits their wallet (`bank_collection` source). A credit with no
resolvable member is stored **unapplied** for an admin to apply. Replays with
the same `external_id` are no-ops. Every delivery is recorded to the webhook
monitor (`provider = bank:<connection-id>`).

Response: `{ status, acknowledged, duplicate, collection_status, credited_user }`.

## Wallet settlement

- **Bank → wallet**: collections auto-load the member wallet (above).
- **Wallet → bank**: the existing withdrawal / batch-payout flow settles out.
