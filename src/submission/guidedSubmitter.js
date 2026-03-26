import { randomUUID } from "node:crypto";

const sessions = new Map();

function allFrames(page) {
  return page.frames();
}

async function installInPageControls(session) {
  const { page } = session;
  try {
    await page.evaluate(() => {
      const existing = document.getElementById("__sb_guided_overlay");
      if (existing) {
        return;
      }

      const wrap = document.createElement("div");
      wrap.id = "__sb_guided_overlay";
      wrap.style.position = "fixed";
      wrap.style.right = "16px";
      wrap.style.bottom = "16px";
      wrap.style.zIndex = "2147483647";
      wrap.style.background = "rgba(10, 24, 39, 0.95)";
      wrap.style.color = "#fff";
      wrap.style.padding = "10px";
      wrap.style.borderRadius = "10px";
      wrap.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
      wrap.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      wrap.style.width = "230px";

      const title = document.createElement("div");
      title.textContent = "Guided Controls";
      title.style.fontWeight = "700";
      title.style.fontSize = "13px";
      title.style.marginBottom = "8px";
      wrap.appendChild(title);

      const status = document.createElement("div");
      status.id = "__sb_guided_status";
      status.textContent = "Ready";
      status.style.fontSize = "12px";
      status.style.opacity = "0.9";
      status.style.marginBottom = "8px";
      wrap.appendChild(status);

      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "8px";

      const refillBtn = document.createElement("button");
      refillBtn.type = "button";
      refillBtn.textContent = "Refill";
      refillBtn.style.flex = "1";
      refillBtn.style.border = "none";
      refillBtn.style.padding = "8px 10px";
      refillBtn.style.borderRadius = "8px";
      refillBtn.style.cursor = "pointer";
      refillBtn.style.fontWeight = "600";
      refillBtn.style.background = "#dfe7ef";
      refillBtn.style.color = "#1f2a37";

      const nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.textContent = "Next";
      nextBtn.style.flex = "1";
      nextBtn.style.border = "none";
      nextBtn.style.padding = "8px 10px";
      nextBtn.style.borderRadius = "8px";
      nextBtn.style.cursor = "pointer";
      nextBtn.style.fontWeight = "700";
      nextBtn.style.background = "#1f9d7a";
      nextBtn.style.color = "#ffffff";

      const setStatus = (text) => {
        const el = document.getElementById("__sb_guided_status");
        if (el) el.textContent = text;
      };

      refillBtn.addEventListener("click", async () => {
        try {
          setStatus("Refilling...");
          if (typeof window.__sbRefill === "function") {
            await window.__sbRefill();
            setStatus("Refilled");
          } else {
            setStatus("Refill unavailable");
          }
        } catch (error) {
          setStatus(`Refill failed: ${String(error?.message || error)}`);
        }
      });

      nextBtn.addEventListener("click", async () => {
        try {
          setStatus("Advancing...");
          if (typeof window.__sbNext === "function") {
            await window.__sbNext();
            setStatus("Advanced");
          } else {
            setStatus("Next unavailable");
          }
        } catch (error) {
          setStatus(`Next failed: ${String(error?.message || error)}`);
        }
      });

      row.appendChild(refillBtn);
      row.appendChild(nextBtn);
      wrap.appendChild(row);

      const hint = document.createElement("div");
      hint.textContent = "Use these controls to avoid switching tabs.";
      hint.style.fontSize = "11px";
      hint.style.opacity = "0.75";
      hint.style.marginTop = "8px";
      wrap.appendChild(hint);

      document.body.appendChild(wrap);
    });
  } catch {
    // best effort only
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install playwright && npx playwright install chromium");
  }
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
        return { el, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) return false;
    candidates[0].el.click();
    return true;
  });

  if (clicked) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 7000 });
    } catch {
      // some pages won't navigate
    }
    await page.waitForTimeout(1400);
  }
}

