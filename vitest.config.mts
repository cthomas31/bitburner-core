import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const tsconfigTest = require("./tsconfig.test.json");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const r = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["test/**/*.test.ts"],
        coverage: { provider: "v8" },
    },

    // Make esbuild use the test tsconfig (so aliases/types match VSCode)
    esbuild: {
        tsconfigRaw: {
            compilerOptions: {
                ...tsconfigTest.compilerOptions,
                lib: ["ES2022"],
                types: ["node", "vitest/globals"],
            },
        },
    },

    // Vite/Vitest aliasing for runtime resolution inside tests
    resolve: {
        alias: [
            { find: /^\/lib\//, replacement: r("src/lib/") + "/" },
            { find: /^\/domain\//, replacement: r("src/domain/") + "/" },
            { find: /^\/app\//, replacement: r("src/app/") + "/" },
            { find: /^\/bin\//, replacement: r("src/bin/") + "/" },

            // Optional extras if these folders exist:
            { find: /^\/scripts\//, replacement: r("src/scripts/") + "/" },
            { find: /^\/workers\//, replacement: r("src/workers/") + "/" },
        ],
    },
});
