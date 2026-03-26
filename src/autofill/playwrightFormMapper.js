function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildManualSourcePath(fieldName) {
  const key = String(fieldName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "manual_field";
  return `__manual__.${key}`;
}

function inferSourcePath(descriptor) {
  const text = normalizeToken(descriptor);
  const sensitivePattern = /(ssn|social security|passport|credit card|cvv|security code|routing number|account number|bank)/;
  if (sensitivePattern.test(text)) return null;

  if (/(upload|attach|attachment|choose file|drop files|transcript|resume|cv)/.test(text)) return null;
  if (/(full name|legal name|applicant name|student name|name)/.test(text)) return "personalInfo.fullName";
  if (/(email|e mail)/.test(text)) return "personalInfo.email";
  if (/(phone|mobile|cell)/.test(text)) return "personalInfo.phone";
  if (/(major|intended major|field of study|program of study)/.test(text)) return "personalInfo.intendedMajor";
  if (/(gpa|grade point)/.test(text)) return "academics.gpa";
  if (/(ethnicity|race|hispanic|latino|latinx|background)/.test(text)) return "personalInfo.ethnicity";
  if (/(date of birth|birth date|dob)/.test(text)) return "personalInfo.dateOfBirth";
  if (/(essay|personal statement|short answer|long answer|response)/.test(text)) return "essays.0.content";
  return null;
}

function toFieldName(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value;
}

function dedupeFields(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${String(row.fieldName || "").toLowerCase()}::${String(row.displayLabel || "").toLowerCase()}`;
    if (!row.fieldName || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function isLikelyEssayPrompt(text) {
  const value = String(text || "").trim();
  if (!value || value.length < 25 || value.length > 500) return false;
  const normalized = normalizeToken(value);
  if (/^personal statement( response)?$/i.test(value)) return false;
  if (/^essay( response)?$/i.test(value)) return false;
  if (/\?/.test(value)) return true;
  return /(essay|personal statement|short answer|minimum \d+ words|impact|mission)/.test(normalized);
}

function deriveEssayPrompt(values) {
  const candidates = Array.isArray(values) ? values : [];
  for (const candidate of candidates) {
    if (isLikelyEssayPrompt(candidate)) {
      return String(candidate).trim();
    }
  }
  return undefined;
}

function mapRawField(raw) {
  const fieldNameRaw = toFieldName(raw.name || raw.id || raw.displayLabel || raw.placeholder || raw.ariaLabel);
  if (!fieldNameRaw) return null;

  const displayLabel = String(raw.displayLabel || raw.placeholder || raw.ariaLabel || raw.name || raw.id || "").trim() || fieldNameRaw;
  const descriptor = [displayLabel, raw.placeholder, raw.ariaLabel, raw.name, raw.id, raw.type].filter(Boolean).join(" ");
  const mappedPath = inferSourcePath(descriptor);
  const promptCandidate = deriveEssayPrompt([
    raw.contextPrompt,
    raw.placeholder,
    raw.ariaLabel,
    displayLabel,
    raw.name
  ]);
  return {
    fieldName: fieldNameRaw,
    displayLabel,
    fieldType: raw.type === "file" ? "file" : (raw.type || "text"),
    acceptedFileTypes: raw.acceptedFileTypes || undefined,
    essayPrompt: mappedPath === "essays.0.content" ? promptCandidate : undefined,
    sourcePath: mappedPath || buildManualSourcePath(fieldNameRaw),
    mappingReason: mappedPath
      ? "Mapped by Playwright multi-step field discovery"
      : "No reliable profile mapping; manual entry required"
  };
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install playwright && npx playwright install chromium");
  }
}

function uniqueFrames(page) {
  const seen = new Set();
  const frames = [];
  for (const frame of page.frames()) {
    const key = frame.url() || `frame-${frames.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frames.push(frame);
  }
  return frames;
}

async function fillVisibleForProgress(frame) {
  await frame.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const candidates = document.querySelectorAll("input, textarea, select");
    for (const node of candidates) {
      if (!visible(node)) continue;
      const tag = node.tagName.toLowerCase();
      const type = String(node.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;
      if (node.disabled || node.readOnly) continue;

      if (tag === "select") {
        const select = node;
        if ((!select.value || /^select/i.test(select.value)) && select.options.length > 1) {
          select.selectedIndex = 1;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        continue;
      }

      if (type === "checkbox" || type === "radio") {
        if (!node.checked) {
          node.click();
        }
        continue;
      }

      if (!node.value) {
        const hint = `${node.name || ""} ${node.id || ""} ${node.placeholder || ""}`.toLowerCase();
        if (hint.includes("email")) node.value = "student@example.com";
        else if (hint.includes("phone")) node.value = "4155551212";
        else if (hint.includes("zip") || hint.includes("postal")) node.value = "94110";
        else if (hint.includes("city")) node.value = "San Francisco";
        else if (hint.includes("state")) node.value = "CA";
        else if (hint.includes("country")) node.value = "United States";
        else if (hint.includes("name")) node.value = "Student";
        else node.value = "N/A";
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  });
}

async function extractVisibleFields(frame) {
  return await frame.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const labelFor = new Map();
    for (const label of document.querySelectorAll("label[for]")) {
      const id = String(label.getAttribute("for") || "").trim();
      const text = String(label.textContent || "").trim();
      if (id && text) labelFor.set(id, text);
    }

    const rows = [];
    const controls = document.querySelectorAll("input, textarea, select");
    for (const node of controls) {
      if (!visible(node)) continue;
      const tag = node.tagName.toLowerCase();
      const type = String(node.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;

      const id = String(node.id || "").trim();
      const name = String(node.getAttribute("name") || "").trim();
      const placeholder = String(node.getAttribute("placeholder") || "").trim();
      const ariaLabel = String(node.getAttribute("aria-label") || "").trim();
      const acceptedFileTypes = String(node.getAttribute("accept") || "").trim();
      const byForLabel = id ? (labelFor.get(id) || "") : "";
      let wrappedLabel = "";
      const parentLabel = node.closest("label");
      if (parentLabel) wrappedLabel = String(parentLabel.textContent || "").trim();
      let contextPrompt = "";
      const contextContainer = node.closest("fieldset, .gfield, .gf_step, .step, .form-group, .elementor-field-group, .wpforms-field, .section, .row, .col");
      if (contextContainer) {
        const contextText = String(contextContainer.textContent || "").replace(/\s+/g, " ").trim();
        const pieces = contextText.split(/(?<=[?.!])\s+/).map((piece) => piece.trim()).filter(Boolean);
        contextPrompt = pieces.find((piece) => piece.length > 25 && piece.length < 500 && /(\?|essay|statement|minimum \d+ words|short answer|impact|mission)/i.test(piece)) || "";
      }
      const displayLabel = byForLabel || wrappedLabel || placeholder || ariaLabel || name || id || "";
      if (!displayLabel) continue;

      rows.push({
        id,
        name,
        type: tag === "input" ? type : tag,
        placeholder,
        ariaLabel,
        acceptedFileTypes,
        contextPrompt,
        displayLabel
      });
    }
    return rows;
  });
}

async function clickNext(frame) {
  return await frame.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], a[role='button'], .gform_next_button"));
    const scored = buttons
      .filter((el) => visible(el))
      .map((el) => {
        const text = String((el.innerText || el.value || "").trim()).toLowerCase();
        let score = 0;
        if (/(next|continue|proceed|save and continue)/.test(text)) score += 5;
        if (/(submit|finish|complete application|apply now)/.test(text)) score -= 8;
        return { el, text, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return false;
    scored[0].el.click();
    return true;
  });
}

async function clickApplyStart(page) {
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const candidates = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit']"))
      .filter((el) => visible(el))
      .map((el) => {
        const text = String((el.innerText || el.value || "").trim()).toLowerCase();
        let score = 0;
        if (/(apply|start application|apply now|begin application|start here)/.test(text)) score += 6;
        if (/(learn more|contact|donate|newsletter)/.test(text)) score -= 4;
        return { el, score, text };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) return false;
    candidates[0].el.click();
    return true;
  });

  if (clicked) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 7000 });
    } catch {
      // some SPAs/forms won't trigger full navigation
    }
    await page.waitForTimeout(1800);
  }
  return clicked;
}