async function detectAccountWall(page) {
  const frameSignals = [];
  for (const frame of allFrames(page)) {
    try {
      const signal = await frame.evaluate(() => {
        const text = String(document.body?.innerText || "").toLowerCase();
        const hasPasswordInput = Boolean(document.querySelector("input[type='password']"));
        const hasEmailInput = Boolean(document.querySelector("input[type='email']"));
        const hasAuthForm = Boolean(document.querySelector("form[action*='login'], form[action*='signin'], form[action*='register'], form[action*='signup']"));
        const hasCaptcha = Boolean(
          document.querySelector("iframe[src*='captcha'], .g-recaptcha, [id*='captcha'], [class*='captcha']")
        );

        const authTextHits = [
          /sign in/,
          /log in/,
          /login/,
          /create account/,
          /sign up/,
          /register/,
          /verify your email/,
          /verification code/,
          /two[- ]factor/,
          /2fa/,
          /forgot password/
        ].filter((rx) => rx.test(text)).length;

        const accountButtons = Array.from(document.querySelectorAll("button, a, input[type='submit'], input[type='button']"))
          .map((el) => String((el.innerText || el.value || "").trim()).toLowerCase())
          .filter(Boolean)
          .filter((t) => /(sign in|log in|login|create account|sign up|register|continue with google|continue with microsoft|continue with apple)/.test(t))
          .slice(0, 6);

        const score = Number(hasPasswordInput) * 3
          + Number(hasAuthForm) * 3
          + Number(hasEmailInput && hasPasswordInput) * 2
          + Number(hasCaptcha) * 2
          + authTextHits;

        return {
          score,
          hasPasswordInput,
          hasEmailInput,
          hasAuthForm,
          hasCaptcha,
          authTextHits,
          accountButtons,
          sample: text.slice(0, 800)
        };
      });
      frameSignals.push({ frameUrl: frame.url(), ...signal });
    } catch {
      // ignore single-frame failures
    }
  }

  const best = frameSignals.sort((a, b) => b.score - a.score)[0] || null;
  const accountRequired = Boolean(best && best.score >= 3);
  const reasons = [];
  if (best?.hasPasswordInput) reasons.push("password field detected");
  if (best?.hasAuthForm) reasons.push("auth form detected");
  if (best?.hasCaptcha) reasons.push("captcha detected");
  if ((best?.authTextHits || 0) > 0) reasons.push("login/signup language detected");
  if ((best?.accountButtons || []).length > 0) reasons.push("account action button detected");

  return {
    accountRequired,
    reason: accountRequired ? (reasons.join("; ") || "account/login signals detected") : "",
    evidence: best || null,
    signals: frameSignals
  };
}

