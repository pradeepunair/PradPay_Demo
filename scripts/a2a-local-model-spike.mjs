process.env.PAYMENTLAB_MODEL_PROVIDER = "lmstudio";
process.env.PAYMENTLAB_MODEL_EVAL_ENABLE = "1";
await import("./a2a-two-model-spike.mjs");
