import { randomUUID } from "node:crypto";
import { planGuidedFieldMappingsWithAi } from "./guidedAiAssist.js";

const sessions = new Map();
const GUIDED_OVERLAY_VERSION = "guided-v2-ai-fallback";

function allFrames(page) {
  return page.frames();
}

function truncateOverlayText(value, limit = 36) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatOverlayDebug(fillDiagnostics) {
  const entries = Array.isArray(fillDiagnostics?.debugEntries) ? fillDiagnostics.debugEntries : [];
  const filledCount = Number(fillDiagnostics?.filledCount || 0);
  if (!entries.length) {
    return "No refill attempts yet.";
  }

  const lines = entries.slice(-5).map((entry) => {
    const label = truncateOverlayText(entry.fieldLabel || entry.placeholder || entry.keys?.[0] || "(field)", 24);
    const method = String(entry.method || "fill").trim();
    const flags = [];
    if (entry.success === false) flags.push("failed");
    if (entry.method === "type+combo" && entry.comboSelected === false) flags.push("no-pick");
    if (entry.reason) flags.push(String(entry.reason));
    const finalValue = truncateOverlayText(entry.finalValue || "", 20);
    const suffix = finalValue ? ` => ${finalValue}` : "";
    const flagText = flags.length ? ` (${flags.join(", ")})` : "";
    return `${label} | ${method}${flagText}${suffix}`;
  });

  return [`Filled ${filledCount} field(s)`, ...lines].join("\n");
}

function shouldUseAiFieldMapper(fillResult) {
  const filledCount = Number(fillResult?.filledCount || 0);
  const debugEntries = Array.isArray(fillResult?.debugEntries) ? fillResult.debugEntries : [];
  if (filledCount === 0) return true;
  return debugEntries.some((entry) => entry?.success === false && /no-candidate|no-pick/.test(String(entry?.reason || "")));
}