async function fillVisibleFieldsInFrame(frame, payload) {
  return await frame.evaluate((rawPayload) => {
    const payload = rawPayload || {};

    const normalizeText = (value) => String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const labelMap = new Map();
    for (const label of document.querySelectorAll("label[for]")) {
      const id = String(label.getAttribute("for") || "").trim();
      const text = String(label.textContent || "").trim();
      if (id && text) labelMap.set(id.toLowerCase(), text);
    }

    const exact = new Map();
    const normalized = new Map();
    for (const [key, value] of Object.entries(payload)) {
      if (value === null || value === undefined || value === "") continue;
      const keyText = String(key);
      exact.set(keyText, value);
      normalized.set(normalizeText(keyText), value);
    }

    const values = Array.from(exact.values()).map((v) => String(v || "").trim()).filter(Boolean);
    const fullNameValue = values.find((v) => /\s+/.test(v) && !v.includes("@")) || "";
    const nameParts = fullNameValue ? fullNameValue.split(/\s+/).filter(Boolean) : [];
    const firstNameFallback = nameParts[0] || "";
    const lastNameFallback = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";
    const emailFallback = values.find((v) => /@/.test(v)) || "";
    const phoneFallback = values.find((v) => /\d{7,}/.test(v.replace(/\D/g, ""))) || "";
    const dobFallback = values.find((v) => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(v) || /[A-Za-z]+\s+\d{1,2},\s*\d{4}/.test(v)) || "";

    const fallbackValueForKeys = (keys) => {
      const joined = normalizeText(keys.join(" "));
      if (/(first name|given name)/.test(joined)) return firstNameFallback || "";
      if (/(last name|surname|family name)/.test(joined)) return lastNameFallback || "";
      if (/(full name|applicant name|student name)/.test(joined)) return fullNameValue || "";
      if (/(email|e mail)/.test(joined)) return emailFallback || "";
      if (/(phone|mobile|cell)/.test(joined)) return phoneFallback || "";
      if (/(date of birth|birth date|dob|mm dd yyyy)/.test(joined)) return dobFallback || "";
      if (/(street address|address line 1|mailing address)/.test(joined)) {
        return String(
          normalized.get("personalinfo addressline1")
          || normalized.get("personal info address line 1")
          || normalized.get("address line 1")
          || normalized.get("street address line 1")
          || ""
        );
      }
      if (/(address line 2|apt|suite|unit|apartment)/.test(joined)) {
        return String(
          normalized.get("personalinfo addressline2")
          || normalized.get("personal info address line 2")
          || normalized.get("address line 2")
          || ""
        );
      }
      if (/\bcity\b/.test(joined)) return String(normalized.get("personalinfo city") || normalized.get("city") || "");
      if (/(state|province|region)/.test(joined)) return String(normalized.get("personalinfo state") || normalized.get("state") || "");
      if (/(zip|postal)/.test(joined)) return String(normalized.get("personalinfo postalcode") || normalized.get("postal code") || normalized.get("postal_code") || "");
      if (/\bcountry\b/.test(joined)) return String(normalized.get("personalinfo country") || normalized.get("country") || "");
      return "";
    };

    const parseDateParts = (value) => {
      const text = String(value || "").trim();
      if (!text) return null;

      const mdY = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (mdY) {
        const m = Number(mdY[1]);
        const d = Number(mdY[2]);
        const y = Number(mdY[3].length === 2 ? `20${mdY[3]}` : mdY[3]);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
          return { m, d, y };
        }
      }

      const full = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
      if (full) {
        const months = {
          january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
          july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
        };
        const m = months[String(full[1] || "").toLowerCase()];
        const d = Number(full[2]);
        const y = Number(full[3]);
        if (m && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
          return { m, d, y };
        }
      }

      return null;
    };

    const formatDate = (parts, fmt) => {
      if (!parts) return "";
      const mm = String(parts.m).padStart(2, "0");
      const dd = String(parts.d).padStart(2, "0");
      const yyyy = String(parts.y);
      if (fmt === "iso") return `${yyyy}-${mm}-${dd}`;
      return `${mm}/${dd}/${yyyy}`;
    };

    const maybeNormalizeDateValue = (node, keys, rawValue) => {
      const value = String(rawValue || "").trim();
      if (!value) return value;
      const type = String(node.getAttribute("type") || "").toLowerCase();
      const placeholder = String(node.getAttribute("placeholder") || "").toLowerCase();
      const joined = normalizeText(keys.join(" "));
      const looksDateField = type === "date" || /(date of birth|birth date|dob|mm dd yyyy|mm\/dd\/yyyy)/.test(joined) || /mm\/dd\/yyyy|date/.test(placeholder);
      if (!looksDateField) return value;

      const parts = parseDateParts(value);
      if (!parts) return value;
      return type === "date" ? formatDate(parts, "iso") : formatDate(parts, "us");
    };

    const chooseSelectOption = (select, rawValue) => {
      const value = String(rawValue || "").trim();
      if (!value) return false;
      const target = normalizeText(value);
      const short = value.trim().toUpperCase();
      const stateAliases = {
        CA: "california",
        NY: "new york",
        TX: "texas",
        FL: "florida",
        WA: "washington"
      };
      const expanded = stateAliases[short] || "";
      const targetCandidates = [target, normalizeText(expanded)].filter(Boolean);

      for (let i = 0; i < select.options.length; i += 1) {
        const option = select.options[i];
        const optionValue = normalizeText(option.value);
        const optionText = normalizeText(option.textContent || "");
        if (targetCandidates.includes(optionValue) || targetCandidates.includes(optionText)) {
          select.selectedIndex = i;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }

      for (let i = 0; i < select.options.length; i += 1) {
        const option = select.options[i];
        const optionValue = normalizeText(option.value);
        const optionText = normalizeText(option.textContent || "");
        if (targetCandidates.some((t) => t && (optionText.includes(t) || optionValue.includes(t) || t.includes(optionText) || t.includes(optionValue)))) {
          select.selectedIndex = i;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    };

    const controls = Array.from(document.querySelectorAll("input, textarea, select"));
    let filledCount = 0;
    for (const node of controls) {
      if (!visible(node)) continue;
      if (node.disabled || node.readOnly) continue;

      const tag = node.tagName.toLowerCase();
      const type = String(node.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
      if (tag === "input" && type === "file") continue;

      const id = String(node.id || "").trim();
      const name = String(node.getAttribute("name") || "").trim();
      const placeholder = String(node.getAttribute("placeholder") || "").trim();
      const aria = String(node.getAttribute("aria-label") || "").trim();
      const labelFor = id ? (labelMap.get(id.toLowerCase()) || "") : "";
      const wrapped = node.closest("label") ? String(node.closest("label").textContent || "").trim() : "";

      const keys = [name, id, labelFor, wrapped, placeholder, aria].filter(Boolean);
      let candidate = null;
      for (const key of keys) {
        if (exact.has(key)) {
          candidate = exact.get(key);
          break;
        }
      }
      if (candidate === null || candidate === undefined) {
        for (const key of keys.map((k) => normalizeText(k))) {
          if (normalized.has(key)) {
            candidate = normalized.get(key);
            break;
          }
        }
      }
      if (candidate === null || candidate === undefined || String(candidate).trim() === "") {
        const fallback = fallbackValueForKeys(keys);
        if (fallback) {
          candidate = fallback;
        }
      }
      if (candidate === null || candidate === undefined) continue;

      const value = maybeNormalizeDateValue(node, keys, candidate);
      if (!value.trim()) continue;

      if (tag === "select") {
        const select = node;
        const chosen = chooseSelectOption(select, value);
        if (chosen) filledCount += 1;
        continue;
      }

      if (type === "checkbox") {
        const yes = /^(true|yes|1|on)$/i.test(value.trim());
        node.checked = yes;
        node.dispatchEvent(new Event("change", { bubbles: true }));
        filledCount += 1;
        continue;
      }

      if (type === "radio") {
        const radioValue = String(node.value || "");
        if (normalizeText(radioValue) === normalizeText(value)) {
          node.checked = true;
          node.dispatchEvent(new Event("change", { bubbles: true }));
          filledCount += 1;
        }
        continue;
      }

      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      filledCount += 1;
    }

    if (filledCount > 0) {
      const textareaControls = Array.from(document.querySelectorAll("textarea"))
        .filter((node) => visible(node) && !node.disabled && !node.readOnly);
      const essayCandidate = values.find((v) => v.length > 120 && !/@/.test(v));
      for (const ta of textareaControls) {
        if (ta.value && ta.value.trim()) continue;
        const hint = normalizeText(`${ta.placeholder || ""} ${ta.getAttribute("aria-label") || ""} ${ta.name || ""} ${ta.id || ""}`);
        if (essayCandidate && /(essay|statement|short answer|long answer|minimum|impact|mission)/.test(hint)) {
          ta.value = essayCandidate;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
          filledCount += 1;
        }
      }
    }

    return { filledCount };
  }, payload);
}

async function fillVisibleFields(page, payload) {
  const frames = allFrames(page);
  let filledCount = 0;
  for (const frame of frames) {
    try {
      const result = await fillVisibleFieldsInFrame(frame, payload);
      filledCount += Number(result?.filledCount || 0);
    } catch {
      // best effort per-frame
    }
  }
  return { filledCount };
}

async function extractVisibleFieldsInFrame(frame) {
  return await frame.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const labelMap = new Map();
    for (const label of document.querySelectorAll("label[for]")) {
      const id = String(label.getAttribute("for") || "").trim();
      const text = String(label.textContent || "").trim();
      if (id && text) labelMap.set(id.toLowerCase(), text);
    }

    const fields = [];
    const controls = document.querySelectorAll("input, textarea, select");
    for (const node of controls) {
      if (!visible(node)) continue;

      const tag = node.tagName.toLowerCase();
      const type = String(node.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;

      const id = String(node.id || "").trim();
      const name = String(node.getAttribute("name") || "").trim();
      const placeholder = String(node.getAttribute("placeholder") || "").trim();
      const aria = String(node.getAttribute("aria-label") || "").trim();
      const required = node.required || String(node.getAttribute("aria-required") || "").toLowerCase() === "true";
      const byFor = id ? (labelMap.get(id.toLowerCase()) || "") : "";
      const wrapped = node.closest("label") ? String(node.closest("label").textContent || "").trim() : "";
      const label = byFor || wrapped || placeholder || aria || name || id || "(unlabeled)";
      const value = tag === "select"
        ? String(node.options?.[node.selectedIndex]?.textContent || "")
        : String(node.value || "");

      fields.push({
        label,
        id,
        name,
        type: tag === "input" ? type : tag,
        required: Boolean(required),
        valuePreview: value.length > 80 ? `${value.slice(0, 80)}...` : value
      });
    }
    return fields.slice(0, 120);
  });
}

async function extractVisibleFields(page) {
  const frames = allFrames(page);
  const merged = [];
  for (const frame of frames) {
    try {
      const rows = await extractVisibleFieldsInFrame(frame);
      const frameUrl = frame.url();
      for (const row of rows) {
        merged.push({ ...row, frameUrl });
      }
    } catch {
      // ignore frame extraction errors
    }
  }
  return merged.slice(0, 200);
}

async function clickNext(page) {
  const frames = allFrames(page);
  for (const frame of frames) {
    let clicked = false;
    try {
      clicked = await frame.evaluate(() => {
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
            if (/(submit|finish|complete application|final submit)/.test(text)) score -= 10;
            return { el, score };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);

        if (!scored.length) return false;
        scored[0].el.click();
        return true;
      });
    } catch {
      clicked = false;
    }
    if (clicked) {
      return true;
    }
  }

  return false;
}

async function refillCurrentStep(session) {
  const fillResult = await fillVisibleFields(session.page, session.payload);
  const fields = await extractVisibleFields(session.page);
  return summarizeSessionState(session, fields, fillResult);
}

function summarizeSessionState(session, fields, fillResult = null, extras = {}) {
  const fileRequired = fields.filter((f) => f.type === "file" && f.required).length;
  const accountRequired = extras.accountRequired === true;
  const accountReason = extras.accountReason || "";
  return {
    sessionId: session.id,
    stepNumber: session.stepNumber,
    currentUrl: session.page.url(),
    fields,
    accountRequired,
    accountReason,
    accountEvidence: extras.accountEvidence || null,
    filledCount: fillResult?.filledCount ?? 0,
    reviewMessage: accountRequired
      ? `Account setup required before autofill can continue (${accountReason || "login/signup page detected"}). Complete account creation/login in browser, then click Resume After Account Setup.`
      : (fileRequired > 0
        ? `Review this page and upload ${fileRequired} required file(s) manually before continuing. You can use in-page Guided Controls (Refill/Next).`
        : "Review this page, make any edits in browser, then click Approve This Page & Next. You can also use in-page Guided Controls."),
    canAdvance: accountRequired ? false : true
  };
}

export async function startGuidedSubmission({ sourceUrl, payload }) {
  const url = String(sourceUrl || "").trim();
  if (!url) {
    throw new Error("sourceUrl is required");
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const session = {
    id: randomUUID(),
    browser,
    context,
    page,
    stepNumber: 1,
    payload: payload || {}
  };

  await context.exposeBinding("__sbRefill", async () => {
    await refillCurrentStep(session);
    await installInPageControls(session);
    return { ok: true };
  });
  await context.exposeBinding("__sbNext", async () => {
    const moved = await clickNext(session.page);
    if (!moved) {
      return { ok: false, reason: "No next button found" };
    }
    await session.page.waitForTimeout(1400);
    session.stepNumber += 1;
    await refillCurrentStep(session);
    await installInPageControls(session);
    return { ok: true };
  });

  page.setDefaultTimeout(25000);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await clickApplyStart(page);

  const fillResult = await fillVisibleFields(page, payload || {});
  const fields = await extractVisibleFields(page);
  const accountState = await detectAccountWall(page);

  page.on("framenavigated", async (frame) => {
    if (frame === page.mainFrame()) {
      await installInPageControls(session);
    }
  });

  await installInPageControls(session);
  sessions.set(session.id, session);

  return summarizeSessionState(session, fields, fillResult, {
    accountRequired: accountState.accountRequired,
    accountReason: accountState.reason,
    accountEvidence: accountState.evidence
  });
}

export async function advanceGuidedSubmission({ sessionId }) {
  const id = String(sessionId || "").trim();
  const session = sessions.get(id);
  if (!session) {
    throw new Error("Submission session not found");
  }

  const beforeMoveAccountState = await detectAccountWall(session.page);
  if (beforeMoveAccountState.accountRequired) {
    const refreshed = await refillCurrentStep(session);
    return {
      ...refreshed,
      accountRequired: true,
      accountReason: beforeMoveAccountState.reason,
      accountEvidence: beforeMoveAccountState.evidence,
      canAdvance: false,
      reviewMessage: `Account setup required before continuing (${beforeMoveAccountState.reason || "login/signup page detected"}). Complete it in browser, then click Resume After Account Setup.`
    };
  }

  const moved = await clickNext(session.page);
  if (!moved) {
    const refreshed = await refillCurrentStep(session);
    return {
      ...refreshed,
      canAdvance: false,
      reviewMessage: "No Next button found. You are likely on the final page; please review and submit manually."
    };
  }

  await session.page.waitForTimeout(1600);
  session.stepNumber += 1;
  const fillResult = await fillVisibleFields(session.page, session.payload);
  const fields = await extractVisibleFields(session.page);
  const accountState = await detectAccountWall(session.page);
  await installInPageControls(session);
  return summarizeSessionState(session, fields, fillResult, {
    accountRequired: accountState.accountRequired,
    accountReason: accountState.reason,
    accountEvidence: accountState.evidence
  });
}

export async function refillGuidedSubmission({ sessionId }) {
  const id = String(sessionId || "").trim();
  const session = sessions.get(id);
  if (!session) {
    throw new Error("Submission session not found");
  }
  const result = await refillCurrentStep(session);
  const accountState = await detectAccountWall(session.page);
  await installInPageControls(session);
  return {
    ...result,
    accountRequired: accountState.accountRequired,
    accountReason: accountState.reason,
    accountEvidence: accountState.evidence,
    canAdvance: accountState.accountRequired ? false : result.canAdvance,
    reviewMessage: accountState.accountRequired
      ? `Account setup required before continuing (${accountState.reason || "login/signup page detected"}). Complete it in browser, then click Resume After Account Setup.`
      : result.reviewMessage
  };
}

export async function resumeGuidedSubmissionAfterAccount({ sessionId }) {
  const id = String(sessionId || "").trim();
  const session = sessions.get(id);
  if (!session) {
    throw new Error("Submission session not found");
  }

  await clickApplyStart(session.page);
  await session.page.waitForTimeout(900);
  const fillResult = await fillVisibleFields(session.page, session.payload);
  const fields = await extractVisibleFields(session.page);
  const accountState = await detectAccountWall(session.page);
  await installInPageControls(session);
  return summarizeSessionState(session, fields, fillResult, {
    accountRequired: accountState.accountRequired,
    accountReason: accountState.reason,
    accountEvidence: accountState.evidence
  });
}

export async function stopGuidedSubmission({ sessionId }) {
  const id = String(sessionId || "").trim();
  const session = sessions.get(id);
  if (!session) {
    return { closed: false, reason: "Session not found" };
  }

  sessions.delete(id);
  try {
    await session.browser.close();
  } catch {
    // ignore
  }
  return { closed: true };
}

export function hasGuidedSubmissionSession(sessionId) {
  return sessions.has(String(sessionId || "").trim());
}

export async function upsertGuidedSubmissionPayload({ sessionId, updates = {}, refill = false }) {
  const id = String(sessionId || "").trim();
  const session = sessions.get(id);
  if (!session) {
    throw new Error("Submission session not found");
  }

  for (const [key, value] of Object.entries(updates || {})) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) continue;
    if (value === undefined || value === null) continue;
    session.payload[normalizedKey] = String(value);
  }

  if (refill) {
    const result = await refillCurrentStep(session);
    const accountState = await detectAccountWall(session.page);
    await installInPageControls(session);
    return {
      ...result,
      accountRequired: accountState.accountRequired,
      accountReason: accountState.reason,
      accountEvidence: accountState.evidence,
      canAdvance: accountState.accountRequired ? false : result.canAdvance,
      reviewMessage: accountState.accountRequired
        ? `Account setup required before continuing (${accountState.reason || "login/signup page detected"}). Complete it in browser, then click Resume After Account Setup.`
        : result.reviewMessage
    };
  }

  const fields = await extractVisibleFields(session.page);
  return summarizeSessionState(session, fields, null);
}
