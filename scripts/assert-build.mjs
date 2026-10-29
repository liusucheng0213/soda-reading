import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
if (!["web", "admin"].includes(target)) {
  throw new Error("Usage: node scripts/assert-build.mjs <web|admin>");
}

const outputDirectory = target === "admin" ? "dist-admin" : "dist";
if (!existsSync(outputDirectory)) {
  throw new Error(`Missing build output: ${outputDirectory}`);
}

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  });
}

const bundle = javascriptFiles(outputDirectory)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const checks = target === "admin"
  ? [
      [bundle.includes("模型路由"), "admin bundle contains the model router"],
      [!bundle.includes("登录并开始阅读"), "admin bundle excludes reader login"],
      [!bundle.includes("再读本句"), "admin bundle excludes reader controls"],
    ]
  : [
      [bundle.includes("登录并开始阅读"), "web bundle contains reader login"],
      [!bundle.includes("local-admin-session"), "production web excludes the development offline session"],
      [!bundle.includes("local-demo"), "production web excludes the development SMS fallback"],
    ];
const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  throw new Error(`Build smoke assertion failed: ${failures.join("; ")}`);
}
console.log(`Build smoke assertion passed: ${target}`);