async function installInPageControls(session) {
  const { page } = session;
  try {
    await page.evaluate(({ statusText, debugText, overlayVersion }) => {
      const setStatus = (text) => {
        const el = document.getElementById("__sb_guided_status");
        if (el) el.textContent = text;
      };

      const setDebug = (text) => {
        const el = document.getElementById("__sb_guided_debug");
        if (el) el.textContent = text;
      };

      const setVersion = (text) => {
        const el = document.getElementById("__sb_guided_version");
        if (el) el.textContent = text;
      };

      const existing = document.getElementById("__sb_guided_overlay");
      if (existing) {
        setStatus(statusText);
        setDebug(debugText);
        setVersion(overlayVersion);
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
      wrap.style.width = "280px";

      const title = document.createElement("div");
      title.textContent = "Guided Controls";
      title.style.fontWeight = "700";
      title.style.fontSize = "13px";
      title.style.marginBottom = "2px";
      wrap.appendChild(title);

      const version = document.createElement("div");
      version.id = "__sb_guided_version";
      version.textContent = overlayVersion;
      version.style.fontSize = "10px";
      version.style.opacity = "0.7";
      version.style.marginBottom = "8px";
      wrap.appendChild(version);

      const status = document.createElement("div");
      status.id = "__sb_guided_status";
      status.textContent = statusText;
      status.style.fontSize = "12px";
      status.style.opacity = "0.9";
      status.style.marginBottom = "8px";
      wrap.appendChild(status);

      const debugLabel = document.createElement("div");
      debugLabel.textContent = "Refill Debug";
      debugLabel.style.fontSize = "11px";
      debugLabel.style.fontWeight = "700";
      debugLabel.style.letterSpacing = "0.04em";
      debugLabel.style.textTransform = "uppercase";
      debugLabel.style.opacity = "0.75";
      debugLabel.style.marginBottom = "6px";
      wrap.appendChild(debugLabel);

      const debugBox = document.createElement("pre");
      debugBox.id = "__sb_guided_debug";
      debugBox.textContent = debugText;
      debugBox.style.margin = "0 0 10px";
      debugBox.style.padding = "8px";
      debugBox.style.background = "rgba(255,255,255,0.08)";
      debugBox.style.borderRadius = "8px";
      debugBox.style.fontSize = "10px";
      debugBox.style.lineHeight = "1.4";
      debugBox.style.whiteSpace = "pre-wrap";
      debugBox.style.wordBreak = "break-word";
      debugBox.style.maxHeight = "132px";
      debugBox.style.overflowY = "auto";
      wrap.appendChild(debugBox);

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

      refillBtn.addEventListener("click", async () => {
        try {
          setStatus("Refilling...");
          if (typeof window.__sbRefill === "function") {
            const result = await window.__sbRefill();
            setStatus(result?.statusText || "Refilled");
            setDebug(result?.debugText || "No refill attempts yet.");
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
            const result = await window.__sbNext();
            setStatus(result?.statusText || "Advanced");
            setDebug(result?.debugText || "No refill attempts yet.");
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
    }, {
      statusText: String(session.overlayStatus || "Ready"),
      debugText: formatOverlayDebug(session.lastFillDiagnostics),
      overlayVersion: GUIDED_OVERLAY_VERSION
    });
  } catch (error) {
    session.overlayInstallError = error?.message || String(error);
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install playwright && npx playwright install chromium");
  }
}

function attachGuidedPageListeners(session, page) {
  page.setDefaultTimeout(25000);
  page.on("framenavigated", async (frame) => {
    if (frame === page.mainFrame() && session.page === page) {
      await installInPageControls(session);
    }
  });
}

async function clickApplyStart(page, context = null) {
  const popupPromise = context
    ? context.waitForEvent("page", { timeout: 4000 }).catch(() => null)
    : Promise.resolve(null);
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

  const popupPage = await popupPromise;
  if (popupPage) {
    try {
      await popupPage.waitForLoadState("domcontentloaded", { timeout: 7000 });
    } catch {
      // popup may already be interactive enough
    }
    await popupPage.waitForTimeout(1400);
    return popupPage;
  }

  return page;
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
  return await frame.evaluate(async (rawPayload) => {
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
	      if (/(gpa|grade point average)/.test(joined)) {
	        return String(
	          normalized.get("academics gpa")
	          || normalized.get("gpa")
	          || ""
	        );
	      }
	      if (/(grade level|current grade|what grade|year in school)/.test(joined)) {
	        return String(
	          normalized.get("academics gradelevel")
	          || normalized.get("grade level")
	          || normalized.get("grade_level")
	          || ""
	        );
	      }
	      if (/(intended major|major of interest|field of study|major)/.test(joined)) {
	        return String(
	          normalized.get("personalinfo intendedmajor")
	          || normalized.get("personal info intended major")
	          || normalized.get("intended major")
	          || normalized.get("intended_major")
	          || ""
	        );
	      }
	      if (/(ethnicity|race|racial|hispanic|latino)/.test(joined)) {
	        return String(
	          normalized.get("personalinfo ethnicity")
	          || normalized.get("personal info ethnicity")
	          || normalized.get("ethnicity")
	          || ""
	        );
	      }
	      if (/(high school|school name|current school|currently attend|attend school|what school|school)/.test(joined)) {
	        return String(
	          normalized.get("school name")
	          || normalized.get("school_name")
	          || normalized.get("high school")
	          || normalized.get("high_school")
	          || normalized.get("current school")
	          || ""
	        );
	      }
	      if (/(email|e mail)/.test(joined)) return emailFallback || "";
	      if (/(phone|mobile|cell)/.test(joined)) return phoneFallback || "";
	      if (/(date of birth|birth date|dob|mm dd yyyy)/.test(joined)) return dobFallback || "";
	      if (/(address line 2|apt|suite|unit|apartment)/.test(joined)) {
	        return String(
	          normalized.get("personalinfo addressline2")
	          || normalized.get("personal info address line 2")
	          || normalized.get("address line 2")
	          || normalized.get("address2")
	          || ""
	        );
	      }
	      if (/(street address|address line 1|mailing address|^address$|\baddress\b)/.test(joined) && !/(address line 2|apt|suite|unit|apartment)/.test(joined)) {
	        return String(
	          normalized.get("personalinfo addressline1")
	          || normalized.get("personal info address line 1")
	          || normalized.get("address line 1")
	          || normalized.get("address")
	          || normalized.get("mailing address")
	          || normalized.get("street address")
	          || normalized.get("street")
	          || normalized.get("street address line 1")
	          || ""
	        );
	      }
	      if (/\bcity\b/.test(joined)) return String(normalized.get("personalinfo city") || normalized.get("city") || "");
	      if (/(state|province|region)/.test(joined)) return String(normalized.get("personalinfo state") || normalized.get("state") || "");
	      if (/(zip|postal)/.test(joined)) {
	        return String(
	          normalized.get("personalinfo postalcode")
	          || normalized.get("postal code")
	          || normalized.get("postal_code")
	          || normalized.get("zip")
	          || normalized.get("zip code")
	          || ""
	        );
	      }
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
	        AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california",
	        CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia",
	        HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa",
	        KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland",
	        MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri",
	        MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey",
	        NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio",
	        OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina",
	        SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont",
	        VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming",
	        DC: "district of columbia"
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

    const setControlValue = (node, rawValue) => {
      const value = String(rawValue ?? "");
      const proto = Object.getPrototypeOf(node);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      if (descriptor?.set) {
        descriptor.set.call(node, value);
	      } else {
        node.value = value;
      }
    };

    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    const triggerMouseClick = (node) => {
      if (!node) return;
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    };

    const resolveInteractiveNode = (node) => {
      if (!node) return null;
      const tag = String(node.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || node.isContentEditable) {
        return node;
      }
      const nested = node.querySelector?.("input, textarea, [contenteditable='true']");
      return nested || node;
    };

    const collectKeysForNode = (node) => {
      const interactiveNode = resolveInteractiveNode(node) || node;
      const id = String(interactiveNode?.id || node?.id || "").trim();
      const name = String(interactiveNode?.getAttribute?.("name") || node?.getAttribute?.("name") || "").trim();
      const placeholder = String(interactiveNode?.getAttribute?.("placeholder") || node?.getAttribute?.("placeholder") || "").trim();
      const aria = String(interactiveNode?.getAttribute?.("aria-label") || node?.getAttribute?.("aria-label") || "").trim();
      const labelFor = id ? (labelMap.get(id.toLowerCase()) || "") : "";
      const wrapped = interactiveNode?.closest?.("label")
        ? String(interactiveNode.closest("label").textContent || "").trim()
        : (node?.closest?.("label") ? String(node.closest("label").textContent || "").trim() : "");
      return [name, id, labelFor, wrapped, placeholder, aria].filter(Boolean);
    };

    const chooseComboboxOption = async (node, rawValue) => {
      const value = String(rawValue || "").trim();
      if (!value) return false;
      const interactiveNode = resolveInteractiveNode(node) || node;
      const target = normalizeText(value);
      const roots = [];
      const directControls = [interactiveNode, node].filter(Boolean);
      for (const candidate of directControls) {
        const controlsId = String(candidate.getAttribute?.("aria-controls") || "").trim();
        if (controlsId) {
          const root = document.getElementById(controlsId);
          if (root) roots.push(root);
        }
      }
      const comboRoot = node.closest?.("[role='combobox']") || interactiveNode.closest?.("[role='combobox']");
      if (comboRoot) {
        const comboControls = String(comboRoot.getAttribute("aria-controls") || "").trim();
        if (comboControls) {
          const root = document.getElementById(comboControls);
          if (root) roots.push(root);
        }
      }
      if (roots.length === 0) {
        roots.push(document);
      }

      const options = [];
      for (const root of roots) {
        const found = Array.from(root.querySelectorAll("[role='option'], [role='menuitem'], li, button, div"))
          .filter((option) => visible(option))
          .map((option) => ({
            node: option,
            text: String(option.textContent || "").trim()
          }))
          .filter((option) => option.text && option.text.length <= 120);
        options.push(...found);
      }

      const unique = [];
      const seen = new Set();
      for (const option of options) {
        if (seen.has(option.node)) continue;
        seen.add(option.node);
        unique.push(option);
      }

      const ranked = unique
        .map((option) => {
          const optionText = normalizeText(option.text);
          let score = 0;
          if (optionText === target) score += 6;
          if (optionText.includes(target) || target.includes(optionText)) score += 3;
          if (option.node.getAttribute("role") === "option") score += 2;
          return { ...option, score };
        })
        .filter((option) => option.score > 0)
        .sort((a, b) => b.score - a.score || a.text.length - b.text.length);

      if (!ranked.length) {
        return false;
      }

      ranked[0].node.scrollIntoView({ block: "nearest", inline: "nearest" });
      triggerMouseClick(ranked[0].node);
      await sleep(60);
      return true;
    };

    const simulateTyping = async (node, rawValue) => {
      const value = String(rawValue ?? "");
      const interactiveNode = resolveInteractiveNode(node);
      if (!interactiveNode) {
        return false;
      }
      interactiveNode.scrollIntoView({ block: "center", inline: "nearest" });
      if (typeof interactiveNode.focus === "function") {
        interactiveNode.focus();
      }
      triggerMouseClick(interactiveNode);
      await sleep(30);

      if (interactiveNode.isContentEditable) {
        interactiveNode.textContent = "";
        interactiveNode.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
        let typed = "";
        for (const char of value) {
          interactiveNode.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
          typed += char;
          interactiveNode.textContent = typed;
          interactiveNode.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
          interactiveNode.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
        }
        interactiveNode.dispatchEvent(new Event("change", { bubbles: true }));
        interactiveNode.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;
      }

      setControlValue(interactiveNode, "");
      interactiveNode.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));

      let typed = "";
      for (const char of value) {
        interactiveNode.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
        typed += char;
        setControlValue(interactiveNode, typed);
        interactiveNode.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
        interactiveNode.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      }
      interactiveNode.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(120);
      interactiveNode.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    };

    const controls = Array.from(document.querySelectorAll("input, textarea, select, [role='combobox'], [contenteditable='true']"));
    let filledCount = 0;
    const debugEntries = [];
    const unmatchedEntries = [];
    const seenControls = new Set();
    for (const node of controls) {
      if (seenControls.has(node)) continue;
      seenControls.add(node);
      if (!visible(node)) continue;
      if (node.disabled || node.readOnly) continue;

      const interactiveNode = resolveInteractiveNode(node) || node;
      const tag = String(interactiveNode.tagName || "").toLowerCase();
      const type = String(interactiveNode.getAttribute?.("type") || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
      if (tag === "input" && type === "file") continue;

      const keys = collectKeysForNode(node);
      const fieldLabel = keys[2] || keys[3] || keys[1] || keys[0] || keys[4] || keys[5] || "(unlabeled)";
      const baseDebug = {
        fieldLabel: String(fieldLabel || "").trim(),
        keys: keys.slice(0, 6),
        tag,
        type,
        role: String(node.getAttribute?.("role") || interactiveNode.getAttribute?.("role") || "").toLowerCase(),
        placeholder: String(interactiveNode.getAttribute?.("placeholder") || "").trim()
      };
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
      if (candidate === null || candidate === undefined) {
        if (unmatchedEntries.length < 40) {
          unmatchedEntries.push({
            ...baseDebug,
            method: "skip",
            success: false,
            reason: "no-candidate",
            finalValue: interactiveNode.isContentEditable
              ? String(interactiveNode.textContent || "").trim().slice(0, 120)
              : String(interactiveNode.value || "").trim().slice(0, 120)
          });
        }
        continue;
      }

      const value = maybeNormalizeDateValue(node, keys, candidate);
      if (!value.trim()) {
        if (unmatchedEntries.length < 40) {
          unmatchedEntries.push({
            ...baseDebug,
            candidateValue: "",
            method: "skip",
            success: false,
            reason: "empty-candidate",
            finalValue: interactiveNode.isContentEditable
              ? String(interactiveNode.textContent || "").trim().slice(0, 120)
              : String(interactiveNode.value || "").trim().slice(0, 120)
          });
        }
        continue;
      }

      const attemptDebug = {
        ...baseDebug,
        candidateValue: String(value || "").slice(0, 120),
      };

      if (tag === "select") {
        const select = interactiveNode;
        const chosen = chooseSelectOption(select, value);
        debugEntries.push({
          ...attemptDebug,
          method: "select",
          success: Boolean(chosen),
          finalValue: String(select.options?.[select.selectedIndex]?.textContent || select.value || "").trim()
        });
        if (chosen) filledCount += 1;
        continue;
      }

      if (type === "checkbox") {
        const yes = /^(true|yes|1|on)$/i.test(value.trim());
        interactiveNode.checked = yes;
        interactiveNode.dispatchEvent(new Event("change", { bubbles: true }));
        debugEntries.push({
          ...attemptDebug,
          method: "checkbox",
          success: true,
          finalValue: String(interactiveNode.checked)
        });
        filledCount += 1;
        continue;
      }

      if (type === "radio") {
        const radioValue = String(interactiveNode.value || "");
        if (normalizeText(radioValue) === normalizeText(value)) {
          interactiveNode.checked = true;
          interactiveNode.dispatchEvent(new Event("change", { bubbles: true }));
          debugEntries.push({
            ...attemptDebug,
            method: "radio",
            success: true,
            finalValue: String(interactiveNode.checked)
          });
          filledCount += 1;
        } else {
          debugEntries.push({
            ...attemptDebug,
            method: "radio",
            success: false,
            finalValue: radioValue
          });
        }
        continue;
      }

      const typed = await simulateTyping(node, value);
      if (!typed) {
        debugEntries.push({
          ...attemptDebug,
          method: "type",
          success: false,
          finalValue: ""
        });
        continue;
      }

      const role = String(node.getAttribute?.("role") || interactiveNode.getAttribute?.("role") || "").toLowerCase();
      const comboLike = role === "combobox"
        || String(interactiveNode.getAttribute?.("aria-autocomplete") || "").toLowerCase() === "list"
        || /address|state|city|school/.test(normalizeText(keys.join(" ")));
      let comboSelected = false;
      if (comboLike) {
        comboSelected = await chooseComboboxOption(node, value);
      }

      const finalValue = interactiveNode.isContentEditable
        ? String(interactiveNode.textContent || "").trim()
        : String(interactiveNode.value || "").trim();
      debugEntries.push({
        ...attemptDebug,
        method: comboLike ? "type+combo" : "type",
        success: true,
        comboSelected,
        finalValue: finalValue.slice(0, 120)
      });

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

    return { filledCount, debugEntries: [...debugEntries, ...unmatchedEntries].slice(0, 150) };
  }, payload);
}

async function fillVisibleFields(page, payload) {
  const frames = allFrames(page);
  let filledCount = 0;
  const debugEntries = [];
  for (const frame of frames) {
    try {
      const result = await fillVisibleFieldsInFrame(frame, payload);
      filledCount += Number(result?.filledCount || 0);
      const frameUrl = frame.url();
      for (const entry of result?.debugEntries || []) {
        debugEntries.push({
          frameUrl,
          ...entry
        });
      }
    } catch {
      // best effort per-frame
    }
  }
  const deterministicResult = {
    filledCount,
    debugEntries: debugEntries.slice(0, 150)
  };

  if (!shouldUseAiFieldMapper(deterministicResult)) {
    return deterministicResult;
  }

  return await applyAiFieldMapperFallback(page, payload, deterministicResult);
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

async function extractAiFillCandidatesInFrame(frame) {
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

    const controls = Array.from(document.querySelectorAll("input, textarea, select, [role='combobox'], [contenteditable='true']"));
    const rows = [];
    const seen = new Set();
    let fieldIndex = 0;

    for (const node of controls) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (!visible(node)) continue;
      if (node.disabled || node.readOnly) continue;

      const interactiveNode = ["input", "textarea", "select"].includes(String(node.tagName || "").toLowerCase()) || node.isContentEditable
        ? node
        : (node.querySelector?.("input, textarea, select, [contenteditable='true']") || node);

      if (!interactiveNode || !visible(interactiveNode)) continue;

      const tag = String(interactiveNode.tagName || "").toLowerCase();
      const type = String(interactiveNode.getAttribute?.("type") || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;

      const id = String(interactiveNode.id || node.id || "").trim();
      const name = String(interactiveNode.getAttribute?.("name") || node.getAttribute?.("name") || "").trim();
      const placeholder = String(interactiveNode.getAttribute?.("placeholder") || node.getAttribute?.("placeholder") || "").trim();
      const ariaLabel = String(interactiveNode.getAttribute?.("aria-label") || node.getAttribute?.("aria-label") || "").trim();
      const role = String(node.getAttribute?.("role") || interactiveNode.getAttribute?.("role") || "").trim();
      const labelFor = id ? (labelMap.get(id.toLowerCase()) || "") : "";
      const wrapped = interactiveNode.closest?.("label")
        ? String(interactiveNode.closest("label").textContent || "").trim()
        : (node.closest?.("label") ? String(node.closest("label").textContent || "").trim() : "");
      const legend = interactiveNode.closest?.("fieldset")?.querySelector?.("legend")
        ? String(interactiveNode.closest("fieldset").querySelector("legend").textContent || "").trim()
        : "";
      const prompt = interactiveNode.closest?.("form, section, main, article, div")?.querySelector?.("h1, h2, h3")
        ? String(interactiveNode.closest("form, section, main, article, div").querySelector("h1, h2, h3").textContent || "").trim()
        : "";
      const label = labelFor || wrapped || legend || placeholder || ariaLabel || name || id || `field-${fieldIndex}`;
      const options = tag === "select"
        ? Array.from(interactiveNode.options || []).map((option) => String(option.textContent || "").trim()).filter(Boolean).slice(0, 12)
        : [];
      const currentValue = interactiveNode.isContentEditable
        ? String(interactiveNode.textContent || "").trim()
        : String(interactiveNode.value || "").trim();

      rows.push({
        fieldIndex,
        label,
        name,
        id,
        placeholder,
        ariaLabel,
        role,
        tag,
        type,
        prompt,
        required: Boolean(interactiveNode.required || String(interactiveNode.getAttribute?.("aria-required") || "").toLowerCase() === "true"),
        optionTexts: options,
        currentValue: currentValue.slice(0, 120)
      });
      fieldIndex += 1;
    }

    return rows;
  });
}

async function extractAiFillCandidates(page) {
  const frames = allFrames(page);
  const rows = [];
  for (const frame of frames) {
    try {
      const frameRows = await extractAiFillCandidatesInFrame(frame);
      for (const row of frameRows) {
        rows.push({
          frameUrl: frame.url(),
          ...row
        });
      }
    } catch {
      // best effort
    }
  }
  return rows.slice(0, 200);
}

async function applyAiPlanInFrame(frame, planEntries) {
  return await frame.evaluate(async ({ entries }) => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };

    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    const triggerMouseClick = (node) => {
      if (!node) return;
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    };

    const setControlValue = (node, rawValue) => {
      const value = String(rawValue ?? "");
      const proto = Object.getPrototypeOf(node);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      if (descriptor?.set) {
        descriptor.set.call(node, value);
      } else {
        node.value = value;
      }
    };

    const chooseSelectOption = (select, rawValue) => {
      const value = String(rawValue || "").trim().toLowerCase();
      if (!value) return false;
      for (let i = 0; i < select.options.length; i += 1) {
        const option = select.options[i];
        const text = String(option.textContent || "").trim().toLowerCase();
        const optionValue = String(option.value || "").trim().toLowerCase();
        if (text === value || optionValue === value || text.includes(value) || value.includes(text)) {
          select.selectedIndex = i;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    };

    const chooseComboboxOption = async (node, rawValue) => {
      const value = String(rawValue || "").trim().toLowerCase();
      if (!value) return false;
      const roots = [];
      const controlsId = String(node.getAttribute?.("aria-controls") || "").trim();
      if (controlsId) {
        const root = document.getElementById(controlsId);
        if (root) roots.push(root);
      }
      const comboRoot = node.closest?.("[role='combobox']");
      if (comboRoot) {
        const comboControls = String(comboRoot.getAttribute("aria-controls") || "").trim();
        if (comboControls) {
          const root = document.getElementById(comboControls);
          if (root) roots.push(root);
        }
      }
      if (!roots.length) roots.push(document);

      const candidates = [];
      for (const root of roots) {
        const found = Array.from(root.querySelectorAll("[role='option'], [role='menuitem'], li, button, div"))
          .filter((option) => visible(option))
          .map((option) => ({ node: option, text: String(option.textContent || "").trim() }))
          .filter((option) => option.text && option.text.length <= 160);
        candidates.push(...found);
      }

      const ranked = candidates
        .map((candidate) => {
          const text = candidate.text.toLowerCase();
          let score = 0;
          if (text === value) score += 8;
          if (text.includes(value) || value.includes(text)) score += 4;
          if (candidate.node.getAttribute("role") === "option") score += 2;
          return { ...candidate, score };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score || a.text.length - b.text.length);

      if (!ranked.length) return false;
      ranked[0].node.scrollIntoView({ block: "nearest", inline: "nearest" });
      triggerMouseClick(ranked[0].node);
      await sleep(80);
      return true;
    };

    const simulateTyping = async (node, rawValue) => {
      const value = String(rawValue ?? "");
      node.scrollIntoView({ block: "center", inline: "nearest" });
      if (typeof node.focus === "function") node.focus();
      triggerMouseClick(node);
      await sleep(30);

      if (node.isContentEditable) {
        node.textContent = "";
        node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
        let typed = "";
        for (const char of value) {
          node.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
          typed += char;
          node.textContent = typed;
          node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
          node.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
        }
        node.dispatchEvent(new Event("change", { bubbles: true }));
        node.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;
      }

      setControlValue(node, "");
      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      let typed = "";
      for (const char of value) {
        node.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
        typed += char;
        setControlValue(node, typed);
        node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
        node.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      }
      node.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(120);
      node.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    };

    const controls = [];
    const seen = new Set();
    for (const node of document.querySelectorAll("input, textarea, select, [role='combobox'], [contenteditable='true']")) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (!visible(node)) continue;
      if (node.disabled || node.readOnly) continue;
      const interactiveNode = ["input", "textarea", "select"].includes(String(node.tagName || "").toLowerCase()) || node.isContentEditable
        ? node
        : (node.querySelector?.("input, textarea, select, [contenteditable='true']") || node);
      if (!interactiveNode || !visible(interactiveNode)) continue;
      const tag = String(interactiveNode.tagName || "").toLowerCase();
      const type = String(interactiveNode.getAttribute?.("type") || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;
      controls.push({ root: node, interactiveNode });
    }

    const debugEntries = [];
    let filledCount = 0;
    for (const entry of entries) {
      const field = controls[Number(entry.fieldIndex)];
      if (!field) {
        debugEntries.push({
          fieldLabel: entry.fieldLabel || `field-${entry.fieldIndex}`,
          method: `ai-${entry.interaction || "skip"}`,
          success: false,
          reason: "field-not-found",
          candidateValue: String(entry.value || "").slice(0, 120),
          finalValue: ""
        });
        continue;
      }

      const node = field.interactiveNode;
      const tag = String(node.tagName || "").toLowerCase();
      let success = false;
      let comboSelected = false;

      if (entry.interaction === "skip") {
        debugEntries.push({
          fieldLabel: entry.fieldLabel || `field-${entry.fieldIndex}`,
          method: "ai-skip",
          success: false,
          reason: String(entry.reason || "ai-skip"),
          candidateValue: String(entry.value || "").slice(0, 120),
          finalValue: ""
        });
        continue;
      }

      if (tag === "select" || entry.interaction === "select") {
        success = chooseSelectOption(node, entry.value);
      } else {
        success = await simulateTyping(node, entry.value);
        if (success && entry.interaction === "combobox") {
          comboSelected = await chooseComboboxOption(node, entry.value);
        }
      }

      const finalValue = node.isContentEditable
        ? String(node.textContent || "").trim()
        : String(node.value || "").trim();

      debugEntries.push({
        fieldLabel: entry.fieldLabel || `field-${entry.fieldIndex}`,
        method: `ai-${entry.interaction || "type"}`,
        success,
        comboSelected,
        reason: String(entry.reason || "").trim(),
        candidateValue: String(entry.value || "").slice(0, 120),
        finalValue: finalValue.slice(0, 120)
      });
      if (success) filledCount += 1;
    }

    return { filledCount, debugEntries };
  }, { entries: planEntries });
}

async function applyAiFieldPlan(page, planEntries) {
  if (!Array.isArray(planEntries) || !planEntries.length) {
    return { filledCount: 0, debugEntries: [] };
  }

  const results = [];
  const byFrameUrl = new Map();
  for (const entry of planEntries) {
    const frameUrl = String(entry?.frameUrl || "");
    if (!byFrameUrl.has(frameUrl)) byFrameUrl.set(frameUrl, []);
    byFrameUrl.get(frameUrl).push(entry);
  }

  for (const frame of allFrames(page)) {
    const frameEntries = byFrameUrl.get(frame.url()) || [];
    if (!frameEntries.length) continue;
    try {
      const result = await applyAiPlanInFrame(frame, frameEntries);
      for (const debugEntry of result?.debugEntries || []) {
        results.push({
          frameUrl: frame.url(),
          ...debugEntry
        });
      }
    } catch (error) {
      results.push({
        frameUrl: frame.url(),
        fieldLabel: "(frame)",
        method: "ai-plan",
        success: false,
        reason: error?.message || "ai-plan-failed",
        candidateValue: "",
        finalValue: ""
      });
    }
  }

  return {
    filledCount: results.filter((entry) => entry.success).length,
    debugEntries: results.slice(0, 150)
  };
}

async function applyAiFieldMapperFallback(page, payload, baseFillResult) {
  const fieldRows = await extractAiFillCandidates(page);
  const pageTitle = await page.title().catch(() => "");
  const aiResult = await planGuidedFieldMappingsWithAi({
    pageUrl: page.url(),
    pageTitle,
    fields: fieldRows,
    payload,
    timeoutMs: 25000
  });

  const mappings = Array.isArray(aiResult?.mappings)
    ? aiResult.mappings.filter((mapping) => Number(mapping?.confidence || 0) >= 0.55 && String(mapping?.interaction || "") !== "skip")
    : [];

  if (!mappings.length) {
    const metadataReason = String(aiResult?.metadata?.reason || aiResult?.metadata?.mode || "no-ai-mappings");
    return {
      filledCount: Number(baseFillResult?.filledCount || 0),
      debugEntries: [
        ...(Array.isArray(baseFillResult?.debugEntries) ? baseFillResult.debugEntries : []),
        {
          frameUrl: page.url(),
          fieldLabel: "(ai mapper)",
          method: "ai-plan",
          success: false,
          reason: metadataReason,
          candidateValue: "",
          finalValue: ""
        }
      ].slice(0, 150)
    };
  }

  const aiFillResult = await applyAiFieldPlan(page, mappings);
  return {
    filledCount: Number(baseFillResult?.filledCount || 0) + Number(aiFillResult?.filledCount || 0),
    debugEntries: [
      ...(Array.isArray(baseFillResult?.debugEntries) ? baseFillResult.debugEntries : []),
      ...(Array.isArray(aiFillResult?.debugEntries) ? aiFillResult.debugEntries : [])
    ].slice(0, 150)
  };
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
    fillDiagnostics: fillResult && typeof fillResult === "object"
      ? {
          filledCount: Number(fillResult.filledCount || 0),
          debugEntries: Array.isArray(fillResult.debugEntries) ? fillResult.debugEntries : []
        }
      : { filledCount: 0, debugEntries: [] },
    reviewMessage: accountRequired
      ? `Account setup required before autofill can continue (${accountReason || "login/signup page detected"}). Complete account creation/login in browser, then click Resume After Account Setup.`
      : (fileRequired > 0
        ? `Review this page and upload ${fileRequired} required file(s) manually before continuing. You can use in-page Guided Controls (Refill/Next).`
        : "Review this page, make any edits in browser, then click Approve This Page & Next. You can also use in-page Guided Controls."),
    canAdvance: accountRequired ? false : true
  };
}

function rememberOverlayState(session, summary, fallbackStatus = "Ready") {
  const fillDiagnostics = summary?.fillDiagnostics && typeof summary.fillDiagnostics === "object"
    ? summary.fillDiagnostics
    : { filledCount: 0, debugEntries: [] };
  session.lastFillDiagnostics = fillDiagnostics;
  if (summary?.accountRequired) {
    session.overlayStatus = "Account setup required";
    return {
      statusText: session.overlayStatus,
      debugText: formatOverlayDebug(fillDiagnostics)
    };
  }

  if (typeof summary?.filledCount === "number") {
    session.overlayStatus = summary.filledCount > 0
      ? `Refilled ${summary.filledCount}`
      : fallbackStatus;
  } else {
    session.overlayStatus = fallbackStatus;
  }

  return {
    statusText: session.overlayStatus,
    debugText: formatOverlayDebug(fillDiagnostics)
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
    payload: payload || {},
    overlayStatus: "Ready",
    lastFillDiagnostics: { filledCount: 0, debugEntries: [] }
  };
  attachGuidedPageListeners(session, page);

  await context.exposeBinding("__sbRefill", async () => {
    const summary = await refillCurrentStep(session);
    const overlay = rememberOverlayState(session, summary, "Refilled");
    await installInPageControls(session);
    return { ok: true, ...overlay };
  });
  await context.exposeBinding("__sbNext", async () => {
    const moved = await clickNext(session.page);
    if (!moved) {
      const overlay = rememberOverlayState(session, null, "No next button found");
      await installInPageControls(session);
      return { ok: false, reason: "No next button found", ...overlay };
    }
    await session.page.waitForTimeout(1400);
    session.stepNumber += 1;
    const summary = await refillCurrentStep(session);
    const overlay = rememberOverlayState(session, summary, "Advanced");
    await installInPageControls(session);
    return { ok: true, ...overlay };
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const activePage = await clickApplyStart(page, context);
  if (activePage !== page) {
    session.page = activePage;
    attachGuidedPageListeners(session, activePage);
  }

  const fillResult = await fillVisibleFields(session.page, payload || {});
  const fields = await extractVisibleFields(session.page);
  const accountState = await detectAccountWall(session.page);
  const initialSummary = summarizeSessionState(session, fields, fillResult, {
    accountRequired: accountState.accountRequired,
    accountReason: accountState.reason,
    accountEvidence: accountState.evidence
  });
  rememberOverlayState(session, initialSummary, "Ready");

  await installInPageControls(session);
  sessions.set(session.id, session);

  return initialSummary;
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
    const summary = {
      ...refreshed,
      accountRequired: true,
      accountReason: beforeMoveAccountState.reason,
      accountEvidence: beforeMoveAccountState.evidence,
      canAdvance: false,
      reviewMessage: `Account setup required before continuing (${beforeMoveAccountState.reason || "login/signup page detected"}). Complete it in browser, then click Resume After Account Setup.`
    };
    rememberOverlayState(session, summary, "Account setup required");
    await installInPageControls(session);
    return summary;
  }

  const moved = await clickNext(session.page);
  if (!moved) {
    const refreshed = await refillCurrentStep(session);
    const summary = {
      ...refreshed,
      canAdvance: false,
      reviewMessage: "No Next button found. You are likely on the final page; please review and submit manually."
    };
    rememberOverlayState(session, summary, "No next button found");
    await installInPageControls(session);
    return summary;
  }

  await session.page.waitForTimeout(1600);
  session.stepNumber += 1;
  const fillResult = await fillVisibleFields(session.page, session.payload);
  const fields = await extractVisibleFields(session.page);
  const accountState = await detectAccountWall(session.page);
  const summary = summarizeSessionState(session, fields, fillResult, {
    accountRequired: accountState.accountRequired,
    accountReason: accountState.reason,
    accountEvidence: accountState.evidence
  });
  rememberOverlayState(session, summary, "Advanced");
  await installInPageControls(session);
  return summary;
}

export async function refillGuidedSubmission({ sessionId }) {
  const id = String(sessionId || "").trim();
  const session = sessions.get(id);
  if (!session) {
    throw new Error("Submission session not found");
  }
  const result = await refillCurrentStep(session);
  const accountState = await detectAccountWall(session.page);
  const summary = {
    ...result,
    accountRequired: accountState.accountRequired,
    accountReason: accountState.reason,
    accountEvidence: accountState.evidence,
    canAdvance: accountState.accountRequired ? false : result.canAdvance,
    reviewMessage: accountState.accountRequired
      ? `Account setup required before continuing (${accountState.reason || "login/signup page detected"}). Complete it in browser, then click Resume After Account Setup.`
      : result.reviewMessage
  };
  rememberOverlayState(session, summary, "Refilled");
  await installInPageControls(session);
  return summary;
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
  const summary = summarizeSessionState(session, fields, fillResult, {
    accountRequired: accountState.accountRequired,
    accountReason: accountState.reason,
    accountEvidence: accountState.evidence
  });
  rememberOverlayState(session, summary, "Resumed");
  await installInPageControls(session);
  return summary;
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
    const summary = {
      ...result,
      accountRequired: accountState.accountRequired,
      accountReason: accountState.reason,
      accountEvidence: accountState.evidence,
      canAdvance: accountState.accountRequired ? false : result.canAdvance,
      reviewMessage: accountState.accountRequired
        ? `Account setup required before continuing (${accountState.reason || "login/signup page detected"}). Complete it in browser, then click Resume After Account Setup.`
        : result.reviewMessage
    };
    rememberOverlayState(session, summary, "Refilled");
    await installInPageControls(session);
    return summary;
  }

  const fields = await extractVisibleFields(session.page);
  return summarizeSessionState(session, fields, null);
}
