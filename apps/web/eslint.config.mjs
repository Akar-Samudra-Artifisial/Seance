import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const hexColour = "/#[0-9a-fA-F]{3,8}\\b/";

const config = [
  { ignores: [".next/**", ".next-e2e/**", "node_modules/**", "next-env.d.ts", "e2e/**/*.js"] },
  ...nextCoreWebVitals,
  {
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "react/no-danger": "error",
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "innerHTML is forbidden; render text through React." },
        { property: "outerHTML", message: "outerHTML is forbidden; render text through React." },
        { property: "insertAdjacentHTML", message: "insertAdjacentHTML is forbidden." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "dangerouslySetInnerHTML is forbidden.",
        },
        {
          selector: "JSXAttribute[name.name='style']",
          message: "The style prop is forbidden; use Tailwind classes and theme tokens.",
        },
      ],
    },
  },
  {
    // Hex colours live only in app/globals.css; components use theme tokens.
    files: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "dangerouslySetInnerHTML is forbidden.",
        },
        {
          selector: "JSXAttribute[name.name='style']",
          message: "The style prop is forbidden; use Tailwind classes and theme tokens.",
        },
        {
          selector: `Literal[value=${hexColour}]`,
          message: "Hex colours are forbidden in components; use theme tokens.",
        },
        {
          selector: `TemplateElement[value.raw=${hexColour}]`,
          message: "Hex colours are forbidden in components; use theme tokens.",
        },
      ],
    },
  },
  {
    // Exceptions (web-client-pixel-match): generated icon components keep the Figma colours verbatim
    // (R3.1, checked by the P1 icon test), and the IRC palette module mirrors the --color-irc-* values
    // to compute contrast (R10, checked against globals.css by the P2 test). The style and
    // dangerouslySetInnerHTML bans still apply here.
    files: ["src/icons/**/*.{ts,tsx}", "src/irc/colors.ts"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "dangerouslySetInnerHTML is forbidden.",
        },
        {
          selector: "JSXAttribute[name.name='style']",
          message: "The style prop is forbidden; use Tailwind classes and theme tokens.",
        },
      ],
    },
  },
];

export default config;
