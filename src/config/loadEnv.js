import fs from "node:fs";
import path from "node:path";

let alreadyLoaded = false;

function parseEnvLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const eqIdx = trimmed.indexOf("=");
  if (eqIdx <= 0) {
    return null;
  }

  const key = trimmed.slice(0, eqIdx).trim();
  if (!key) {
    return null;
  }

  let value = trimmed.slice(eqIdx + 1).trim();
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

export function loadLocalEnv() {
  if (alreadyLoaded) {
    return;
  }
  alreadyLoaded = true;

  const cwd = process.cwd();
  const envLocalPath = path.resolve(cwd, ".env.local");
  const envPath = path.resolve(cwd, ".env");

  loadEnvFile(envLocalPath);
  loadEnvFile(envPath);
}
