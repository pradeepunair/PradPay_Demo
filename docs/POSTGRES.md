# Optional local PostgreSQL

The default `/simulation` works without a database. PostgreSQL is needed only if you want a durable simulated Studio payment or the Postgres-backed `/local-sandbox` journey. Use a disposable local database; these migrations are for the demo.

Install and start PostgreSQL locally, create a dedicated database such as `pradpay_demo`, and put its **loopback** connection string in ignored `.env.local`:

```dotenv
PAYMENTLAB_ENVIRONMENT=local
PAYMENTLAB_DATABASE_MODE=local
DATABASE_URL=postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/pradpay_demo
```

If the password has URL-special characters, percent-encode them in the URL. Never commit the URL. Apply the foundation migration first:

```sh
psql -h 127.0.0.1 -U YOUR_USER -d pradpay_demo -v ON_ERROR_STOP=1 -f db/migrations/202609180001_m2_persistence_foundation/up.sql
```

For durable fictional payment evidence in `/simulation`, then apply:

```sh
psql -h 127.0.0.1 -U YOUR_USER -d pradpay_demo -v ON_ERROR_STOP=1 -f db/migrations/202609300001_studio_payment/up.sql
```

Set `PAYMENTLAB_STUDIO_DURABLE_ENABLE=1` in `.env.local` and restart the app. The Studio's payment remains **synthetic**; this mode stores one operation and receipts in PostgreSQL so refresh/recovery can be inspected. It does not call Stripe.

For the Postgres-backed `/local-sandbox` A2A journey, apply these migrations after the foundation:

```sh
psql -h 127.0.0.1 -U YOUR_USER -d pradpay_demo -v ON_ERROR_STOP=1 -f db/migrations/202609290001_local_demo_durable/up.sql
psql -h 127.0.0.1 -U YOUR_USER -d pradpay_demo -v ON_ERROR_STOP=1 -f db/migrations/202609290002_local_failure_recovery/up.sql
```

Set `PAYMENTLAB_LOCAL_DEMO_ENABLE=1` and `PAYMENTLAB_LOCAL_DEMO_STORE=postgres` in `.env.local`, then restart. This mode still requires LM Studio. The Stripe payment switch remains independent and off by default.

To inspect evidence without changing it:

```sql
SELECT operation_id, scenario, status, order_status, dispatch_count, created_at
FROM studio_payment_operations ORDER BY created_at DESC LIMIT 20;
SELECT run_id, snapshot->>'state' AS state, created_at
FROM local_demo_journeys ORDER BY created_at DESC LIMIT 20;
```

In DBeaver, add a PostgreSQL connection using the host, port, database, user, and password parsed from your own `DATABASE_URL`. The database itself is local; no Neon account is needed.
