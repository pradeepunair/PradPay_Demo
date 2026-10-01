# LM Studio and local A2A setup

The Studio's local product suggestion and the `/local-sandbox` Buyer/Merchant journey use your own local LM Studio server. No OpenAI or Anthropic key is needed. A sufficiently capable instruction model is required; model choice affects latency and whether it returns a valid selection. The server validates product and price constraints regardless of model output.

1. Install LM Studio, download a model, load it, and start **Developer → Local Server**. The default address is `http://127.0.0.1:1234`.
2. Open `http://127.0.0.1:1234/v1/models` or run `curl http://127.0.0.1:1234/v1/models`. Copy an `id` from the response. `GET /` returning `Unexpected endpoint or method` is normal.
3. In the ignored `.env.local`, set:

```dotenv
PAYMENTLAB_ENVIRONMENT=local
PAYMENTLAB_STUDIO_LOCAL_MODEL_ENABLE=1
PAYMENTLAB_LOCAL_MODEL_URL=http://127.0.0.1:1234
PAYMENTLAB_LOCAL_MODEL_ID=YOUR_MODEL_ID_FROM_V1_MODELS
```

4. Restart `npm run dev`, open `/simulation`, and use the local-model selection when the catalog step offers it. The simulation still uses its own deterministic quote and fictional payment authority.

To run the separate live local A2A exchange, make a private directory outside the repository and enable its file-backed state:

```sh
mkdir -m 700 "$HOME/pradpay-demo-state"
```

Add to `.env.local` (replace the path with your actual absolute home path; Next.js does not expand `$HOME` in this value):

```dotenv
PAYMENTLAB_LOCAL_DEMO_ENABLE=1
PAYMENTLAB_LOCAL_DEMO_STORE=file
PAYMENTLAB_LOCAL_DEMO_STATE_DIR=/ABSOLUTE/PATH/TO/pradpay-demo-state
PAYMENTLAB_LOCAL_STRIPE_PAYMENT_ENABLE=0
```

Restart the app and open `http://127.0.0.1:3000/local-sandbox`. Start a fresh run. The Buyer chooses a product, a local Merchant A2A endpoint receives the request, and the Merchant issues a server-priced quote. Both decisions use the configured local model by default. The app validates the returned product, quote, and A2A task before showing approval. This path is local to your machine and has no Stripe effect while the payment flag is `0`.

If your LM Studio server requires an API token, add `LM_STUDIO_API_TOKEN` to `.env.local`; leave it absent for the default local setup. If `LOCAL_DEMO_DISABLED` appears, check all required flags and the directory permissions, then restart Next.js. If an A2A run stops, confirm the model is loaded and `/v1/models` lists its exact ID.

[LM Studio local server documentation](https://lmstudio.ai/docs/developer/core/server) · [OpenAI-compatible models endpoint](https://lmstudio.ai/docs/developer/openai-compat/models)
