// @lobehub/i18n-cli config — dashboard-next stays en-only but dict-ready.
// The dashboard's strings live in src/i18n/en.ts; when locales are wanted,
// list them in `outputLocales` and run (key + endpoint come from env so no
// secret is committed):
//
//   Export OPENAI_API_KEY locally, then run:
//   pnpm --filter @cortexos/dashboard-next exec lobe-i18n
//
// Uses the operator's OpenAI-compatible endpoint for translation.
module.exports = {
  entryLocale: "en",
  entry: "src/i18n/en.ts",
  outputLocales: [], // add e.g. "zh-CN", "ja-JP" to generate dictionaries
  output: "src/i18n",
  modelName: process.env.OPENAI_MODEL,
  // OpenAI-compatible endpoint. Key + base URL come from env at
  // invocation; never hard-coded here.
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_PROXY_URL,
  },
};
