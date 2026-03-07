import tseslint from "typescript-eslint";

export default tseslint.config(
	...tseslint.configs.recommended,
	{
		ignores: ["dist/", "node_modules/", "infra/"],
	},
	{
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/no-namespace": "off",
			"@typescript-eslint/no-unsafe-function-type": "off",
			"prefer-const": "off",
		},
	},
);