export async function generateFormMappingWithPlaywrightFromUrl(url, {
  maxSteps = 4,
  navigationTimeoutMs = 20000
} = {}) {
  const target = String(url || "").trim();
  if (!target) {
    throw new Error("Scholarship sourceUrl is required for Playwright form mapping.");
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(navigationTimeoutMs);
    await page.goto(target, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await clickApplyStart(page);

    let allFields = [];
    for (let step = 0; step < Math.max(1, maxSteps); step += 1) {
      await page.waitForTimeout(1000);
      const frames = uniqueFrames(page);
      for (const frame of frames) {
        let stepFields = [];
        try {
          stepFields = await extractVisibleFields(frame);
        } catch {
          stepFields = [];
        }
        allFields = allFields.concat(stepFields.map((row) => ({
          ...row,
          step: step + 1,
          frameUrl: frame.url()
        })));
      }

      for (const frame of frames) {
        try {
          await fillVisibleForProgress(frame);
        } catch {
          // ignore per-frame errors
        }
      }

      let clicked = false;
      for (const frame of frames) {
        try {
          const didClick = await clickNext(frame);
          if (didClick) {
            clicked = true;
            break;
          }
        } catch {
          // try next frame
        }
      }
      if (!clicked) break;
      await page.waitForTimeout(1800);
    }

    const mapped = dedupeFields(
      allFields
        .map(mapRawField)
        .filter(Boolean)
        .slice(0, 120)
    );

    if (mapped.length === 0) {
      const frameUrls = uniqueFrames(page).map((f) => f.url()).filter(Boolean);
      throw new Error(`No visible fields were detected with Playwright. Frame URLs inspected: ${frameUrls.join(", ") || "none"}`);
    }

    return {
      sourceUrl: page.url(),
      discoveredCount: mapped.length,
      formFields: mapped.slice(0, 80)
    };
  } finally {
    await browser.close();
  }
}
