import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["test/**/*.test.ts"],
        coverage: {
            provider: "v8",
        },
    },
    resolve: {
        alias: [
            { find: /^\/lib\//, replacement: path.resolve(__dirname, "src/lib/") + "/" },
            { find: /^\/domain\//, replacement: path.resolve(__dirname, "src/domain/") + "/" },
            { find: /^\/app\//, replacement: path.resolve(__dirname, "src/app/") + "/" },
            { find: /^\/bin\//, replacement: path.resolve(__dirname, "src/bin/") + "/" },
            { find: /^\/scripts\//, replacement: path.resolve(__dirname, "src/scripts/") + "/" },
            { find: /^\/workers\//, replacement: path.resolve(__dirname, "src/workers/") + "/" },
        ],
    },
});
