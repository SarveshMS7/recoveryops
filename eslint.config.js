import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.eslint.json" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Architectural rule: domain/ must never import an I/O client, SDK, or
    // framework. If this fires, the task violated the hexagonal boundary —
    // fix the code, don't suppress the rule.
    files: ["domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "pg", "pg-promise", "postgres",
            "razorpay", "axios", "node-fetch", "undici",
            "express", "fastify",
            "openai", "@anthropic-ai/*",
            "kafkajs", "amqplib", "ioredis", "redis",
          ],
        },
      ],
    },
  },
];
