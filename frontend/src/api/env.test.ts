import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_BASE, readApiBase } from "./env";

describe("readApiBase", () => {
  it("returns the value", () => {
    expect(readApiBase({ VITE_API_BASE_URL: "/api" })).toBe("/api");
    expect(readApiBase({ VITE_API_BASE_URL: "http://localhost:8000/api" })).toBe("http://localhost:8000/api");
  });
  it("removes trailing slashes", () => {
    expect(readApiBase({ VITE_API_BASE_URL: "/api/" })).toBe("/api");
    expect(readApiBase({ VITE_API_BASE_URL: "http://x/api///" })).toBe("http://x/api");
  });
  it("fails loudly when it is missing, empty or only spaces", () => {
    for (const value of [undefined, "", "   "]) expect(() => readApiBase({ VITE_API_BASE_URL: value })).toThrow(/VITE_API_BASE_URL is not set/);
  });
  it("the test environment has an address", () => {
    expect(API_BASE).toBe("http://localhost:8000/api");
  });
});

describe("the env files", () => {
  const read = (name: string) => readFileSync(join(import.meta.dirname, "..", "..", name), "utf8");
  it("proxy mode uses a relative address (same origin, no CORS)", () => {
    expect(read(".env.development")).toMatch(/^VITE_API_BASE_URL=\/api$/m);
  });
  it("cors mode uses the full backend address (different origin)", () => {
    expect(read(".env.cors")).toMatch(/^VITE_API_BASE_URL=http:\/\/localhost:8000\/api$/m);
  });
  it("only VITE_ variables are used (anything else never reaches the browser)", () => {
    for (const file of [".env.development", ".env.cors", ".env.example", ".env.test"]) {
      const names = [...read(file).matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toMatch(/^VITE_/);
    }
  });
});

describe("ImportMetaEnv is typed (TypeScript catches a typo)", () => {
  const root = join(import.meta.dirname, "..", "..");
  const tsc = () => {
    try {
      execFileSync("npx", ["tsc", "--noEmit"], { cwd: root, stdio: "pipe" });
      return "";
    } catch (error) {
      return String((error as { stdout?: Buffer }).stdout ?? "");
    }
  };

  it("a misspelled variable name is a compile error, and the right name is not", () => {
    const file = join(root, "src", "typo_probe.ts");
    try {
      writeFileSync(file, "export const ok = import.meta.env.VITE_API_BASE_URL;\n");
      expect(tsc(), "the correct name must compile").toBe("");
      writeFileSync(file, "export const typo = import.meta.env.VITE_API_BASE_URI;\n");
      const output = tsc();
      expect(output).toMatch(/typo_probe\.ts/);
      expect(output).toMatch(/VITE_API_BASE_URI/);
    } finally {
      if (existsSync(file)) unlinkSync(file);
    }
  }, 60000);
});
