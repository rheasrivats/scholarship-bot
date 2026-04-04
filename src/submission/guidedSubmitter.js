import { randomUUID } from "node:crypto";
import { planGuidedActionsWithAi, planGuidedFieldMappingsWithAi } from "./guidedAiAssist.js";
import { generateEssayDraftWithAgent } from "../autofill/essayDraftAgent.js";

const sessions = new Map();
const GUIDED_OVERLAY_VERSION = "guided-v3-ai-action-loop";
const GUIDED_FILL_STRATEGY = String(process.env.GUIDED_FILL_STRATEGY || "ai_first").trim().toLowerCase();
const GUIDED_AI_ACTION_PREVIEW_SEC = Math.max(
  0,
  Number.parseInt(String(process.env.GUIDED_AI_ACTION_PREVIEW_SEC || "3"), 10) || 0
);
const OVERLAY_CONTROL_TEXT_RE = /\b(autofill page|approve\s*&?\s*next page|stop guided session)\b/i;

function logGuidedOverlayFailure(session, phase, error, details = null) {
  const sessionId = String(session?.id || "unknown");
  const pageUrl = session?.page && typeof session.page.url === "function" ? String(session.page.url()) : "unknown";
  const step = Number(session?.stepNumber || 1);
  const status = String(session?.overlayStatus || "unknown");
  const msg = `[guided-submit] overlay:${phase} session=${sessionId} step=${step} status=${status} page=${pageUrl}`;
  if (details) {
    console.warn(`${msg} details=${JSON.stringify(details)}`);
  }
  if (error) {
    console.warn(`${msg} error=${String(error?.message || error)}`);
  }
}

function isBenignThirdPartyConsoleNoise(text = "", sourceUrl = "") {
  const combined = `${String(text || "")} ${String(sourceUrl || "")}`.toLowerCase();
  const looksLikeNetworkNoise = /failed to load resource|net::err|status of (4|5)\d\d/.test(combined);
  if (!looksLikeNetworkNoise) return false;
  return /(stickyadstv|doubleclick|googlesyndication|adservice|google-analytics|googletagmanager|facebook|segment|hotjar|mailchimp)/.test(combined);
}

function installGuidedLoggingListeners(page, session) {
  if (!page || typeof page.on !== "function") return;
  page.on("pageerror", (error) => {
    logGuidedOverlayFailure(session, "browser-page-error", error, { source: "browser" });
  });
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    const text = String(message.text() || "").trim();
    if (!text) return;
    const location = message.location ? message.location() : null;
    const sourceUrl = String(location?.url || "");
    if (isBenignThirdPartyConsoleNoise(text, sourceUrl)) return;
    logGuidedOverlayFailure(session, `browser-console-${type}`, new Error(text), {
      source: "browser-console",
      location
    });
  });
}

async function waitForOverlayMountPoint(page, timeoutMs = 2200) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(50, deadline - Date.now());
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(900, remaining) });
    } catch {
      // page may still be navigating; keep polling
    }
    try {
      const hasMount = await page.evaluate(() => Boolean(document.body || document.documentElement));
      if (hasMount) return true;
    } catch {
      // execution context may be reloading; keep polling
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(140, remaining));
  }
  return false;
}

function consumeManualActionRequest(session = null) {
  if (!session || typeof session !== "object") return false;
  if (!session.manualActionRequested) return false;
  session.manualActionRequested = false;
  return true;
}

function hasManualResumeRequested(session = null) {
  return Boolean(session && typeof session === "object" && session.manualResumeRequested);
}

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
    if (String(entry?.reason || "") === "manual-input-detected-state-reset") {
      return "Manual input detected | state reset";
    }
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

function buildOverlayPresentation(session) {
  const status = String(session?.overlayStatus || "Ready");
  const stepNumber = Math.max(1, Number(session?.stepNumber || 1));
  const fillDiagnostics = session?.lastFillDiagnostics || { filledCount: 0, debugEntries: [] };
  const filledCount = Number(fillDiagnostics?.filledCount || 0);

  let taskTitle = "Reviewing current step";
  let progressLabel = "Waiting for action";
  let progressPercent = 24;

  if (/refilling/i.test(status)) {
    taskTitle = "Autofilling current page";
    progressLabel = "Applying saved profile data";
    progressPercent = 58;
  } else if (/advancing/i.test(status)) {
    taskTitle = "Advancing to next page";
    progressLabel = "Moving through application flow";
    progressPercent = 76;
  } else if (/refilled/i.test(status)) {
    taskTitle = filledCount > 0 ? `Filled ${filledCount} field${filledCount === 1 ? "" : "s"}` : "Autofill attempted";
    progressLabel = filledCount > 0 ? "Bot has updated this step" : "No fields were filled on this step";
    progressPercent = filledCount > 0 ? 68 : 42;
  } else if (/advanced/i.test(status)) {
    taskTitle = `Step ${stepNumber} ready`;
    progressLabel = "Ready to continue or refine";
    progressPercent = 84;
  } else if (/account setup required/i.test(status)) {
    taskTitle = "Account setup required";
    progressLabel = "Complete login/signup before continuing";
    progressPercent = 36;
  } else if (/no next button/i.test(status)) {
    taskTitle = "Review final page";
    progressLabel = "No next button detected";
    progressPercent = 100;
  }

  return {
    title: "Scholarship Autofill Assistant",
    subtitle: "Active Session",
    taskTitle,
    progressLabel,
    progressPercent
  };
}

async function setInPagePlanText(session, text) {
  const nextText = String(text || "").trim() || "No planned AI action.";
  session.aiActionPreview = nextText;
  try {
    await session.page.evaluate((value) => {
      const el = document.getElementById("__sb_guided_plan");
      if (el) el.textContent = value;
    }, nextText);
  } catch {
    // overlay may not be available during navigation; value is retained in session
  }
}

function summarizeAiActionForPreview(action, element) {
  const interaction = String(action?.interaction || "action").trim().toLowerCase();
  const label = String(element?.label || action?.fieldLabel || `element ${Number(action?.elementIndex ?? -1)}`).trim();
  const value = String(action?.value || "").trim();
  if (interaction === "click") {
    return `Click "${label}"`;
  }
  if (interaction === "select") {
    return `Select "${value}" for "${label}"`;
  }
  if (interaction === "combobox") {
    return `Type and select "${value}" for "${label}"`;
  }
  if (interaction === "contenteditable") {
    return `Fill long text for "${label}"`;
  }
  if (interaction === "type") {
    return `Type value for "${label}"`;
  }
  return `Run ${interaction} on "${label}"`;
}

function isOverlayControlText(value) {
  return OVERLAY_CONTROL_TEXT_RE.test(String(value || ""));
}

function isOverlayControlAction(action, elements = []) {
  const element = (Array.isArray(elements) ? elements : [])
    .find((candidate) => Number(candidate?.elementIndex) === Number(action?.elementIndex)
      && String(candidate?.frameUrl || "") === String(action?.frameUrl || ""));
  const actionReason = String(action?.reason || "");
  const actionValue = String(action?.value || "");
  const label = String(element?.label || "");
  return isOverlayControlText(label) || isOverlayControlText(actionReason) || isOverlayControlText(actionValue);
}

function normalizeGuidedActionValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildGuidedActionKey(action = {}) {
  return [
    String(action?.frameUrl || ""),
    String(Number(action?.elementIndex ?? -1)),
    String(action?.interaction || "").trim().toLowerCase(),
    normalizeGuidedActionValue(action?.value).slice(0, 240)
  ].join("::");
}

function isEssayLikeFieldText(value = "") {
  const text = String(value || "").toLowerCase().trim();
  if (!text) return false;
  if (/(newsletter|subscribe|marketing|promo|coupon|feedback|comment|captcha|search|login|password)/.test(text)) {
    return false;
  }
  return /(essay|personal statement|short answer|long answer|essay response|response statement|word limit|minimum words?|essay\d+|personal_statement)/.test(text);
}

function isEssayLikeElementDescriptor(element = {}) {
  const parts = [
    String(element?.label || ""),
    String(element?.name || ""),
    String(element?.id || ""),
    String(element?.placeholder || ""),
    String(element?.ariaLabel || "")
  ].filter(Boolean);
  return isEssayLikeFieldText(parts.join(" "));
}

function isLikelyEssayValue(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  if (text.length >= 220) return true;
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentenceCount = (text.match(/[.!?]/g) || []).length;
  if (words >= 60 && sentenceCount >= 2) return true;
  return /\b(essay question|thesis statement|introductory paragraph|concluding paragraph|personal statement|why do you want to be in college)\b/i.test(text);
}

function buildEssaySafeAutofillPayload(payload = {}) {
  const safePayload = {};
  for (const [key, rawValue] of Object.entries(payload || {})) {
    if (rawValue === null || rawValue === undefined) continue;
    const keyText = String(key || "").trim();
    const valueText = String(rawValue || "").trim();
    if (!valueText) continue;
    if (isEssayLikeFieldText(keyText)) continue;
    if (isLikelyEssayValue(valueText)) continue;
    safePayload[key] = rawValue;
  }
  return safePayload;
}

async function installInPageControls(session) {
  const { page } = session;
  const statusText = String(session.overlayStatus || "Ready");
  const debugText = formatOverlayDebug(session.lastFillDiagnostics);
  const canAdvance = Boolean(session.canAdvance);
  const manualRequested = Boolean(session.manualResumeRequested);
  let hasStrictEssayField = false;
  try {
    const visibleFields = await extractVisibleFields(page);
    hasStrictEssayField = visibleFields.some((field) => isStrictEssayDescriptor(field));
  } catch {
    // best effort only
  }
  let essayPrompt = inferEssayPromptFromSession(session);
  if (!hasStrictEssayField && !String(session.lastEssayDraft || "").trim()) {
    essayPrompt = "";
    session.lastEssayPrompt = "";
  }
  if (!essayPrompt) {
    try {
      essayPrompt = await detectEssayPromptOnPage(page);
      if (essayPrompt) {
        session.lastEssayPrompt = essayPrompt;
      }
    } catch {
      // best effort only
    }
  }
  const essayDraft = String(session.lastEssayDraft || "");
  await waitForOverlayMountPoint(page, 2600);
  try {
    await ensureMinimalGuidedOverlay(page, statusText, debugText, canAdvance, manualRequested);
  } catch {
    logGuidedOverlayFailure(session, "simple-fallback-bootstrap", null, { phase: "simple-fallback-bootstrap", overlayStatus: statusText });
    // best effort: still attempt rich controls
  }
  try {
    const presentation = buildOverlayPresentation(session);
    const renderRichOverlay = async () => await page.evaluate(({ statusText, debugText, overlayVersion, presentation, stepNumber, actionPreview, canAdvance, manualRequested, essayPrompt, essayDraft }) => {
      const safe = (phase, reason, details = null) => ({ ok: false, phase, reason, details });
      const applyStyles = (el, styles) => {
        for (const [property, value] of Object.entries(styles || {})) {
          el.style.setProperty(property, String(value), "important");
        }
      };
      const isGuidedOverlayElement = (el) => Boolean(
        el?.closest?.("#__sb_guided_overlay")
        || el?.closest?.("#__sb_guided_overlay_simple")
      );
      const isManualInteractionTarget = (el) => {
        if (!el) return false;
        if (isGuidedOverlayElement(el)) return false;
        const selector = [
          "input",
          "textarea",
          "select",
          "[contenteditable='true']",
          "[role='combobox']",
          "[role='option']",
          "[role='radio']",
          "[role='checkbox']",
          "button",
          "a",
          "[role='button']",
          "label"
        ].join(",");
        return Boolean(el.closest?.(selector));
      };
      const notifyManualApplied = () => {
        if (!window.__sbManualRequested) return;
        if (window.__sbManualAppliedPending) return;
        window.__sbManualRequested = false;
        window.__sbManualAppliedPending = true;
        Promise.resolve()
          .then(async () => {
            if (typeof window.__sbManualApplied === "function") {
              await window.__sbManualApplied();
            }
          })
          .catch(() => {})
          .finally(() => {
            window.__sbManualAppliedPending = false;
          });
      };
      if (!window.__sbManualWatcherInstalled) {
        const onClick = (event) => {
          const target = event?.target;
          if (!isManualInteractionTarget(target)) return;
          notifyManualApplied();
        };
        const onChange = (event) => {
          const target = event?.target;
          if (!isManualInteractionTarget(target)) return;
          notifyManualApplied();
        };
        const onKeydown = (event) => {
          const target = event?.target;
          if (!isManualInteractionTarget(target)) return;
          const key = String(event?.key || "").toLowerCase();
          if (!["enter", " ", "spacebar", "arrowup", "arrowdown", "arrowleft", "arrowright", "tab"].includes(key)) return;
          notifyManualApplied();
        };
        document.addEventListener("click", onClick, true);
        document.addEventListener("change", onChange, true);
        document.addEventListener("keydown", onKeydown, true);
        window.__sbManualWatcherInstalled = true;
      }
      window.__sbManualRequested = Boolean(manualRequested);

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

      const setTask = (text) => {
        const el = document.getElementById("__sb_guided_task");
        if (el) el.textContent = text;
      };

      const setProgressLabel = (text) => {
        const el = document.getElementById("__sb_guided_progress_label");
        if (el) el.textContent = text;
      };

      const setProgressBar = (percent) => {
        const el = document.getElementById("__sb_guided_progress_bar");
        if (el) el.style.width = `${Math.max(6, Math.min(100, Number(percent) || 0))}%`;
      };

      const setStep = (value) => {
        const el = document.getElementById("__sb_guided_step");
        if (el) el.textContent = `Step ${value}`;
      };

      const setPlan = (text) => {
        const el = document.getElementById("__sb_guided_plan");
        if (el) el.textContent = text;
      };
      const setManualButtonState = (requested) => {
        const el = document.querySelector("[data-guided-manual-action]");
        if (!el) return;
        if (requested) {
          el.textContent = "Manual selection requested";
        } else {
          el.textContent = "Select Manually";
        }
      };
      const setEssayPrompt = (value) => {
        const el = document.getElementById("__sb_guided_essay_prompt");
        if (!el) return;
        if (!String(el.value || "").trim()) {
          el.value = String(value || "");
        }
      };
      const setEssayDraft = (value) => {
        const el = document.getElementById("__sb_guided_essay_draft");
        if (!el) return;
        if (!String(el.value || "").trim()) {
          el.value = String(value || "");
        }
      };
      const setEssayOpen = (open) => {
        const content = document.getElementById("__sb_guided_essay_content");
        const toggle = document.getElementById("__sb_guided_essay_toggle");
        if (!content || !toggle) return;
        const expanded = Boolean(open);
        content.style.setProperty("display", expanded ? "block" : "none", "important");
        toggle.textContent = expanded ? "Hide" : "Show";
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
        window.__sbEssayExpanded = expanded;
      };

      const existing = document.getElementById("__sb_guided_overlay");
      if (existing) {
        setStatus(statusText);
        setDebug(debugText);
        setVersion(overlayVersion);
        setTask(presentation.taskTitle);
        setProgressLabel(presentation.progressLabel);
        setProgressBar(presentation.progressPercent);
        setStep(stepNumber);
        setPlan(actionPreview);
        setManualButtonState(Boolean(manualRequested));
        setEssayPrompt(essayPrompt);
        setEssayDraft(essayDraft);
        const shouldAutoExpandEssay = Boolean(String(essayPrompt || "").trim());
        if (window.__sbEssayUserSet) {
          setEssayOpen(Boolean(window.__sbEssayExpanded));
        } else {
          setEssayOpen(shouldAutoExpandEssay);
        }
        const simpleOverlay = document.getElementById("__sb_guided_overlay_simple");
        if (simpleOverlay && simpleOverlay.parentElement) {
          simpleOverlay.remove();
        }
        return;
      }

      if (!document.body) {
        return safe("rich-overlay-install", "document.body is null");
      }
      if (!document.documentElement) {
        return safe("rich-overlay-install", "document.documentElement is null");
      }

      const wrap = document.createElement("div");
      wrap.id = "__sb_guided_overlay";
      applyStyles(wrap, {
        all: "initial",
        position: "fixed",
        right: "16px",
        bottom: "16px",
        "z-index": "2147483647",
        display: "block",
        width: "308px",
        "max-width": "calc(100vw - 32px)",
        "max-height": "calc(100vh - 32px)",
        "overflow-y": "auto",
        "overscroll-behavior": "contain",
        background: "linear-gradient(180deg, #0f2745 0%, #132b48 100%)",
        color: "#f8fafc",
        padding: "16px",
        border: "1px solid rgba(255,255,255,0.12)",
        "border-radius": "16px",
        "box-shadow": "0 24px 44px rgba(15, 23, 42, 0.42)",
        "font-family": "\"Avenir Next\", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "line-height": "1.4",
        "letter-spacing": "0",
        "text-rendering": "optimizeLegibility"
      });

      const headerRow = document.createElement("div");
      applyStyles(headerRow, {
        display: "flex",
        "align-items": "flex-start",
        "justify-content": "space-between",
        gap: "10px",
        margin: "0 0 14px",
        cursor: "move",
        "user-select": "none"
      });

      const brandIcon = document.createElement("div");
      brandIcon.textContent = "✦";
      applyStyles(brandIcon, {
        width: "28px",
        height: "28px",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        "border-radius": "8px",
        background: "rgba(255,255,255,0.14)",
        color: "#ffffff",
        "font-size": "15px",
        "font-weight": "800",
        "flex-shrink": "0"
      });
      headerRow.appendChild(brandIcon);

      const headerText = document.createElement("div");
      applyStyles(headerText, {
        display: "flex",
        "flex-direction": "column",
        gap: "2px",
        "min-width": "0",
        flex: "1"
      });

      const title = document.createElement("div");
      title.textContent = presentation.title;
      applyStyles(title, {
        color: "#f8fafc",
        "font-weight": "800",
        "font-size": "17px",
        "line-height": "1.2",
        margin: "0"
      });
      headerText.appendChild(title);

      const version = document.createElement("div");
      version.id = "__sb_guided_version";
      version.textContent = `${presentation.subtitle} • ${overlayVersion}`;
      applyStyles(version, {
        color: "rgba(226, 232, 240, 0.76)",
        "font-size": "11px",
        "font-weight": "700",
        margin: "0"
      });
      headerText.appendChild(version);
      headerRow.appendChild(headerText);

      const dragHint = document.createElement("div");
      dragHint.textContent = "⋮⋮";
      applyStyles(dragHint, {
        color: "rgba(226, 232, 240, 0.55)",
        "font-size": "16px",
        "line-height": "1",
        "font-weight": "800",
        "padding-top": "2px",
        "flex-shrink": "0"
      });
      headerRow.appendChild(dragHint);
      wrap.appendChild(headerRow);

      const taskLabel = document.createElement("div");
      taskLabel.textContent = "Current Task";
      applyStyles(taskLabel, {
        color: "rgba(226, 232, 240, 0.7)",
        "font-size": "10px",
        "font-weight": "800",
        "letter-spacing": "0.08em",
        "text-transform": "uppercase",
        margin: "0 0 6px"
      });
      wrap.appendChild(taskLabel);

      const taskCard = document.createElement("div");
      applyStyles(taskCard, {
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.08)",
        "border-radius": "12px",
        padding: "12px",
        margin: "0 0 12px"
      });

      const task = document.createElement("div");
      task.id = "__sb_guided_task";
      task.textContent = presentation.taskTitle;
      applyStyles(task, {
        color: "#f8fafc",
        "font-size": "14px",
        "font-weight": "700",
        margin: "0 0 6px"
      });
      taskCard.appendChild(task);

      const status = document.createElement("div");
      status.id = "__sb_guided_status";
      status.textContent = statusText;
      applyStyles(status, {
        color: "#cfe0f1",
        "font-size": "12px",
        "font-weight": "600",
        margin: "0"
      });
      taskCard.appendChild(status);
      wrap.appendChild(taskCard);

      const progressRow = document.createElement("div");
      applyStyles(progressRow, {
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        gap: "10px",
        margin: "0 0 6px"
      });

      const progressLabel = document.createElement("div");
      progressLabel.textContent = "Progress";
      applyStyles(progressLabel, {
        color: "rgba(226, 232, 240, 0.7)",
        "font-size": "10px",
        "font-weight": "800",
        "letter-spacing": "0.08em",
        "text-transform": "uppercase"
      });
      progressRow.appendChild(progressLabel);

      const step = document.createElement("div");
      step.id = "__sb_guided_step";
      step.textContent = `Step ${stepNumber}`;
      applyStyles(step, {
        color: "#dbe7f3",
        "font-size": "11px",
        "font-weight": "700"
      });
      progressRow.appendChild(step);
      wrap.appendChild(progressRow);

      const progressLabelText = document.createElement("div");
      progressLabelText.id = "__sb_guided_progress_label";
      progressLabelText.textContent = presentation.progressLabel;
      applyStyles(progressLabelText, {
        color: "#dbe7f3",
        "font-size": "12px",
        "font-weight": "600",
        margin: "0 0 8px"
      });
      wrap.appendChild(progressLabelText);

      const progressTrack = document.createElement("div");
      applyStyles(progressTrack, {
        width: "100%",
        height: "6px",
        background: "rgba(255,255,255,0.12)",
        "border-radius": "999px",
        overflow: "hidden",
        margin: "0 0 14px"
      });

      const progressBar = document.createElement("div");
      progressBar.id = "__sb_guided_progress_bar";
      applyStyles(progressBar, {
        width: `${Math.max(6, Math.min(100, Number(presentation.progressPercent) || 0))}%`,
        height: "100%",
        background: "linear-gradient(90deg, #f4c26b 0%, #f5e3aa 100%)",
        "border-radius": "999px",
        transition: "width 180ms ease"
      });
      progressTrack.appendChild(progressBar);
      wrap.appendChild(progressTrack);

      const planLabel = document.createElement("div");
      planLabel.textContent = "Next AI Action";
      applyStyles(planLabel, {
        color: "rgba(226, 232, 240, 0.78)",
        "font-size": "10px",
        "font-weight": "800",
        "letter-spacing": "0.08em",
        "text-transform": "uppercase",
        margin: "0 0 6px"
      });
      wrap.appendChild(planLabel);

      const planBox = document.createElement("div");
      planBox.id = "__sb_guided_plan";
      planBox.textContent = actionPreview;
      applyStyles(planBox, {
        margin: "0 0 12px",
        padding: "9px 10px",
        background: "rgba(255,255,255,0.06)",
        color: "#e8f0f8",
        border: "1px solid rgba(255,255,255,0.08)",
        "border-radius": "10px",
        "font-size": "12px",
        "line-height": "1.35",
        "font-weight": "600",
        "word-break": "break-word"
      });
      wrap.appendChild(planBox);

      const essaySection = document.createElement("div");
      applyStyles(essaySection, {
        margin: "0 0 12px",
        padding: "8px 9px",
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.08)",
        "border-radius": "10px"
      });
      const essayHeader = document.createElement("div");
      applyStyles(essayHeader, {
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        gap: "8px",
        margin: "0"
      });
      const essayLabel = document.createElement("div");
      essayLabel.textContent = "Essay Assistant";
      applyStyles(essayLabel, {
        color: "rgba(226, 232, 240, 0.78)",
        "font-size": "10px",
        "font-weight": "800",
        "letter-spacing": "0.08em",
        "text-transform": "uppercase"
      });
      essayHeader.appendChild(essayLabel);
      const essayToggle = document.createElement("button");
      essayToggle.type = "button";
      essayToggle.id = "__sb_guided_essay_toggle";
      essayToggle.textContent = "Show";
      essayToggle.setAttribute("aria-expanded", "false");
      applyStyles(essayToggle, {
        border: "1px solid rgba(255,255,255,0.15)",
        padding: "4px 8px",
        "border-radius": "999px",
        "font-size": "10px",
        "font-weight": "800",
        "letter-spacing": "0.04em",
        "text-transform": "uppercase",
        background: "rgba(255,255,255,0.06)",
        color: "#e8f0f8",
        cursor: "pointer"
      });
      essayHeader.appendChild(essayToggle);
      essaySection.appendChild(essayHeader);

      const essayContent = document.createElement("div");
      essayContent.id = "__sb_guided_essay_content";
      applyStyles(essayContent, {
        display: "none",
        "margin-top": "8px"
      });
      essaySection.appendChild(essayContent);
      wrap.appendChild(essaySection);

      const essayPromptInput = document.createElement("textarea");
      essayPromptInput.id = "__sb_guided_essay_prompt";
      essayPromptInput.value = String(essayPrompt || "");
      essayPromptInput.placeholder = "Paste essay prompt/question...";
      applyStyles(essayPromptInput, {
        width: "100%",
        "min-height": "64px",
        margin: "0 0 8px",
        padding: "8px 10px",
        background: "rgba(255,255,255,0.08)",
        color: "#e8f0f8",
        border: "1px solid rgba(255,255,255,0.10)",
        "border-radius": "10px",
        "font-size": "12px",
        "line-height": "1.35",
        resize: "vertical",
        "box-sizing": "border-box"
      });
      essayContent.appendChild(essayPromptInput);

      const essayDraftBox = document.createElement("textarea");
      essayDraftBox.id = "__sb_guided_essay_draft";
      essayDraftBox.placeholder = "Draft will appear here. You can edit before input.";
      essayDraftBox.value = String(essayDraft || "");
      applyStyles(essayDraftBox, {
        width: "100%",
        "min-height": "92px",
        margin: "0 0 8px",
        padding: "8px 10px",
        background: "rgba(255,255,255,0.08)",
        color: "#e8f0f8",
        border: "1px solid rgba(255,255,255,0.10)",
        "border-radius": "10px",
        "font-size": "12px",
        "line-height": "1.35",
        resize: "vertical",
        "box-sizing": "border-box"
      });
      essayContent.appendChild(essayDraftBox);

      const essayActions = document.createElement("div");
      applyStyles(essayActions, {
        display: "grid",
        "grid-template-columns": "1fr 1fr",
        gap: "6px",
        margin: "0 0 10px"
      });
      const makeEssayBtn = (text) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        applyStyles(b, {
          width: "100%",
          border: "1px solid rgba(255,255,255,0.14)",
          padding: "8px 10px",
          "border-radius": "10px",
          cursor: "pointer",
          "font-size": "11px",
          "font-weight": "800",
          "letter-spacing": "0.04em",
          "text-transform": "uppercase",
          background: "rgba(255,255,255,0.08)",
          color: "#e8f0f8"
        });
        return b;
      };
      const draftEssayBtn = makeEssayBtn("Draft Essay");
      const inputEssayBtn = makeEssayBtn("Input Essay");
      const copyEssayBtn = makeEssayBtn("Copy Essay");
      const skipEssayBtn = makeEssayBtn("Continue");
      essayActions.appendChild(draftEssayBtn);
      essayActions.appendChild(inputEssayBtn);
      essayActions.appendChild(copyEssayBtn);
      essayActions.appendChild(skipEssayBtn);
      essayContent.appendChild(essayActions);

      const essayStatus = document.createElement("div");
      essayStatus.id = "__sb_guided_essay_status";
      essayStatus.textContent = "Use essay assistant when needed.";
      applyStyles(essayStatus, {
        color: "rgba(226, 232, 240, 0.78)",
        "font-size": "11px",
        "line-height": "1.35",
        margin: "0 0 10px"
      });
      essayContent.appendChild(essayStatus);

      const setEssayStatus = (text, isError = false) => {
        essayStatus.textContent = text;
        essayStatus.style.setProperty("color", isError ? "#f4a6a6" : "rgba(226, 232, 240, 0.78)", "important");
      };
      const setEssayOpenLocal = (open) => {
        const expanded = Boolean(open);
        essayContent.style.setProperty("display", expanded ? "block" : "none", "important");
        essayToggle.textContent = expanded ? "Hide" : "Show";
        essayToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
        window.__sbEssayExpanded = expanded;
      };
      essayToggle.addEventListener("click", () => {
        window.__sbEssayUserSet = true;
        setEssayOpenLocal(!Boolean(window.__sbEssayExpanded));
      });
      if (window.__sbEssayUserSet) {
        setEssayOpenLocal(Boolean(window.__sbEssayExpanded));
      } else {
        setEssayOpenLocal(Boolean(String(essayPrompt || "").trim()));
      }

      draftEssayBtn.addEventListener("click", async () => {
        const prompt = String(essayPromptInput.value || "").trim();
        if (!prompt || prompt.length < 10) {
          setEssayStatus("Provide essay prompt first.", true);
          return;
        }
        if (typeof window.__sbEssayDraft !== "function") {
          setEssayStatus("Essay draft unavailable.", true);
          return;
        }
        try {
          draftEssayBtn.disabled = true;
          draftEssayBtn.textContent = "Drafting...";
          setEssayStatus("Generating essay draft...");
          const result = await window.__sbEssayDraft(prompt);
          const essay = String(result?.essay || "").trim();
          if (!essay) {
            setEssayStatus("Draft came back empty.", true);
            return;
          }
          essayDraftBox.value = essay;
          setEssayStatus(`Draft ready (${Number(result?.wordCount || 0)} words).`);
        } catch (error) {
          setEssayStatus(`Draft failed: ${String(error?.message || error)}`, true);
        } finally {
          draftEssayBtn.disabled = false;
          draftEssayBtn.textContent = "Draft Essay";
        }
      });

      inputEssayBtn.addEventListener("click", async () => {
        const essay = String(essayDraftBox.value || "").trim();
        const prompt = String(essayPromptInput.value || "").trim();
        if (!essay) {
          setEssayStatus("Draft text is empty.", true);
          return;
        }
        if (typeof window.__sbEssayApply !== "function") {
          setEssayStatus("Essay apply unavailable.", true);
          return;
        }
        try {
          inputEssayBtn.disabled = true;
          inputEssayBtn.textContent = "Applying...";
          setEssayStatus("Applying essay to page...");
          const result = await window.__sbEssayApply({ essay, prompt });
          if (result?.statusText) {
            setStatus(result.statusText);
          }
          if (result?.debugText) {
            setDebug(result.debugText);
          }
          setEssayStatus(result?.appliedCount > 0
            ? `Essay applied to ${Number(result.appliedCount)} target(s).`
            : "No essay target detected; copied draft and continue manually.");
        } catch (error) {
          setEssayStatus(`Input failed: ${String(error?.message || error)}`, true);
        } finally {
          inputEssayBtn.disabled = false;
          inputEssayBtn.textContent = "Input Essay";
        }
      });

      copyEssayBtn.addEventListener("click", async () => {
        const essay = String(essayDraftBox.value || "").trim();
        if (!essay) {
          setEssayStatus("No draft text to copy.", true);
          return;
        }
        try {
          await navigator.clipboard.writeText(essay);
          setEssayStatus("Essay copied.");
        } catch (error) {
          setEssayStatus(`Copy failed: ${String(error?.message || error)}`, true);
        }
      });

      skipEssayBtn.addEventListener("click", () => {
        setEssayStatus("Continuing without essay autofill.");
      });

      const debugLabel = document.createElement("div");
      debugLabel.textContent = "Session Notes";
      applyStyles(debugLabel, {
        color: "rgba(226, 232, 240, 0.8)",
        "font-size": "11px",
        "font-weight": "800",
        "letter-spacing": "0.08em",
        "text-transform": "uppercase",
        margin: "0 0 6px"
      });
      wrap.appendChild(debugLabel);

      const debugBox = document.createElement("pre");
      debugBox.id = "__sb_guided_debug";
      debugBox.textContent = debugText;
      applyStyles(debugBox, {
        margin: "0 0 12px",
        padding: "10px 12px",
        background: "rgba(255,255,255,0.08)",
        color: "#e8f0f8",
        border: "1px solid rgba(255,255,255,0.08)",
        "border-radius": "10px",
        "font-family": "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        "font-size": "11px",
        "line-height": "1.45",
        "white-space": "pre-wrap",
        "word-break": "break-word",
        "max-height": "118px",
        "overflow-y": "auto"
      });
      wrap.appendChild(debugBox);

      const row = document.createElement("div");
      applyStyles(row, {
        display: "flex",
        "flex-direction": "column",
        gap: "8px"
      });

      const nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.textContent = "Approve & Next Page";
      applyStyles(nextBtn, {
        width: "100%",
        border: "none",
        padding: "12px 14px",
        "border-radius": "12px",
        cursor: "pointer",
        "font-size": "13px",
        "font-weight": "800",
        "letter-spacing": "0.04em",
        "text-transform": "uppercase",
        background: "#133a69",
        color: "#ffffff",
        border: "1px solid rgba(255,255,255,0.08)",
        "box-shadow": "inset 0 -1px 0 rgba(255,255,255,0.06)"
      });
      nextBtn.disabled = !Boolean(canAdvance);
      if (nextBtn.disabled) {
        applyStyles(nextBtn, {
          opacity: "0.55",
          cursor: "not-allowed"
        });
      } else {
        nextBtn.style.cursor = "pointer";
      }

      const refillBtn = document.createElement("button");
      refillBtn.type = "button";
      refillBtn.textContent = "Retry Autofill with AI";
      applyStyles(refillBtn, {
        width: "100%",
        border: "1px solid rgba(230, 238, 246, 0.8)",
        padding: "11px 14px",
        "border-radius": "12px",
        cursor: "pointer",
        "font-size": "13px",
        "font-weight": "800",
        "letter-spacing": "0.04em",
        "text-transform": "uppercase",
        background: "rgba(255,255,255,0.96)",
        color: "#15365c"
      });

      nextBtn.addEventListener("click", async () => {
        if (nextBtn.disabled) return;
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

      row.appendChild(nextBtn);
      refillBtn.addEventListener("click", async () => {
        try {
          setStatus("Retrying AI autofill...");
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
      row.appendChild(refillBtn);

      const manualBtn = document.createElement("button");
      manualBtn.type = "button";
      manualBtn.setAttribute("data-guided-manual-action", "1");
      manualBtn.textContent = Boolean(manualRequested) ? "Manual selection requested" : "Select Manually";
      applyStyles(manualBtn, {
        width: "100%",
        border: "1px solid rgba(255, 214, 133, 0.9)",
        padding: "11px 14px",
        "border-radius": "12px",
        cursor: "pointer",
        "font-size": "13px",
        "font-weight": "800",
        "letter-spacing": "0.04em",
        "text-transform": "uppercase",
        background: "rgba(255, 214, 133, 0.12)",
        color: "#ffd686"
      });
      manualBtn.addEventListener("click", async () => {
        try {
          if (typeof window.__sbManualAction === "function") {
            await window.__sbManualAction();
          }
          if (typeof setStatus === "function") {
            setStatus("Manual selection requested. AI will pause this step and resume after any page change.");
          }
          manualBtn.textContent = "Manual selection requested";
        } catch (error) {
          setStatus(`Manual select failed: ${String(error?.message || error)}`);
        }
      });
      row.appendChild(manualBtn);
      wrap.appendChild(row);

      const stopBtn = document.createElement("button");
      stopBtn.type = "button";
      stopBtn.textContent = "Stop Guided Session";
      applyStyles(stopBtn, {
        width: "100%",
        border: "none",
        padding: "8px 12px",
        background: "transparent",
        color: "#f4a6a6",
        cursor: "pointer",
        "font-size": "11px",
        "font-weight": "800",
        "letter-spacing": "0.08em",
        "text-transform": "uppercase",
        margin: "8px 0 0"
      });
      stopBtn.addEventListener("click", async () => {
        try {
          setStatus("Ending session...");
          if (typeof window.__sbStop === "function") {
            const result = await window.__sbStop();
            if (result?.closed) {
              setStatus("Session stopped.");
              setDebug("Guided session closed. You can return to the main app.");
            } else {
              setStatus(`Stop failed: ${String(result?.reason || "unknown")}`);
            }
          } else {
            setStatus("Stop unavailable");
          }
        } catch (error) {
          setStatus(`Stop failed: ${String(error?.message || error)}`);
        }
      });
      wrap.appendChild(stopBtn);

      const hint = document.createElement("div");
      hint.textContent = "Verified by Scholarship Autofill Assistant";
      applyStyles(hint, {
        color: "rgba(226, 232, 240, 0.72)",
        "font-size": "10px",
        "font-weight": "700",
        "letter-spacing": "0.06em",
        "text-transform": "uppercase",
        margin: "8px 0 0"
      });
      wrap.appendChild(hint);

      let dragState = null;
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const moveOverlay = (clientX, clientY) => {
        if (!dragState) return;
        const nextLeft = clamp(clientX - dragState.offsetX, 8, Math.max(8, window.innerWidth - wrap.offsetWidth - 8));
        const nextTop = clamp(clientY - dragState.offsetY, 8, Math.max(8, window.innerHeight - wrap.offsetHeight - 8));
        wrap.style.setProperty("left", `${nextLeft}px`, "important");
        wrap.style.setProperty("top", `${nextTop}px`, "important");
        wrap.style.setProperty("right", "auto", "important");
        wrap.style.setProperty("bottom", "auto", "important");
      };
      const endDrag = () => {
        dragState = null;
        document.removeEventListener("pointermove", onPointerMove, true);
        document.removeEventListener("pointerup", endDrag, true);
      };
      const onPointerMove = (event) => {
        moveOverlay(event.clientX, event.clientY);
      };
      headerRow.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        dragState = {
          offsetX: event.clientX - wrap.getBoundingClientRect().left,
          offsetY: event.clientY - wrap.getBoundingClientRect().top
        };
        document.addEventListener("pointermove", onPointerMove, true);
        document.addEventListener("pointerup", endDrag, true);
      });

      document.body.appendChild(wrap);
      const simpleOverlay = document.getElementById("__sb_guided_overlay_simple");
      if (simpleOverlay && simpleOverlay.parentElement) {
        simpleOverlay.remove();
      }
      return { ok: true, phase: "rich-overlay-install" };
    }, {
      statusText,
      debugText,
      overlayVersion: GUIDED_OVERLAY_VERSION,
      presentation,
      stepNumber: Math.max(1, Number(session.stepNumber || 1)),
      actionPreview: String(session.aiActionPreview || "No planned AI action."),
      canAdvance,
      manualRequested,
      essayPrompt,
      essayDraft
    });
    let result = await renderRichOverlay();
    if (result?.ok === false) {
      const reasonText = String(result.reason || "");
      const isMountRace = /document\.body is null|document\.documentElement is null/i.test(reasonText);
      if (isMountRace) {
        await waitForOverlayMountPoint(page, 2200);
        result = await renderRichOverlay();
      }
    }
    if (result?.ok === false) {
      throw new Error(`${result.phase || "rich-overlay-install"}: ${result.reason || "unknown"} (${JSON.stringify(result.details || {})})`);
    }
  } catch (error) {
    session.overlayInstallError = error?.message || String(error);
    await ensureMinimalGuidedOverlay(page, statusText, debugText, canAdvance, manualRequested);
    logGuidedOverlayFailure(session, "rich-overlay-install-failed", error, {
      overlayStatus: session.overlayStatus,
      step: session.stepNumber,
      canAdvance
    });
    return;
  }
}

async function ensureMinimalGuidedOverlay(page, statusText = "Ready", debugText = "", canAdvance = false, manualRequested = false) {
  await page.evaluate(({ statusText, overlayVersion }) => {
    const mount = document.body || document.documentElement;
    if (!mount) return;
    const loadingTitle = "Loading Guided Controls...";
    const loadingDetail = statusText && statusText !== "Ready"
      ? String(statusText)
      : `guided (${overlayVersion})`;

    const styleId = "__sb_guided_overlay_simple_style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        @keyframes sbGuidedSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `;
      (document.head || mount).appendChild(style);
    }

    const existing = document.getElementById("__sb_guided_overlay_simple");
    if (existing && existing.parentElement) {
      const msg = existing.querySelector("[data-guided-simple-message]");
      const detail = existing.querySelector("[data-guided-simple-detail]");
      if (msg) msg.textContent = loadingTitle;
      if (detail) detail.textContent = loadingDetail;
      existing.style.setProperty("display", "block", "important");
      existing.style.setProperty("visibility", "visible", "important");
      return;
    }

    const wrap = document.createElement("div");
    wrap.id = "__sb_guided_overlay_simple";
    wrap.style.setProperty("position", "fixed", "important");
    wrap.style.setProperty("right", "16px", "important");
    wrap.style.setProperty("bottom", "16px", "important");
    wrap.style.setProperty("z-index", "2147483647", "important");
    wrap.style.setProperty("background", "rgba(10, 24, 39, 0.92)", "important");
    wrap.style.setProperty("color", "#fff", "important");
    wrap.style.setProperty("padding", "10px 12px", "important");
    wrap.style.setProperty("border-radius", "12px", "important");
    wrap.style.setProperty("border", "1px solid rgba(255,255,255,0.14)", "important");
    wrap.style.setProperty("box-shadow", "0 10px 26px rgba(0,0,0,0.28)", "important");
    wrap.style.setProperty("font-family", "\"Avenir Next\", Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif", "important");
    wrap.style.setProperty("width", "250px", "important");
    wrap.style.setProperty("max-width", "calc(100vw - 32px)", "important");
    wrap.style.setProperty("display", "block", "important");
    wrap.style.setProperty("visibility", "visible", "important");
    wrap.style.setProperty("pointer-events", "none", "important");
    wrap.style.setProperty("user-select", "none", "important");

    const row = document.createElement("div");
    row.style.setProperty("display", "flex", "important");
    row.style.setProperty("align-items", "center", "important");
    row.style.setProperty("gap", "9px", "important");

    const spinner = document.createElement("div");
    spinner.style.setProperty("width", "14px", "important");
    spinner.style.setProperty("height", "14px", "important");
    spinner.style.setProperty("border-radius", "50%", "important");
    spinner.style.setProperty("border", "2px solid rgba(255,255,255,0.25)", "important");
    spinner.style.setProperty("border-top-color", "#ffffff", "important");
    spinner.style.setProperty("animation", "sbGuidedSpin 0.85s linear infinite", "important");
    spinner.style.setProperty("flex-shrink", "0", "important");
    row.appendChild(spinner);

    const copy = document.createElement("div");
    copy.style.setProperty("display", "flex", "important");
    copy.style.setProperty("flex-direction", "column", "important");
    copy.style.setProperty("min-width", "0", "important");

    const message = document.createElement("div");
    message.setAttribute("data-guided-simple-message", "1");
    message.style.setProperty("font-size", "12px", "important");
    message.style.setProperty("font-weight", "700", "important");
    message.style.setProperty("line-height", "1.2", "important");
    message.style.setProperty("white-space", "nowrap", "important");
    message.style.setProperty("overflow", "hidden", "important");
    message.style.setProperty("text-overflow", "ellipsis", "important");
    message.textContent = loadingTitle;
    copy.appendChild(message);

    const detail = document.createElement("div");
    detail.setAttribute("data-guided-simple-detail", "1");
    detail.style.setProperty("font-size", "10px", "important");
    detail.style.setProperty("font-weight", "600", "important");
    detail.style.setProperty("opacity", "0.76", "important");
    detail.style.setProperty("margin-top", "2px", "important");
    detail.style.setProperty("white-space", "nowrap", "important");
    detail.style.setProperty("overflow", "hidden", "important");
    detail.style.setProperty("text-overflow", "ellipsis", "important");
    detail.textContent = loadingDetail;
    copy.appendChild(detail);

    row.appendChild(copy);
    wrap.appendChild(row);
    mount.appendChild(wrap);
  }, {
    statusText: String(statusText || ""),
    overlayVersion: GUIDED_OVERLAY_VERSION
  });
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install playwright && npx playwright install chromium");
  }
}

function attachGuidedPageListeners(session, page) {
  installGuidedLoggingListeners(page, session);
  page.setDefaultTimeout(25000);
  page.on("framenavigated", async (frame) => {
    if (frame === page.mainFrame() && session.page === page) {
      if (hasManualResumeRequested(session)) {
        session.manualActionRequested = false;
        session.manualResumeRequested = false;
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
            : "Manual page selection was used. AI resumed autofill on the current page."
        };
        rememberOverlayState(session, summary, "Manual selection page handoff");
        await installInPageControls(session);
        return;
      }
      await refreshOverlayStateForCurrentPage(session, "Page changed");
    }
  });
}

async function clearManualRequestedState(session, { refresh = true, fallbackStatus = "Manual selection applied" } = {}) {
  if (!session || typeof session !== "object") return;
  const hadManualFlags = Boolean(session.manualResumeRequested || session.manualActionRequested);
  session.manualResumeRequested = false;
  session.manualActionRequested = false;
  const existing = session.lastFillDiagnostics && typeof session.lastFillDiagnostics === "object"
    ? session.lastFillDiagnostics
    : { filledCount: 0, debugEntries: [] };
  const existingEntries = Array.isArray(existing.debugEntries) ? existing.debugEntries : [];
  const markerReason = "manual-input-detected-state-reset";
  const alreadyNoted = existingEntries.some((entry) => String(entry?.reason || "") === markerReason);
  if (!alreadyNoted) {
    const marker = {
      fieldLabel: "(manual input)",
      method: "manual-detected",
      success: true,
      reason: markerReason,
      candidateValue: "",
      finalValue: "manual state cleared"
    };
    session.lastFillDiagnostics = {
      filledCount: Number(existing.filledCount || 0),
      debugEntries: [...existingEntries, marker].slice(-150)
    };
  }
  if (!hadManualFlags && !refresh) return;
  if (refresh) {
    await setInPagePlanText(session, "No planned AI action.");
    await refreshOverlayStateForCurrentPage(session, fallbackStatus);
  }
}

async function clickApplyStart(page, context = null) {
  const popupPromise = context
    ? context.waitForEvent("page", { timeout: 9000 }).catch(() => null)
    : Promise.resolve(null);
  let clicked = false;
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts && !clicked; attempt += 1) {
    for (const frame of allFrames(page)) {
      try {
        const frameClicked = await frame.evaluate(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };

        const getText = (el) => {
          const parts = [
            el?.innerText,
            el?.textContent,
            el?.value,
            el?.getAttribute?.("aria-label"),
            el?.getAttribute?.("title")
          ];
          return String(parts.find((value) => String(value || "").trim()) || "").trim().toLowerCase();
        };

        const candidates = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button'], [onclick]"))
          .filter((el) => visible(el))
          .map((el) => {
            const text = getText(el);
            const cursor = String(window.getComputedStyle(el).cursor || "").toLowerCase();
            let score = 0;
            if (/(quick apply|apply now|start application|begin application|continue application)/.test(text)) score += 9;
            if (/\bapply\b/.test(text)) score += 6;
            if (/(start here|continue)/.test(text)) score += 2;
            if (cursor === "pointer") score += 1;
            if (/(apply filters|filter|learn more|contact|donate|newsletter)/.test(text)) score -= 8;
            return { el, score };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);

        if (!candidates.length) return false;
        candidates[0].el.click();
        return true;
        });
        if (frameClicked) {
          clicked = true;
          break;
        }
      } catch {
        // ignore frame-level click errors
      }
    }
    if (!clicked && attempt < maxAttempts - 1) {
      await page.waitForTimeout(700);
    }
  }

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
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };

        const text = String(document.body?.innerText || "").toLowerCase();
        const MARKETING_RE = /\b(newsletter|subscribe|subscription|mailing list|exclusive offers|promo(?:tional)? emails?|marketing emails?)\b/i;
        const isMarketingContainer = (el) => {
          if (!el) return false;
          const container = el.closest?.("form, section, article, aside, div");
          const blob = String(container?.innerText || el.innerText || "").toLowerCase().slice(0, 1000);
          return MARKETING_RE.test(blob);
        };
        const hasPasswordInput = Array.from(document.querySelectorAll("input[type='password']")).some((el) => visible(el));
        const hasEmailInput = Array.from(document.querySelectorAll("input[type='email']")).some((el) => visible(el));
        const hasAuthForm = Array.from(document.querySelectorAll("form[action*='login'], form[action*='signin'], form[action*='register'], form[action*='signup']")).some((el) => visible(el));
        const hasCaptcha = Boolean(
          document.querySelector("iframe[src*='captcha'], .g-recaptcha, [id*='captcha'], [class*='captcha']")
        );
        const hasNewsletterUi = Array.from(document.querySelectorAll("form, section, article, aside, div"))
          .some((el) => visible(el) && MARKETING_RE.test(String(el.innerText || "").toLowerCase().slice(0, 600)));

        const sanitizedText = text
          .replace(/\bsign up for (our )?(email )?newsletter\b/g, " ")
          .replace(/\bsubscribe to (our )?(email )?newsletter\b/g, " ")
          .replace(/\bjoin (our )?(email )?newsletter\b/g, " ")
          .replace(/\bsubscribe\b/g, " ");

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
        ].filter((rx) => rx.test(sanitizedText)).length;

        const accountButtons = Array.from(document.querySelectorAll("button, a, input[type='submit'], input[type='button']"))
          .filter((el) => visible(el))
          .map((el) => ({
            text: String((el.innerText || el.value || "").trim()).toLowerCase(),
            isMarketing: isMarketingContainer(el)
          }))
          .filter((entry) => entry.text && !entry.isMarketing)
          .map((entry) => entry.text)
          .filter((t) => /(sign in|log in|login|create account|sign up|register|continue with google|continue with microsoft|continue with apple)/.test(t))
          .slice(0, 6);

        const applicationButtons = Array.from(document.querySelectorAll("button, a, input[type='submit'], input[type='button']"))
          .filter((el) => visible(el))
          .map((el) => String((el.innerText || el.value || "").trim()).toLowerCase())
          .filter(Boolean)
          .filter((t) => /(apply|quick apply|start application|begin application|continue application)/.test(t))
          .slice(0, 6);

        const score = Number(hasPasswordInput) * 3
          + Number(hasAuthForm) * 3
          + Number(hasEmailInput && hasPasswordInput) * 2
          + Number(hasCaptcha) * 2
          + authTextHits;

        const hasActionableAuthUi = hasPasswordInput
          || hasAuthForm
          || hasCaptcha
          || (hasEmailInput && accountButtons.length > 0)
          || accountButtons.length >= 2;

        const accountRequired = hasActionableAuthUi && (
          score >= 3
          || (accountButtons.length > 0 && authTextHits > 0)
        ) && !(applicationButtons.length > 0 && !hasActionableAuthUi) && !(
          hasNewsletterUi
          && !hasPasswordInput
          && !hasAuthForm
          && accountButtons.length === 0
        );

        return {
          score,
          accountRequired,
          hasPasswordInput,
          hasEmailInput,
          hasAuthForm,
          hasCaptcha,
          authTextHits,
          hasNewsletterUi,
          accountButtons,
          applicationButtons,
          hasActionableAuthUi,
          sample: text.slice(0, 800)
        };
      });
      frameSignals.push({ frameUrl: frame.url(), ...signal });
    } catch {
      // ignore single-frame failures
    }
  }

  const best = frameSignals.sort((a, b) => b.score - a.score)[0] || null;
  const hasApplyEntryPoint = frameSignals.some((signal) => (signal?.applicationButtons || []).length > 0);
  const hasHardAuthWall = frameSignals.some((signal) =>
    Boolean(signal?.hasPasswordInput || signal?.hasAuthForm || signal?.hasCaptcha)
  );
  const accountRequired = Boolean(best?.accountRequired) && !(hasApplyEntryPoint && !hasHardAuthWall);
  const reasons = [];
  if (best?.hasPasswordInput) reasons.push("password field detected");
  if (best?.hasAuthForm) reasons.push("auth form detected");
  if (best?.hasCaptcha) reasons.push("captcha detected");
  if ((best?.authTextHits || 0) > 0 && best?.hasActionableAuthUi) reasons.push("login/signup language detected");
  if ((best?.accountButtons || []).length > 0) reasons.push("account action button detected");
  if (hasApplyEntryPoint && !hasHardAuthWall) reasons.push("apply action detected on page");

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
    const isNewsletterLike = (node, textBlob = "") => {
      const marketingRe = /\b(newsletter|subscribe|subscription|mailing list|exclusive offers|updates|promo(?:tional)? emails?|marketing emails?)\b/i;
      const text = String(textBlob || "").toLowerCase();
      if (marketingRe.test(text)) return true;
      const container = node?.closest?.("form, section, article, aside, div");
      const containerText = String(container?.innerText || "").toLowerCase().slice(0, 1200);
      const formAction = String(container?.getAttribute?.("action") || "").toLowerCase();
      return marketingRe.test(containerText) || /(newsletter|subscribe|mailchimp|klaviyo)/.test(formAction);
    };
    const isEssayLikeField = (textBlob = "") => {
      const text = String(textBlob || "").toLowerCase();
      if (!text.trim()) return false;
      if (/(newsletter|subscribe|marketing|promo|coupon|feedback|comment|captcha|search|login|password)/.test(text)) return false;
      return /(essay|personal statement|short answer|long answer|essay response|response statement|word limit|minimum words?|essay\d+|personal_statement)/.test(text);
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
	      if (/(still in high school|currently in high school|are you.*high school|in high school\?)/.test(joined)) {
	        const explicit = normalizeBinaryChoice(
	          normalized.get("academics inhighschool")
	          || normalized.get("academics in high school")
	          || normalized.get("in high school")
	          || normalized.get("currently in high school")
	          || ""
	        );
	        if (explicit) return explicit;
	        const studentStage = normalizeText(
	          normalized.get("student_stage")
	          || normalized.get("student stage")
	          || normalized.get("studentstage")
	          || normalized.get("stage")
	          || ""
	        );
	        const gradeLevel = normalizeText(
	          normalized.get("academics gradelevel")
	          || normalized.get("grade level")
	          || normalized.get("grade_level")
	          || ""
	        );
	        if (/(in college|continuing college|undergraduate|transfer|graduate|university)/.test(studentStage)) return "no";
	        if (/(starting college|incoming|high school)/.test(studentStage)) return "yes";
	        if (/(9th|10th|11th|12th|high school|senior|junior|sophomore|freshman)/.test(gradeLevel) && !/(college|undergraduate|university|graduate)/.test(gradeLevel)) {
	          return "yes";
	        }
	        if (/(college|undergraduate|university|graduate|transfer)/.test(gradeLevel)) return "no";
	        return "";
	      }
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
    const normalizeBinaryChoice = (rawValue) => {
      const text = normalizeText(String(rawValue || ""));
      if (!text) return "";
      if (/^(true|yes|y|1|on|checked)$/.test(text)) return "yes";
      if (/^(false|no|n|0|off|unchecked)$/.test(text)) return "no";
      if (/\b(yes|true)\b/.test(text) && !/\b(no|not|false)\b/.test(text)) return "yes";
      if (/\b(no|false)\b/.test(text)) return "no";
      return "";
    };
    const getRadioOptionDescriptor = (radio) => {
      if (!radio) return "";
      const id = String(radio.id || "").trim();
      const byFor = id ? (labelMap.get(id.toLowerCase()) || "") : "";
      const wrapped = radio.closest?.("label") ? String(radio.closest("label").textContent || "").trim() : "";
      return [
        byFor,
        wrapped,
        String(radio.getAttribute?.("aria-label") || "").trim(),
        String(radio.value || "").trim()
      ].filter(Boolean).join(" ");
    };
    const chooseRadioOption = (radioNode, rawValue) => {
      const target = normalizeText(String(rawValue || ""));
      if (!target) return { success: false, finalValue: "" };
      const desiredBinary = normalizeBinaryChoice(rawValue);
      const radioName = String(radioNode?.getAttribute?.("name") || "").trim();
      const group = radioName
        ? Array.from(document.querySelectorAll("input[type='radio']"))
          .filter((candidate) => String(candidate.getAttribute?.("name") || "") === radioName && !candidate.disabled)
        : [radioNode].filter(Boolean);

      const ranked = group
        .map((candidate) => {
          const descriptor = getRadioOptionDescriptor(candidate);
          const optionText = normalizeText(descriptor);
          const optionValue = normalizeText(String(candidate.value || ""));
          const booleanHint = `${optionText} ${optionValue}`.trim();
          let score = 0;
          if (optionValue === target || optionText === target) score += 14;
          if (optionText.includes(target) || target.includes(optionText) || optionValue.includes(target) || target.includes(optionValue)) score += 8;
          if (desiredBinary === "yes") {
            if (/\b(yes|true|1|on)\b/.test(booleanHint)) score += 10;
            if (/\b(no|false|0|off)\b/.test(booleanHint)) score -= 4;
          } else if (desiredBinary === "no") {
            if (/\b(no|false|0|off)\b/.test(booleanHint)) score += 10;
            if (/\b(yes|true|1|on)\b/.test(booleanHint)) score -= 4;
          }
          return { candidate, descriptor, score };
        })
        .sort((a, b) => b.score - a.score || a.descriptor.length - b.descriptor.length);

      const best = ranked[0];
      if (!best || best.score <= 0 || !best.candidate) {
        return { success: false, finalValue: String(radioNode?.value || "") };
      }

      const candidate = best.candidate;
      const candidateId = String(candidate.id || "").trim();
      const forLabel = candidateId
        ? Array.from(document.querySelectorAll("label[for]"))
          .find((label) => String(label.getAttribute("for") || "").trim().toLowerCase() === candidateId.toLowerCase())
        : null;
      const wrappedLabel = candidate.closest?.("label") || null;
      const clickTarget = (forLabel && visible(forLabel))
        ? forLabel
        : ((wrappedLabel && visible(wrappedLabel)) ? wrappedLabel : candidate);
      clickTarget.scrollIntoView({ block: "center", inline: "nearest" });
      triggerMouseClick(clickTarget);
      best.candidate.checked = true;
      best.candidate.dispatchEvent(new Event("input", { bubbles: true }));
      best.candidate.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: Boolean(best.candidate.checked), finalValue: String(best.descriptor || best.candidate.value || "").trim() };
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

    const inferStudentStageChoices = () => {
      const stage = normalizeText(
        String(
          normalized.get("student_stage")
          || normalized.get("student stage")
          || normalized.get("studentstage")
          || normalized.get("stage")
          || ""
        )
      );
      const gradeLevel = normalizeText(
        String(
          normalized.get("academics gradelevel")
          || normalized.get("grade level")
          || normalized.get("grade_level")
          || ""
        )
      );

      if (/(graduate|phd|doctorate|masters)/.test(stage) || /graduate/.test(gradeLevel)) {
        return ["graduate student", "four year college undergraduate"];
      }
      if (/transfer/.test(stage)) {
        return ["community college student", "four year college undergraduate"];
      }
      if (/(continuing college|in college|undergraduate)/.test(stage)) {
        return ["four year college undergraduate", "community college student"];
      }
      if (/(starting college|about to start college|incoming|high school|freshman)/.test(stage)) {
        return ["high school student", "four year college undergraduate"];
      }
      if (/(12th|11th|10th|9th|high school|senior|junior|sophomore)/.test(gradeLevel)) {
        return ["high school student", "four year college undergraduate"];
      }
      return [];
    };

    const clickStudentStageChoiceCard = async () => {
      const pageText = normalizeText(String(document.body?.innerText || ""));
      if (!/(best describes you|current degree|education level|which describes you|which best describes)/.test(pageText)) {
        return null;
      }

      const preferred = inferStudentStageChoices();
      if (!preferred.length) return null;
      const preferredSet = new Set(preferred.map((value) => normalizeText(value)));

      const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], [onclick], div"))
        .filter((el) => visible(el))
        .map((el) => {
          const tag = String(el.tagName || "").toLowerCase();
          const role = String(el.getAttribute?.("role") || "").toLowerCase();
          const text = normalizeText(el.innerText || el.textContent || el.getAttribute?.("aria-label") || "");
          const rawText = String(el.innerText || el.textContent || el.getAttribute?.("aria-label") || "").trim();
          if (!text || rawText.length > 90) return null;

          const isInteractive = tag === "button"
            || tag === "a"
            || role === "button"
            || typeof el.onclick === "function"
            || Number(el.tabIndex || -1) >= 0;
          if (!isInteractive) return null;

          if (!/(high school student|community college student|four year college undergraduate|graduate student|undergraduate)/.test(text)) {
            return null;
          }

          let score = 0;
          for (let i = 0; i < preferred.length; i += 1) {
            const pref = normalizeText(preferred[i]);
            const weight = Math.max(1, 8 - i * 2);
            if (text === pref) score += weight + 6;
            else if (text.includes(pref) || pref.includes(text)) score += weight + 3;
          }
          if (preferredSet.has(text)) score += 4;
          if (text.includes("high school")) score += preferredSet.has("high school student") ? 2 : 0;
          if (text.includes("community college")) score += preferredSet.has("community college student") ? 2 : 0;
          if (text.includes("four year college")) score += preferredSet.has("four year college undergraduate") ? 2 : 0;
          if (text.includes("graduate")) score += preferredSet.has("graduate student") ? 2 : 0;
          return { el, text, rawText, score };
        })
        .filter(Boolean)
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.rawText.length - b.rawText.length);

      if (!candidates.length) return null;

      const best = candidates[0];
      best.el.scrollIntoView({ block: "center", inline: "nearest" });
      triggerMouseClick(best.el);
      await sleep(120);
      return best.rawText;
    };

    const clickedStageChoice = await clickStudentStageChoiceCard();
    if (clickedStageChoice) {
      return {
        filledCount: 1,
        debugEntries: [
          {
            fieldLabel: "Current degree / student stage",
            keys: ["student_stage", "stage", "academics.gradeLevel"],
            tag: "button",
            type: "choice",
            method: "choice-card",
            success: true,
            finalValue: String(clickedStageChoice).slice(0, 120)
          }
        ]
      };
    }

    const clickGenderChoiceCard = async () => {
      const pageText = normalizeText(String(document.body?.innerText || ""));
      if (!/(what s your gender|your gender|select your gender|gender identity)/.test(pageText)) {
        return null;
      }

      const normalizeGenderValue = (value) => {
        const v = normalizeText(String(value || ""));
        if (v === "m" || v === "m.") return "male";
        if (v === "f" || v === "f.") return "female";
        if (v === "male" || v === "man" || v === "boy" || /\\b(male|man|boy)\\b/.test(v)) return "male";
        if (v === "female" || v === "woman" || v === "girl" || /\\b(female|woman|girl|gal)\\b/.test(v)) return "female";
        if (/(non binary|nonbinary|nb|genderqueer|agender|non con|nonconforming|non-binary)/.test(v)) return "non binary";
        if (/(prefer not to say|decline|skip|no thanks)/.test(v)) return "prefer not to say";
        if (/(male|female|non binary|nonbinary|prefer not to say|decline|skip)/.test(v)) return v;
        return "";
      };

      const rawGender = normalizeText(
        String(
          normalized.get("personalinfo gender")
          || normalized.get("personal info gender")
          || normalized.get("personalInfo.gender")
          || normalized.get("gender")
          || normalized.get("sex")
          || ""
        )
      );

      const hasKnownGenderProfile = Boolean(rawGender);
      let preferred = hasKnownGenderProfile ? normalizeGenderValue(rawGender) || rawGender : "prefer not to say";
      let fallbackPreferNotToSay = !hasKnownGenderProfile;
      if (hasKnownGenderProfile && !preferred) preferred = rawGender;

      const allowPreferNotToSay = fallbackPreferNotToSay || preferred === "prefer not to say";

      const preferredNorm = normalizeText(preferred);
      const options = Array.from(document.querySelectorAll("button, a, [role='button'], [onclick], div"))
        .filter((el) => visible(el))
        .map((el) => {
          const tag = String(el.tagName || "").toLowerCase();
          const role = String(el.getAttribute?.("role") || "").toLowerCase();
          const rawText = String(el.innerText || el.textContent || el.getAttribute?.("aria-label") || "").trim();
          const text = normalizeText(rawText);
          if (!text || rawText.length > 70) return null;
          const isInteractive = tag === "button"
            || tag === "a"
            || role === "button"
            || typeof el.onclick === "function"
            || Number(el.tabIndex || -1) >= 0;
          if (!isInteractive) return null;

          let score = 0;
          if (hasKnownGenderProfile) {
            if (text === preferredNorm) score += 12;
            if (text.includes(preferredNorm) || preferredNorm.includes(text)) score += 6;
          } else {
            const raceOrGenderPattern = allowPreferNotToSay
              ? /(male|female|non binary|nonbinary|prefer not to say|decline)/
              : /(male|female|non binary|nonbinary)/;
            if (!raceOrGenderPattern.test(text)) return null;
            if (text === preferredNorm) score += 12;
            if (text.includes(preferredNorm) || preferredNorm.includes(text)) score += 6;
          }
          if (preferredNorm === "non binary" && /(non binary|nonbinary)/.test(text)) score += 8;

          if (!hasKnownGenderProfile && allowPreferNotToSay && score === 0) {
            return null;
          }
          if (hasKnownGenderProfile && score === 0) {
            return null;
          }
          return { el, rawText, text, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.rawText.length - b.rawText.length);

      if (!options.length || options[0].score <= 0) return null;
      const best = options[0];
      best.el.scrollIntoView({ block: "center", inline: "nearest" });
      triggerMouseClick(best.el);
      await sleep(120);
      return best.rawText;
    };

    const clickedGenderChoice = await clickGenderChoiceCard();
    if (clickedGenderChoice) {
      return {
        filledCount: 1,
        debugEntries: [
          {
            fieldLabel: "Gender",
            keys: ["gender", "sex", "personalInfo.gender"],
            tag: "button",
            type: "choice",
            method: "choice-card",
            success: true,
            finalValue: String(clickedGenderChoice).slice(0, 120)
          }
        ]
      };
    }

    const clickRaceChoiceCard = async () => {
      const pageText = normalizeText(String(document.body?.innerText || ""));
      if (!/(what is your race|what is your race\/ethnicity|race|ethnicity|racial|hispanic|latino)/.test(pageText)) {
        return null;
      }

      const normalizeRaceValue = (value) => {
        const v = normalizeText(String(value || ""));
        if (!v) return "";
        if (/(^|\\b)(aa|black|african american|african-american|africa|african)/.test(v)) return "black";
        if (/(^|\\b)(w|white|caucasian)/.test(v)) return "white";
        if (/(^|\\b)(a|asian)/.test(v)) return "asian";
        if (/(latino|latina|latinx|hispanic)/.test(v)) return "hispanic";
        if (/(indian|native american|native-american|nativ american|alaska native|american indian|native alaskan|aian)/.test(v)) return "native american";
        if (/(pacific|native hawaiian|polynesian|micronesian|guamanian|chamorro|samoan|islander)/.test(v)) return "native hawaiian pacific islander";
        if (/(two or more|multiple|multiracial|prefer not to say|decline|skip)/.test(v)) return v;
        return "";
      };

      const rawRace = normalizeText(
        String(
          normalized.get("personalinfo ethnicity")
          || normalized.get("personal info ethnicity")
          || normalized.get("ethnicity")
          || normalized.get("race")
          || normalized.get("racial identity")
          || ""
        )
      );
      const hasKnownRaceProfile = Boolean(rawRace);
      const profilePreferNotToSay = /^(prefer not to say|decline|do not want to say|skip)$/i.test(rawRace);
      const normalizedRace = hasKnownRaceProfile ? normalizeRaceValue(rawRace) : "";
      let preferred = hasKnownRaceProfile ? (normalizedRace || String(rawRace || "").trim()) : "prefer not to say";
      let fallbackPreferNotToSay = !hasKnownRaceProfile;
      if (profilePreferNotToSay) {
        fallbackPreferNotToSay = true;
        preferred = "prefer not to say";
      }

      const allowPreferNotToSay = fallbackPreferNotToSay || /^(prefer not to say|decline|do not want to say|skip)$/i.test(preferred);

      const preferredNorm = normalizeText(preferred);
      const options = Array.from(document.querySelectorAll("button, a, [role='button'], [onclick], div"))
        .filter((el) => visible(el))
        .map((el) => {
          const tag = String(el.tagName || "").toLowerCase();
          const role = String(el.getAttribute?.("role") || "").toLowerCase();
          const rawText = String(el.innerText || el.textContent || el.getAttribute?.("aria-label") || "").trim();
          const text = normalizeText(rawText);
          if (!text || rawText.length > 90) return null;
          const isInteractive = tag === "button"
            || tag === "a"
            || role === "button"
            || typeof el.onclick === "function"
            || Number(el.tabIndex || -1) >= 0;
          if (!isInteractive) return null;

          let score = 0;
          if (hasKnownRaceProfile) {
            if (text === preferredNorm) score += 12;
            if (text.includes(preferredNorm) || preferredNorm.includes(text)) score += 6;
          } else {
            const allowedPattern = allowPreferNotToSay
              ? /(asian|black|african|hispanic|latino|white|native|american|pacific|indian|native american|prefer not to say|decline)/
              : /(asian|black|african|hispanic|latino|white|native|american|pacific|indian)/;
            if (!allowedPattern.test(text)) return null;
            if (text === preferredNorm) score += 12;
            if (text.includes(preferredNorm) || preferredNorm.includes(text)) score += 6;
          }
          if (!hasKnownRaceProfile && allowPreferNotToSay && score === 0) return null;
          if (hasKnownRaceProfile && score === 0) return null;
          return { el, rawText, text, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.rawText.length - b.rawText.length);

      if (!options.length || options[0].score <= 0) return null;
      const best = options[0];
      best.el.scrollIntoView({ block: "center", inline: "nearest" });
      triggerMouseClick(best.el);
      await sleep(120);
      return best.rawText;
    };

    const clickedRaceChoice = await clickRaceChoiceCard();
    if (clickedRaceChoice) {
      return {
        filledCount: 1,
        debugEntries: [
          {
            fieldLabel: "Race / Ethnicity",
            keys: ["ethnicity", "race", "personalInfo.ethnicity"],
            tag: "button",
            type: "choice",
            method: "choice-card",
            success: true,
            finalValue: String(clickedRaceChoice).slice(0, 120)
          }
        ]
      };
    }

    const controls = Array.from(document.querySelectorAll("input, textarea, select, [role='combobox'], [contenteditable='true']"));
    let filledCount = 0;
    const debugEntries = [];
    const unmatchedEntries = [];
    const seenControls = new Set();
    const seenRadioGroups = new Set();
    for (const node of controls) {
      if (seenControls.has(node)) continue;
      seenControls.add(node);
      const nodeTag = String(node.tagName || "").toLowerCase();
      const nodeType = String(node.getAttribute?.("type") || "").toLowerCase();
      const isRadioControl = nodeTag === "input" && nodeType === "radio";
      if (!isRadioControl && !visible(node)) continue;
      if (node.disabled || (!isRadioControl && node.readOnly)) continue;

      const interactiveNode = resolveInteractiveNode(node) || node;
      const tag = String(interactiveNode.tagName || "").toLowerCase();
      const type = String(interactiveNode.getAttribute?.("type") || "").toLowerCase();
      const isRadioField = tag === "input" && type === "radio";
      if (!isRadioField && !visible(interactiveNode)) continue;
      if (interactiveNode.disabled || (!isRadioField && interactiveNode.readOnly)) continue;
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
      if (tag === "input" && type === "file") continue;
      const marketingDescriptor = [
        interactiveNode.getAttribute?.("aria-label"),
        interactiveNode.getAttribute?.("placeholder"),
        interactiveNode.getAttribute?.("name"),
        interactiveNode.id
      ].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
      if (isNewsletterLike(interactiveNode, marketingDescriptor)) {
        continue;
      }

      const keys = collectKeysForNode(node);
      if (type === "radio") {
        const radioGroupKey = normalizeText(
          String(
            interactiveNode.getAttribute?.("name")
            || interactiveNode.name
            || interactiveNode.id
            || keys.join(" ")
          )
        );
        if (radioGroupKey && seenRadioGroups.has(radioGroupKey)) {
          continue;
        }
        if (radioGroupKey) seenRadioGroups.add(radioGroupKey);
      }
      const fieldLabel = keys[2] || keys[3] || keys[1] || keys[0] || keys[4] || keys[5] || "(unlabeled)";
      const baseDebug = {
        fieldLabel: String(fieldLabel || "").trim(),
        keys: keys.slice(0, 6),
        tag,
        type,
        role: String(node.getAttribute?.("role") || interactiveNode.getAttribute?.("role") || "").toLowerCase(),
        placeholder: String(interactiveNode.getAttribute?.("placeholder") || "").trim()
      };
      const essayDescriptor = `${keys.join(" ")} ${interactiveNode.getAttribute?.("aria-label") || ""} ${interactiveNode.getAttribute?.("placeholder") || ""}`.trim();
      if (isEssayLikeField(essayDescriptor)) {
        unmatchedEntries.push({
          ...baseDebug,
          method: "skip",
          success: false,
          reason: "essay-autofill-disabled",
          finalValue: interactiveNode.isContentEditable
            ? String(interactiveNode.textContent || "").trim().slice(0, 120)
            : String(interactiveNode.value || "").trim().slice(0, 120)
        });
        continue;
      }
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
        const radioPick = chooseRadioOption(interactiveNode, value);
        debugEntries.push({
          ...attemptDebug,
          method: "radio",
          success: Boolean(radioPick?.success),
          finalValue: String(radioPick?.finalValue || "")
        });
        if (radioPick?.success) filledCount += 1;
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

    return { filledCount, debugEntries: [...debugEntries, ...unmatchedEntries].slice(0, 150) };
  }, payload);
}

async function fillVisibleFields(page, payload, { session = null } = {}) {
  const safePayload = buildEssaySafeAutofillPayload(payload);
  const deterministicFill = async () => {
    const frames = allFrames(page);
    let filledCount = 0;
    const debugEntries = [];
    for (const frame of frames) {
      try {
        const result = await fillVisibleFieldsInFrame(frame, safePayload);
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
    return {
      filledCount,
      debugEntries: debugEntries.slice(0, 150)
    };
  };

  if (GUIDED_FILL_STRATEGY === "ai_first") {
    const aiFirstResult = await runAiActionLoop(page, safePayload, {
      maxRounds: 5,
      session
    });
    if (Number(aiFirstResult?.filledCount || 0) > 0) {
      return aiFirstResult;
    }
    const aiFallbackResult = await applyAiFieldMapperFallback(page, safePayload, {
      filledCount: 0,
      debugEntries: []
    });
    if (Number(aiFallbackResult?.filledCount || 0) > 0) {
      return aiFallbackResult;
    }
    const deterministicResult = await deterministicFill();
    return {
      filledCount: Number(aiFallbackResult?.filledCount || 0) + Number(deterministicResult?.filledCount || 0),
      debugEntries: [
        ...(Array.isArray(aiFirstResult?.debugEntries) ? aiFirstResult.debugEntries : []),
        ...(Array.isArray(aiFallbackResult?.debugEntries) ? aiFallbackResult.debugEntries : []),
        ...(Array.isArray(deterministicResult?.debugEntries) ? deterministicResult.debugEntries : [])
      ].slice(0, 150)
    };
  }

  if (GUIDED_FILL_STRATEGY === "ai_only") {
    const aiOnlyResult = await runAiActionLoop(page, safePayload, {
      maxRounds: 5,
      session
    });
    if (Number(aiOnlyResult?.filledCount || 0) > 0) {
      return aiOnlyResult;
    }
    return await applyAiFieldMapperFallback(page, safePayload, aiOnlyResult);
  }

  const frames = allFrames(page);
  let filledCount = 0;
  const debugEntries = [];
  for (const frame of frames) {
    try {
      const result = await fillVisibleFieldsInFrame(frame, safePayload);
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

  const aiLoopResult = await runAiActionLoop(page, safePayload, {
    maxRounds: 2,
    session
  });
  if (Number(aiLoopResult?.filledCount || 0) > 0) {
    return {
      filledCount: Number(deterministicResult?.filledCount || 0) + Number(aiLoopResult?.filledCount || 0),
      debugEntries: [
        ...(Array.isArray(deterministicResult?.debugEntries) ? deterministicResult.debugEntries : []),
        ...(Array.isArray(aiLoopResult?.debugEntries) ? aiLoopResult.debugEntries : [])
      ].slice(0, 150)
    };
  }
  return await applyAiFieldMapperFallback(page, safePayload, deterministicResult);
}

async function applyEssayDraftToCurrentPage(page, essayText, promptText = "") {
  const essay = String(essayText || "").trim();
  if (!essay) return 0;
  const prompt = String(promptText || "").trim();
  const frames = allFrames(page);
  let appliedCount = 0;
  for (const frame of frames) {
    try {
      const frameCount = await frame.evaluate(({ essay, prompt }) => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const normalize = (value) => String(value || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        const labelMap = new Map();
        for (const label of document.querySelectorAll("label[for]")) {
          const id = String(label.getAttribute("for") || "").trim().toLowerCase();
          const text = String(label.textContent || "").trim();
          if (id && text) labelMap.set(id, text);
        }
        const isEssayHint = (text) => {
          const value = normalize(text);
          if (!value) return false;
          if (/(newsletter|subscribe|promo|marketing|coupon|feedback|comment|captcha|search|login|password)/.test(value)) {
            return false;
          }
          return /(essay|personal statement|short answer|long answer|word limit|minimum words?|tell us|describe|why do you|college|university|essay\d+)/.test(value);
        };
        const isStrictEssayFieldHint = (text) => {
          const value = normalize(text);
          if (!value) return false;
          return /(essay|personal statement|short answer|long answer|response|statement|essay\d+|personal_statement)/.test(value);
        };
        const setControlValue = (node, value) => {
          const proto = Object.getPrototypeOf(node);
          const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
          if (descriptor?.set) {
            descriptor.set.call(node, value);
          } else {
            node.value = value;
          }
        };
        const fireInputEvents = (node) => {
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
          node.dispatchEvent(new Event("blur", { bubbles: true }));
        };

        const controls = Array.from(document.querySelectorAll("textarea, [contenteditable='true'], input[type='text'], input:not([type])"));
        let count = 0;
        const promptLooksEssay = isEssayHint(prompt);
        for (const node of controls) {
          if (!visible(node)) continue;
          if (node.disabled || node.readOnly) continue;

          const tag = String(node.tagName || "").toLowerCase();
          const id = String(node.id || "").trim();
          const name = String(node.getAttribute?.("name") || "").trim();
          const placeholder = String(node.getAttribute?.("placeholder") || "").trim();
          const ariaLabel = String(node.getAttribute?.("aria-label") || "").trim();
          const byFor = id ? (labelMap.get(id.toLowerCase()) || "") : "";
          const wrapped = node.closest?.("label") ? String(node.closest("label").textContent || "").trim() : "";
          const legend = node.closest?.("fieldset")?.querySelector?.("legend")
            ? String(node.closest("fieldset").querySelector("legend").textContent || "").trim()
            : "";
          const descriptor = `${byFor} ${wrapped} ${legend} ${placeholder} ${ariaLabel} ${name} ${id}`;
          const rows = Number(node.getAttribute?.("rows") || 0);
          const maxLength = Number(node.getAttribute?.("maxlength") || 0);
          const longFormHint = rows >= 3 || (Number.isFinite(maxLength) && maxLength >= 180);
          const isTextInput = tag === "input";
          const matchesEssayDescriptor = isEssayHint(descriptor);
          const matchesStrictEssayDescriptor = isStrictEssayFieldHint(descriptor);
          if (!matchesEssayDescriptor && !(tag === "textarea" && longFormHint && promptLooksEssay)) {
            continue;
          }
          // Never write essay drafts into generic text inputs unless that input is explicitly essay-like.
          if (isTextInput && !matchesStrictEssayDescriptor) {
            continue;
          }

          if (tag === "textarea" || tag === "input") {
            setControlValue(node, essay);
            fireInputEvents(node);
            count += 1;
            continue;
          }
          if (node.isContentEditable) {
            node.textContent = essay;
            fireInputEvents(node);
            count += 1;
          }
        }
        return count;
      }, { essay, prompt });
      appliedCount += Number(frameCount || 0);
    } catch {
      // ignore per-frame errors
    }
  }
  return appliedCount;
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
    const isNewsletterLike = (node, textBlob = "") => {
      const marketingRe = /\b(newsletter|subscribe|subscription|mailing list|exclusive offers|updates|promo(?:tional)? emails?|marketing emails?)\b/i;
      const text = String(textBlob || "").toLowerCase();
      if (marketingRe.test(text)) return true;
      const container = node?.closest?.("form, section, article, aside, div");
      const containerText = String(container?.innerText || "").toLowerCase().slice(0, 1200);
      const formAction = String(container?.getAttribute?.("action") || "").toLowerCase();
      return marketingRe.test(containerText) || /(newsletter|subscribe|mailchimp|klaviyo)/.test(formAction);
    };
    const isEssayLikeField = (textBlob = "") => {
      const text = String(textBlob || "").toLowerCase();
      if (!text.trim()) return false;
      if (/(newsletter|subscribe|marketing|promo|coupon|feedback|comment|captcha|search|login|password)/.test(text)) return false;
      return /(essay|personal statement|short answer|long answer|essay response|response statement|word limit|minimum words?|essay\d+|personal_statement)/.test(text);
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
      const descriptor = `${label} ${placeholder} ${ariaLabel} ${name} ${id} ${prompt}`.trim();
      if (isNewsletterLike(interactiveNode, descriptor)) continue;
      const fieldDescriptor = `${label} ${placeholder} ${ariaLabel} ${name} ${id}`.trim();
      if (isEssayLikeField(fieldDescriptor)) continue;

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

async function extractAiActionElementsInFrame(frame) {
  return await frame.evaluate(() => {
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
    const isGuidedOverlayElement = (el) => Boolean(el?.closest?.("#__sb_guided_overlay"));
    const isNewsletterLike = (node, textBlob = "") => {
      const marketingRe = /\b(newsletter|subscribe|subscription|mailing list|exclusive offers|updates|promo(?:tional)? emails?|marketing emails?)\b/i;
      const text = String(textBlob || "").toLowerCase();
      if (marketingRe.test(text)) return true;
      const container = node?.closest?.("form, section, article, aside, div");
      const containerText = String(container?.innerText || "").toLowerCase().slice(0, 1200);
      return marketingRe.test(containerText);
    };
    const isEssayLikeField = (textBlob = "") => {
      const text = String(textBlob || "").toLowerCase();
      if (!text.trim()) return false;
      if (/(newsletter|subscribe|marketing|promo|coupon|feedback|comment|captcha|search|login|password)/.test(text)) return false;
      return /(essay|personal statement|short answer|long answer|essay response|response statement|word limit|minimum words?|essay\d+|personal_statement)/.test(text);
    };

    const labelMap = new Map();
    for (const label of document.querySelectorAll("label[for]")) {
      const id = String(label.getAttribute("for") || "").trim();
      const text = String(label.textContent || "").trim();
      if (id && text) labelMap.set(id.toLowerCase(), text);
    }

    const rows = [];
    let elementIndex = 0;
    const seenControl = new Set();

    const getPrompt = (node) => {
      const container = node.closest?.("form, section, main, article, div");
      if (!container) return "";
      const titleNode = container.querySelector?.("h1, h2, h3, legend, [data-testid*='question']");
      return String(titleNode?.textContent || "").trim();
    };

    const controls = Array.from(document.querySelectorAll("input, textarea, select, [role='combobox'], [contenteditable='true']"));
    for (const node of controls) {
      if (isGuidedOverlayElement(node)) continue;
      if (seenControl.has(node)) continue;
      seenControl.add(node);
      const nodeTag = String(node.tagName || "").toLowerCase();
      const nodeType = String(node.getAttribute?.("type") || "").toLowerCase();
      const isRadioControl = nodeTag === "input" && nodeType === "radio";
      if (!isRadioControl && !visible(node)) continue;
      if (node.disabled || (!isRadioControl && node.readOnly)) continue;

      const interactiveNode = ["input", "textarea", "select"].includes(String(node.tagName || "").toLowerCase()) || node.isContentEditable
        ? node
        : (node.querySelector?.("input, textarea, select, [contenteditable='true']") || node);
      if (!interactiveNode) continue;

      const tag = String(interactiveNode.tagName || "").toLowerCase();
      const type = String(interactiveNode.getAttribute?.("type") || "").toLowerCase();
      const isRadioField = tag === "input" && type === "radio";
      if (!isRadioField && !visible(interactiveNode)) continue;
      if (interactiveNode.disabled || (!isRadioField && interactiveNode.readOnly)) continue;
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;

      const id = String(interactiveNode.id || node.id || "").trim();
      const name = String(interactiveNode.getAttribute?.("name") || node.getAttribute?.("name") || "").trim();
      const placeholder = String(interactiveNode.getAttribute?.("placeholder") || node.getAttribute?.("placeholder") || "").trim();
      const ariaLabel = String(interactiveNode.getAttribute?.("aria-label") || node.getAttribute?.("aria-label") || "").trim();
      const role = String(node.getAttribute?.("role") || interactiveNode.getAttribute?.("role") || "").trim();
      const labelFor = id ? (labelMap.get(id.toLowerCase()) || "") : "";
      const wrapped = interactiveNode.closest?.("label")
        ? String(interactiveNode.closest("label").textContent || "").trim()
        : "";
      const legend = interactiveNode.closest?.("fieldset")?.querySelector?.("legend")
        ? String(interactiveNode.closest("fieldset").querySelector("legend").textContent || "").trim()
        : "";
      const prompt = getPrompt(interactiveNode);
      const label = labelFor || wrapped || legend || placeholder || ariaLabel || name || id || `element-${elementIndex}`;
      const options = tag === "select"
        ? Array.from(interactiveNode.options || []).map((option) => String(option.textContent || "").trim()).filter(Boolean).slice(0, 14)
        : [];
      const currentValue = interactiveNode.isContentEditable
        ? String(interactiveNode.textContent || "").trim()
        : String(interactiveNode.value || "").trim();
      const descriptor = `${label} ${placeholder} ${ariaLabel} ${name} ${id} ${prompt}`.trim();
      if (isNewsletterLike(interactiveNode, descriptor)) continue;
      const fieldDescriptor = `${label} ${placeholder} ${ariaLabel} ${name} ${id}`.trim();
      if (isEssayLikeField(fieldDescriptor)) continue;
      const sensitive = /(social security|ssn|passport|credit card|debit card|routing|bank account|cvv|security code)/i
        .test(`${label} ${placeholder} ${ariaLabel} ${name}`.trim());

      rows.push({
        elementIndex,
        elementKind: "field",
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
        currentValue: currentValue.slice(0, 120),
        isSubmitLike: false,
        isSensitive: sensitive
      });
      elementIndex += 1;
    }

    const seenAction = new Set();
    const actionNodes = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button'], [onclick]"));
    for (const node of actionNodes) {
      if (isGuidedOverlayElement(node)) continue;
      if (seenAction.has(node)) continue;
      seenAction.add(node);
      if (!visible(node)) continue;
      if (node.disabled) continue;

      const rawText = String(
        node.innerText
        || node.textContent
        || node.getAttribute?.("aria-label")
        || node.getAttribute?.("title")
        || node.getAttribute?.("value")
        || ""
      ).trim();
      if (!rawText || rawText.length > 120) continue;
      if (/(autofill page|approve\s*&?\s*next page|stop guided session)/i.test(rawText)) continue;
      const text = normalizeText(rawText);
      if (!text) continue;
      if (/^(back|go back|cancel|close|menu|help|terms|privacy)$/.test(text)) continue;
      if (/(newsletter|subscribe|subscription|mailing list)/i.test(rawText)) continue;
      if (isNewsletterLike(node, `${rawText} ${getPrompt(node)}`)) continue;
      if (/(sign in|log in|login|create account|sign up|register|continue with google|continue with apple|continue with microsoft)/i.test(rawText)) continue;

      const role = String(node.getAttribute?.("role") || "").trim();
      const tag = String(node.tagName || "").toLowerCase();
      const type = String(node.getAttribute?.("type") || "").toLowerCase();
      const prompt = getPrompt(node);
      const isSubmitLike = /(submit|final submit|complete application|finish application|place order|pay now|checkout|sign and submit|done)/i
        .test(rawText);
      const isSensitive = /(social security|ssn|passport|credit card|debit card|routing|bank account|cvv|security code)/i
        .test(`${rawText} ${prompt}`);

      rows.push({
        elementIndex,
        elementKind: "action",
        label: rawText,
        name: "",
        id: String(node.id || "").trim(),
        placeholder: "",
        ariaLabel: String(node.getAttribute?.("aria-label") || "").trim(),
        role,
        tag,
        type,
        prompt,
        required: false,
        optionTexts: [],
        currentValue: "",
        isSubmitLike,
        isSensitive
      });
      elementIndex += 1;
    }

    return rows.slice(0, 260);
  });
}

async function extractAiActionElements(page) {
  const rows = [];
  for (const frame of allFrames(page)) {
    try {
      const frameRows = await extractAiActionElementsInFrame(frame);
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
  return rows.slice(0, 360);
}

function buildAiActionFingerprint(elements = []) {
  const tokens = (Array.isArray(elements) ? elements : [])
    .map((element) => {
      const frameUrl = String(element?.frameUrl || "");
      const idx = Number(element?.elementIndex || 0);
      const kind = String(element?.elementKind || "");
      const label = String(element?.label || "");
      const value = String(element?.currentValue || "");
      return `${frameUrl}::${idx}::${kind}::${label}::${value}`;
    })
    .sort();
  return tokens.join("|");
}

async function applyAiActionsInFrame(frame, actionEntries) {
  return await frame.evaluate(async ({ entries }) => {
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
    const isGuidedOverlayElement = (el) => Boolean(el?.closest?.("#__sb_guided_overlay"));
    const isNewsletterLike = (node, textBlob = "") => {
      const marketingRe = /\b(newsletter|subscribe|subscription|mailing list|exclusive offers|updates|promo(?:tional)? emails?|marketing emails?)\b/i;
      const text = String(textBlob || "").toLowerCase();
      if (marketingRe.test(text)) return true;
      const container = node?.closest?.("form, section, article, aside, div");
      const containerText = String(container?.innerText || "").toLowerCase().slice(0, 1200);
      return marketingRe.test(containerText);
    };
    const isEssayLikeField = (textBlob = "") => {
      const text = String(textBlob || "").toLowerCase();
      if (!text.trim()) return false;
      if (/(newsletter|subscribe|marketing|promo|coupon|feedback|comment|captcha|search|login|password)/.test(text)) return false;
      return /(essay|personal statement|short answer|long answer|essay response|response statement|word limit|minimum words?|essay\d+|personal_statement)/.test(text);
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
    const normalizeToken = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const normalizeBinaryChoice = (rawValue) => {
      const text = normalizeToken(rawValue);
      if (!text) return "";
      if (/^(true|yes|y|1|on|checked)$/.test(text)) return "yes";
      if (/^(false|no|n|0|off|unchecked)$/.test(text)) return "no";
      if (/\b(yes|true)\b/.test(text) && !/\b(no|not|false)\b/.test(text)) return "yes";
      if (/\b(no|false)\b/.test(text)) return "no";
      return "";
    };
    const labelMap = new Map();
    for (const label of document.querySelectorAll("label[for]")) {
      const id = String(label.getAttribute("for") || "").trim();
      const text = String(label.textContent || "").trim();
      if (id && text) labelMap.set(id.toLowerCase(), text);
    }
    const chooseRadioOption = (radioNode, rawValue) => {
      const target = normalizeToken(rawValue);
      if (!target) return false;
      const desiredBinary = normalizeBinaryChoice(rawValue);
      const radioName = String(radioNode?.getAttribute?.("name") || "").trim();
      const group = radioName
        ? Array.from(document.querySelectorAll("input[type='radio']"))
          .filter((candidate) => String(candidate.getAttribute?.("name") || "") === radioName && !candidate.disabled)
        : [radioNode].filter(Boolean);
      const ranked = group
        .map((candidate) => {
          const id = String(candidate.id || "").trim();
          const byFor = id ? (labelMap.get(id.toLowerCase()) || "") : "";
          const descriptor = [
            byFor,
            String(candidate.getAttribute?.("aria-label") || "").trim(),
            String(candidate.closest?.("label")?.textContent || "").trim(),
            String(candidate.value || "").trim()
          ].filter(Boolean).join(" ");
          const optionText = normalizeToken(descriptor);
          const optionValue = normalizeToken(candidate.value || "");
          const booleanHint = `${optionText} ${optionValue}`.trim();
          let score = 0;
          if (optionValue === target || optionText === target) score += 14;
          if (optionText.includes(target) || target.includes(optionText) || optionValue.includes(target) || target.includes(optionValue)) score += 8;
          if (desiredBinary === "yes") {
            if (/\b(yes|true|1|on)\b/.test(booleanHint)) score += 10;
            if (/\b(no|false|0|off)\b/.test(booleanHint)) score -= 4;
          } else if (desiredBinary === "no") {
            if (/\b(no|false|0|off)\b/.test(booleanHint)) score += 10;
            if (/\b(yes|true|1|on)\b/.test(booleanHint)) score -= 4;
          }
          return { candidate, score };
        })
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (!best || best.score <= 0 || !best.candidate) return false;
      const candidate = best.candidate;
      const candidateId = String(candidate.id || "").trim();
      const forLabel = candidateId
        ? Array.from(document.querySelectorAll("label[for]"))
          .find((label) => String(label.getAttribute("for") || "").trim().toLowerCase() === candidateId.toLowerCase())
        : null;
      const wrappedLabel = candidate.closest?.("label") || null;
      const clickTarget = (forLabel && visible(forLabel))
        ? forLabel
        : ((wrappedLabel && visible(wrappedLabel)) ? wrappedLabel : candidate);
      clickTarget.scrollIntoView({ block: "center", inline: "nearest" });
      triggerMouseClick(clickTarget);
      best.candidate.checked = true;
      best.candidate.dispatchEvent(new Event("input", { bubbles: true }));
      best.candidate.dispatchEvent(new Event("change", { bubbles: true }));
      return Boolean(best.candidate.checked);
    };
    const valueMatchesCandidate = (currentRaw, candidateRaw) => {
      const current = normalizeText(currentRaw);
      const candidate = normalizeText(candidateRaw);
      if (!candidate) return false;
      if (!current) return false;
      return current === candidate || current.includes(candidate) || candidate.includes(current);
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

    const actionable = [];
    const seenControl = new Set();
    const controls = Array.from(document.querySelectorAll("input, textarea, select, [role='combobox'], [contenteditable='true']"));
    for (const node of controls) {
      if (isGuidedOverlayElement(node)) continue;
      if (seenControl.has(node)) continue;
      seenControl.add(node);
      if (!visible(node)) continue;
      if (node.disabled || node.readOnly) continue;

      const interactiveNode = ["input", "textarea", "select"].includes(String(node.tagName || "").toLowerCase()) || node.isContentEditable
        ? node
        : (node.querySelector?.("input, textarea, select, [contenteditable='true']") || node);
      if (!interactiveNode || !visible(interactiveNode)) continue;

      const tag = String(interactiveNode.tagName || "").toLowerCase();
      const type = String(interactiveNode.getAttribute?.("type") || "").toLowerCase();
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;
      const descriptor = [
        interactiveNode.getAttribute?.("aria-label"),
        interactiveNode.getAttribute?.("placeholder"),
        interactiveNode.getAttribute?.("name"),
        interactiveNode.id
      ].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
      if (isNewsletterLike(interactiveNode, descriptor)) continue;
      if (isEssayLikeField(descriptor)) continue;

      actionable.push({
        kind: "field",
        node: interactiveNode,
        label: String(interactiveNode.getAttribute?.("aria-label") || interactiveNode.getAttribute?.("placeholder") || interactiveNode.getAttribute?.("name") || interactiveNode.id || "").trim(),
        tag,
        type,
        isSubmitLike: false
      });
    }

    const seenAction = new Set();
    const actionNodes = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button'], [onclick]"));
    for (const node of actionNodes) {
      if (isGuidedOverlayElement(node)) continue;
      if (seenAction.has(node)) continue;
      seenAction.add(node);
      if (!visible(node)) continue;
      if (node.disabled) continue;

      const rawText = String(
        node.innerText
        || node.textContent
        || node.getAttribute?.("aria-label")
        || node.getAttribute?.("title")
        || node.getAttribute?.("value")
        || ""
      ).trim();
      if (!rawText || rawText.length > 120) continue;
      const text = normalizeText(rawText);
      if (!text) continue;
      if (/^(back|go back|cancel|close|menu|help|terms|privacy)$/.test(text)) continue;
      if (/(newsletter|subscribe|subscription|mailing list)/i.test(rawText)) continue;
      if (isNewsletterLike(node, rawText)) continue;
      if (/(sign in|log in|login|create account|sign up|register|continue with google|continue with apple|continue with microsoft)/i.test(rawText)) continue;
      const isSubmitLike = /(submit|final submit|complete application|finish application|place order|pay now|checkout|sign and submit|done)/i
        .test(rawText);

      actionable.push({
        kind: "action",
        node,
        label: rawText,
        tag: String(node.tagName || "").toLowerCase(),
        type: String(node.getAttribute?.("type") || "").toLowerCase(),
        isSubmitLike
      });
    }

    const debugEntries = [];
    let filledCount = 0;

    for (const action of entries || []) {
      let element = actionable[Number(action?.elementIndex)];
      if (!element) {
        debugEntries.push({
          fieldLabel: `element-${Number(action?.elementIndex ?? -1)}`,
          method: `ai-action-${action?.interaction || "unknown"}`,
          success: false,
          reason: "element-not-found",
          candidateValue: String(action?.value || "").slice(0, 120),
          finalValue: ""
        });
        continue;
      }

      const interaction = String(action?.interaction || "skip").trim().toLowerCase();
      const candidateValue = String(action?.value || "");
      const candidateReason = String(action?.reason || "").trim();
      const expectedKind = String(action?.expectedKind || "").trim().toLowerCase();
      const expectedLabel = normalizeText(String(action?.expectedLabel || ""));
      const actionNeedsField = interaction === "type" || interaction === "select" || interaction === "combobox" || interaction === "contenteditable";
      const expectedFieldKind = actionNeedsField ? "field" : "";

      const doesLabelMatch = (rawExpected, rawActual) => {
        const a = normalizeText(rawExpected);
        const b = normalizeText(rawActual);
        if (!a || !b) return true;
        return a === b || a.includes(b) || b.includes(a);
      };

      const isKindCompatible = (candidateKind) => {
        const kind = String(candidateKind || "").toLowerCase();
        if (expectedFieldKind && kind !== expectedFieldKind) return false;
        if (expectedKind && kind !== expectedKind) return false;
        return true;
      };

      if (!doesLabelMatch(expectedLabel, element?.label || "") || !isKindCompatible(element?.kind)) {
        const retargeted = actionable.find((candidate) => {
          if (!isKindCompatible(candidate?.kind)) return false;
          return doesLabelMatch(expectedLabel, candidate?.label || "");
        });
        if (retargeted) {
          element = retargeted;
        }
      }

      const fieldLabel = String(element.label || `element-${Number(action?.elementIndex ?? -1)}`);
      const labelMatches = doesLabelMatch(expectedLabel, fieldLabel);

      if (interaction === "skip") {
        debugEntries.push({
          fieldLabel,
          method: "ai-action-skip",
          success: false,
          reason: candidateReason || "ai-skip",
          candidateValue: candidateValue.slice(0, 120),
          finalValue: ""
        });
        continue;
      }

      if (!labelMatches) {
        debugEntries.push({
          fieldLabel,
          method: `ai-action-${interaction}`,
          success: false,
          reason: "target-mismatch-after-page-change",
          candidateValue: candidateValue.slice(0, 120),
          finalValue: ""
        });
        continue;
      }

      if (element.isSubmitLike && interaction === "click") {
        debugEntries.push({
          fieldLabel,
          method: "ai-action-click",
          success: false,
          reason: "blocked-submit-action",
          candidateValue: candidateValue.slice(0, 120),
          finalValue: ""
        });
        continue;
      }

      if (element.kind === "field" && interaction !== "click" && String(candidateValue || "").trim()) {
        const currentValue = String(element?.type || "").toLowerCase() === "radio"
          ? (element.node.checked ? String(element.node.value || "checked").trim() : "")
          : (element.node.isContentEditable
            ? String(element.node.textContent || "").trim()
            : String(element.node.value || element.node.textContent || "").trim());
        if (valueMatchesCandidate(currentValue, candidateValue)) {
          debugEntries.push({
            fieldLabel,
            method: `ai-action-${interaction}`,
            success: false,
            reason: "already-matches-target",
            candidateValue: candidateValue.slice(0, 120),
            finalValue: currentValue.slice(0, 120)
          });
          continue;
        }
      }

      let success = false;
      let comboSelected = false;
      if (interaction === "click") {
        element.node.scrollIntoView({ block: "center", inline: "nearest" });
        triggerMouseClick(element.node);
        await sleep(200);
        success = true;
      } else if (element.kind !== "field") {
        success = false;
      } else if (element.type === "radio") {
        success = chooseRadioOption(element.node, candidateValue);
      } else if (element.tag === "select" || interaction === "select") {
        success = chooseSelectOption(element.node, candidateValue);
      } else {
        success = await simulateTyping(element.node, candidateValue);
        if (success && interaction === "combobox") {
          comboSelected = await chooseComboboxOption(element.node, candidateValue);
        }
      }

      const finalValue = element.node.isContentEditable
        ? String(element.node.textContent || "").trim()
        : String(element.node.value || element.node.textContent || "").trim();

      debugEntries.push({
        fieldLabel,
        method: `ai-action-${interaction}`,
        success,
        comboSelected,
        reason: candidateReason,
        candidateValue: candidateValue.slice(0, 120),
        finalValue: finalValue.slice(0, 120)
      });
      if (success) filledCount += 1;
    }

    return { filledCount, debugEntries };
  }, { entries: actionEntries });
}

async function applyAiActions(page, actionEntries, { session = null, elements = [], attemptedActionKeys = null } = {}) {
  const actions = Array.isArray(actionEntries) ? actionEntries : [];
  const debugEntries = [];
  let filledCount = 0;
  let clickCount = 0;
  let mismatchCount = 0;
  let manualActionRequested = false;
  let plannedActionText = null;

  for (const action of actions) {
    const actionKey = buildGuidedActionKey(action);
    if (attemptedActionKeys instanceof Set && attemptedActionKeys.has(actionKey)) {
      debugEntries.push({
        frameUrl: String(action?.frameUrl || page.url()),
        fieldLabel: "(ai action planner)",
        method: `ai-action-${String(action?.interaction || "unknown")}`,
        success: false,
        reason: "already-attempted-this-step",
        candidateValue: String(action?.value || "").slice(0, 120),
        finalValue: ""
      });
      continue;
    }

    if (session && consumeManualActionRequest(session)) {
      const previewElement = (Array.isArray(elements) ? elements : [])
        .find((candidate) => Number(candidate?.elementIndex) === Number(action?.elementIndex)
          && String(candidate?.frameUrl || "") === String(action?.frameUrl || ""));
      plannedActionText = plannedActionText || summarizeAiActionForPreview(action, previewElement);
      manualActionRequested = true;
      break;
    }

    if (isOverlayControlAction(action, elements)) {
      debugEntries.push({
        frameUrl: String(action?.frameUrl || page.url()),
        fieldLabel: "(guided overlay control)",
        method: `ai-action-${String(action?.interaction || "unknown")}`,
        success: false,
        reason: "blocked-overlay-control-action",
        candidateValue: String(action?.value || "").slice(0, 120),
        finalValue: ""
      });
      continue;
    }

    const element = (Array.isArray(elements) ? elements : [])
      .find((candidate) => Number(candidate?.elementIndex) === Number(action?.elementIndex)
        && String(candidate?.frameUrl || "") === String(action?.frameUrl || ""));
    if (session && GUIDED_AI_ACTION_PREVIEW_SEC > 0) {
      const previewText = summarizeAiActionForPreview(action, element);
      plannedActionText = previewText;
      for (let remaining = GUIDED_AI_ACTION_PREVIEW_SEC; remaining >= 1; remaining -= 1) {
        if (consumeManualActionRequest(session)) {
          manualActionRequested = true;
          break;
        }
        await setInPagePlanText(session, `In ${remaining}s: ${previewText}`);
        await page.waitForTimeout(1000);
        if (consumeManualActionRequest(session)) {
          manualActionRequested = true;
          break;
        }
      }
      if (manualActionRequested) {
        debugEntries.push({
          frameUrl: String(action?.frameUrl || page.url()),
          fieldLabel: "(ai action planner)",
          method: "manual-action-request",
          success: false,
          reason: "manual-selection-requested",
          candidateValue: previewText.slice(0, 120),
          finalValue: ""
        });
        break;
      }
      await setInPagePlanText(session, `Executing: ${previewText}`);
    }

    if (session && consumeManualActionRequest(session)) {
      plannedActionText = plannedActionText || summarizeAiActionForPreview(action, element);
      manualActionRequested = true;
      break;
    }

    const targetFrameUrl = String(action?.frameUrl || "");
    const interaction = String(action?.interaction || "").trim().toLowerCase();
    const frame = allFrames(page).find((candidate) => candidate.url() === targetFrameUrl) || allFrames(page)[0];
    if (!frame) continue;
    try {
      const guardedAction = {
        ...action,
        expectedLabel: String(element?.label || ""),
        expectedKind: String(element?.elementKind || "")
      };
      const result = await applyAiActionsInFrame(frame, [guardedAction]);
      filledCount += Number(result?.filledCount || 0);
      const roundEntries = Array.isArray(result?.debugEntries) ? result.debugEntries : [];
      mismatchCount += roundEntries.filter((entry) => String(entry?.reason || "") === "target-mismatch-after-page-change").length;
      if (attemptedActionKeys instanceof Set) {
        attemptedActionKeys.add(actionKey);
      }
      for (const entry of roundEntries) {
        debugEntries.push({
          frameUrl: frame.url(),
          ...entry
        });
      }

      // Important: once a click succeeds, stop this action batch immediately.
      // The click can trigger navigation or rerender, making remaining planned actions stale.
      if (interaction === "click") {
        const clickSucceeded = roundEntries.some((entry) => entry?.success === true);
        if (clickSucceeded) {
          clickCount += 1;
          break;
        }
      }
    } catch (error) {
      if (attemptedActionKeys instanceof Set) {
        attemptedActionKeys.add(actionKey);
      }
      debugEntries.push({
        frameUrl: frame.url(),
        fieldLabel: "(frame)",
        method: `ai-action-${String(action?.interaction || "unknown")}`,
        success: false,
        reason: error?.message || "ai-action-failed",
        candidateValue: String(action?.value || "").slice(0, 120),
        finalValue: ""
      });
    }
  }

  return {
    filledCount,
    clickCount,
    mismatchCount,
    manualActionRequested,
    plannedActionText,
    debugEntries: debugEntries.slice(0, 150)
  };
}

async function runAiActionLoop(page, payload, { maxRounds = 3, session = null } = {}) {
  let totalFilled = 0;
  const debugEntries = [];
  let manualActionRequested = false;
  let manualActionText = "";
  let autoReplanUsed = false;
  const attemptedActionKeys = new Set();

  if (session) {
    await setInPagePlanText(session, "Planning actions...");
  }

  for (let round = 0; round < Math.max(1, Number(maxRounds || 0)); round += 1) {
    if (session && consumeManualActionRequest(session)) {
      manualActionRequested = true;
      manualActionText = String(session.aiActionPreview || "current planned AI action");
      break;
    }

    let elements = await extractAiActionElements(page);
    if (!elements.length) {
      // After click-driven navigation, page widgets can appear slightly later.
      await page.waitForTimeout(900);
      elements = await extractAiActionElements(page);
    }
    if (!elements.length) {
      debugEntries.push({
        frameUrl: page.url(),
        fieldLabel: "(ai action planner)",
        method: "ai-action-plan",
        success: false,
        reason: "no-actionable-elements",
        candidateValue: "",
        finalValue: ""
      });
      break;
    }

    const beforeSnapshot = {
      url: page.url(),
      fingerprint: buildAiActionFingerprint(elements)
    };
    const pageTitle = await page.title().catch(() => "");
    const aiResult = await planGuidedActionsWithAi({
      pageUrl: page.url(),
      pageTitle,
      elements,
      payload,
      timeoutMs: 20000
    });

    const plannedActions = Array.isArray(aiResult?.actions)
      ? aiResult.actions
        .filter((action) => Number(action?.confidence || 0) >= 0.5)
        .filter((action) => String(action?.interaction || "").trim().toLowerCase() !== "skip")
        .filter((action) => !isOverlayControlAction(action, elements))
        .slice(0, 4)
      : [];
    const actions = plannedActions
      .filter((action) => !attemptedActionKeys.has(buildGuidedActionKey(action)))
      .filter((action) => {
        const element = elements.find((candidate) =>
          Number(candidate?.elementIndex) === Number(action?.elementIndex)
          && String(candidate?.frameUrl || "") === String(action?.frameUrl || "")
        );
        if (!element || String(element?.elementKind || "") !== "field") return true;
        return !isEssayLikeElementDescriptor(element);
      });

    if (!actions.length) {
      if (session) {
        await setInPagePlanText(
          session,
          plannedActions.length > 0
            ? "No new AI action to run (already attempted this step)."
            : "No confident AI action available on this page."
        );
      }
      debugEntries.push({
        frameUrl: page.url(),
        fieldLabel: "(ai action planner)",
        method: "ai-action-plan",
        success: false,
        reason: plannedActions.length > 0
          ? "all-actions-already-attempted"
          : String(aiResult?.metadata?.reason || aiResult?.metadata?.mode || "no-ai-actions"),
        candidateValue: "",
        finalValue: ""
      });
      break;
    }

    if (session && consumeManualActionRequest(session)) {
      manualActionRequested = true;
      manualActionText = String(session.aiActionPreview || "current planned AI action");
      break;
    }

    const preApplyElements = await extractAiActionElements(page);
    const preApplySnapshot = {
      url: page.url(),
      fingerprint: buildAiActionFingerprint(preApplyElements)
    };
    if (hasMeaningfulPageAdvance(beforeSnapshot, preApplySnapshot)) {
      if (session) {
        await setInPagePlanText(session, "Page changed while planning; recalculating actions.");
      }
      debugEntries.push({
        frameUrl: page.url(),
        fieldLabel: "(ai action planner)",
        method: "ai-action-plan",
        success: false,
        reason: "page-changed-before-action-apply",
        candidateValue: "",
        finalValue: ""
      });
      continue;
    }

    const roundResult = await applyAiActions(page, actions, { session, elements, attemptedActionKeys });
    totalFilled += Number(roundResult?.filledCount || 0);
    debugEntries.push(...(Array.isArray(roundResult?.debugEntries) ? roundResult.debugEntries : []));
    const mismatchCount = Number(roundResult?.mismatchCount || 0);
    if (roundResult?.manualActionRequested) {
      manualActionRequested = true;
      manualActionText = String(roundResult?.plannedActionText || "current planned AI action");
      break;
    }

    if (Number(roundResult?.clickCount || 0) > 0) {
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 4000 });
      } catch {
        // click may not navigate; continue with current page
      }
      await page.waitForTimeout(1200);
    } else {
      await page.waitForTimeout(700);
    }

    const afterElements = await extractAiActionElements(page);
    const afterSnapshot = {
      url: page.url(),
      fingerprint: buildAiActionFingerprint(afterElements)
    };
    const progressed = hasMeaningfulPageAdvance(beforeSnapshot, afterSnapshot);
    if (!progressed && Number(roundResult?.filledCount || 0) === 0) {
      if (mismatchCount > 0 && !autoReplanUsed) {
        autoReplanUsed = true;
        if (session) {
          await setInPagePlanText(session, "Field targets changed after page rerender. Replanning once...");
        }
        await page.waitForTimeout(450);
        continue;
      }
      break;
    }
  }

  if (session) {
    await setInPagePlanText(
      session,
      manualActionRequested
        ? `Manual selection requested for "${manualActionText}". Continue manually, then use the standard flow (Approve This Page & Next) to continue this step.`
        : "No planned AI action."
    );
  }

  return {
    filledCount: totalFilled,
    debugEntries: debugEntries.slice(0, 150)
  };
}

async function applyAiPlanInFrame(frame, planEntries) {
  return await frame.evaluate(async ({ entries }) => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const isNewsletterLike = (node, textBlob = "") => {
      const marketingRe = /\b(newsletter|subscribe|subscription|mailing list|exclusive offers|updates|promo(?:tional)? emails?|marketing emails?)\b/i;
      const text = String(textBlob || "").toLowerCase();
      if (marketingRe.test(text)) return true;
      const container = node?.closest?.("form, section, article, aside, div");
      const containerText = String(container?.innerText || "").toLowerCase().slice(0, 1200);
      const formAction = String(container?.getAttribute?.("action") || "").toLowerCase();
      return marketingRe.test(containerText) || /(newsletter|subscribe|mailchimp|klaviyo)/.test(formAction);
    };
    const isEssayLikeField = (textBlob = "") => {
      const text = String(textBlob || "").toLowerCase();
      if (!text.trim()) return false;
      if (/(newsletter|subscribe|marketing|promo|coupon|feedback|comment|captcha|search|login|password)/.test(text)) return false;
      return /(essay|personal statement|short answer|long answer|essay response|response statement|word limit|minimum words?|essay\d+|personal_statement)/.test(text);
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
    const normalizeToken = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const normalizeBinaryChoice = (rawValue) => {
      const text = normalizeToken(rawValue);
      if (!text) return "";
      if (/^(true|yes|y|1|on|checked)$/.test(text)) return "yes";
      if (/^(false|no|n|0|off|unchecked)$/.test(text)) return "no";
      if (/\b(yes|true)\b/.test(text) && !/\b(no|not|false)\b/.test(text)) return "yes";
      if (/\b(no|false)\b/.test(text)) return "no";
      return "";
    };
    const labelMap = new Map();
    for (const label of document.querySelectorAll("label[for]")) {
      const id = String(label.getAttribute("for") || "").trim();
      const text = String(label.textContent || "").trim();
      if (id && text) labelMap.set(id.toLowerCase(), text);
    }
    const chooseRadioOption = (radioNode, rawValue) => {
      const target = normalizeToken(rawValue);
      if (!target) return false;
      const desiredBinary = normalizeBinaryChoice(rawValue);
      const radioName = String(radioNode?.getAttribute?.("name") || "").trim();
      const group = radioName
        ? Array.from(document.querySelectorAll("input[type='radio']"))
          .filter((candidate) => String(candidate.getAttribute?.("name") || "") === radioName && !candidate.disabled)
        : [radioNode].filter(Boolean);
      const ranked = group
        .map((candidate) => {
          const id = String(candidate.id || "").trim();
          const byFor = id ? (labelMap.get(id.toLowerCase()) || "") : "";
          const descriptor = [
            byFor,
            String(candidate.getAttribute?.("aria-label") || "").trim(),
            String(candidate.closest?.("label")?.textContent || "").trim(),
            String(candidate.value || "").trim()
          ].filter(Boolean).join(" ");
          const optionText = normalizeToken(descriptor);
          const optionValue = normalizeToken(candidate.value || "");
          const booleanHint = `${optionText} ${optionValue}`.trim();
          let score = 0;
          if (optionValue === target || optionText === target) score += 14;
          if (optionText.includes(target) || target.includes(optionText) || optionValue.includes(target) || target.includes(optionValue)) score += 8;
          if (desiredBinary === "yes") {
            if (/\b(yes|true|1|on)\b/.test(booleanHint)) score += 10;
            if (/\b(no|false|0|off)\b/.test(booleanHint)) score -= 4;
          } else if (desiredBinary === "no") {
            if (/\b(no|false|0|off)\b/.test(booleanHint)) score += 10;
            if (/\b(yes|true|1|on)\b/.test(booleanHint)) score -= 4;
          }
          return { candidate, score };
        })
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (!best || best.score <= 0 || !best.candidate) return false;
      const candidate = best.candidate;
      const candidateId = String(candidate.id || "").trim();
      const forLabel = candidateId
        ? Array.from(document.querySelectorAll("label[for]"))
          .find((label) => String(label.getAttribute("for") || "").trim().toLowerCase() === candidateId.toLowerCase())
        : null;
      const wrappedLabel = candidate.closest?.("label") || null;
      const clickTarget = (forLabel && visible(forLabel))
        ? forLabel
        : ((wrappedLabel && visible(wrappedLabel)) ? wrappedLabel : candidate);
      clickTarget.scrollIntoView({ block: "center", inline: "nearest" });
      triggerMouseClick(clickTarget);
      best.candidate.checked = true;
      best.candidate.dispatchEvent(new Event("input", { bubbles: true }));
      best.candidate.dispatchEvent(new Event("change", { bubbles: true }));
      return Boolean(best.candidate.checked);
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
      const nodeTag = String(node.tagName || "").toLowerCase();
      const nodeType = String(node.getAttribute?.("type") || "").toLowerCase();
      const isRadioControl = nodeTag === "input" && nodeType === "radio";
      if (!isRadioControl && !visible(node)) continue;
      if (node.disabled || (!isRadioControl && node.readOnly)) continue;
      const interactiveNode = ["input", "textarea", "select"].includes(String(node.tagName || "").toLowerCase()) || node.isContentEditable
        ? node
        : (node.querySelector?.("input, textarea, select, [contenteditable='true']") || node);
      if (!interactiveNode) continue;
      const tag = String(interactiveNode.tagName || "").toLowerCase();
      const type = String(interactiveNode.getAttribute?.("type") || "").toLowerCase();
      const isRadioField = tag === "input" && type === "radio";
      if (!isRadioField && !visible(interactiveNode)) continue;
      if (interactiveNode.disabled || (!isRadioField && interactiveNode.readOnly)) continue;
      if (tag === "input" && ["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;
      const descriptor = [
        interactiveNode.getAttribute?.("aria-label"),
        interactiveNode.getAttribute?.("placeholder"),
        interactiveNode.getAttribute?.("name"),
        interactiveNode.id
      ].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
      if (isNewsletterLike(interactiveNode, descriptor)) continue;
      if (isEssayLikeField(descriptor)) continue;
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
      const type = String(node.getAttribute?.("type") || "").toLowerCase();
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

      if (type === "radio") {
        success = chooseRadioOption(node, entry.value);
      } else if (tag === "select" || entry.interaction === "select") {
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

async function hasNextActionOnPage(page) {
  if (!page) {
    return false;
  }

  const frames = allFrames(page || null);
  for (const frame of frames) {
    let found = false;
    try {
      found = await frame.evaluate(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const isDisabled = (el) => {
          if (!el) return true;
          if (el.disabled) return true;
          const ariaDisabled = String(el.getAttribute?.("aria-disabled") || "").toLowerCase();
          if (ariaDisabled === "true") return true;
          if (el.getAttribute?.("disabled") != null) return true;
          const className = String(el.className || "").toLowerCase();
          return /\bdisabled\b/.test(className);
        };

        const selectors = "button, input[type='button'], input[type='submit'], input[type='image'], a, [role='button'], [type='submit']";
        const buttons = Array.from(document.querySelectorAll(selectors));
        return buttons.some((el) => {
          if (!visible(el)) return false;
          if (isDisabled(el)) return false;
          const text = String((el.innerText || el.value || el.textContent || el.getAttribute?.("aria-label") || "").trim().toLowerCase());
          if (!text) return false;
          if (/(submit|finish|complete application|final submit|place order|pay now|checkout)/.test(text)) return false;
          return /(next|continue|proceed|save and continue|next step|review and continue)/.test(text);
        });
      });
    } catch {
      found = false;
    }
    if (found) {
      return true;
    }
  }
  return false;
}

function buildVisibleFieldFingerprint(fields = []) {
  const tokens = (Array.isArray(fields) ? fields : [])
    .map((field) => {
      const frameUrl = String(field?.frameUrl || "");
      const id = String(field?.id || "");
      const name = String(field?.name || "");
      const label = String(field?.label || "");
      const type = String(field?.type || "");
      const required = field?.required ? "1" : "0";
      return `${frameUrl}::${id}::${name}::${label}::${type}::${required}`;
    })
    .sort();
  return tokens.join("|");
}

function hasMeaningfulPageAdvance(beforeSnapshot, afterSnapshot) {
  const beforeUrl = String(beforeSnapshot?.url || "");
  const afterUrl = String(afterSnapshot?.url || "");
  if (beforeUrl && afterUrl && beforeUrl !== afterUrl) return true;
  const beforeFingerprint = String(beforeSnapshot?.fingerprint || "");
  const afterFingerprint = String(afterSnapshot?.fingerprint || "");
  return beforeFingerprint !== afterFingerprint;
}

function isLikelyEssayDescriptor(field = {}) {
  const type = String(field?.type || "").toLowerCase();
  const label = String(field?.label || "").toLowerCase();
  const name = String(field?.name || "").toLowerCase();
  const id = String(field?.id || "").toLowerCase();
  if (type === "textarea") return true;
  return /(essay|statement|short answer|long answer|minimum words?|impact|mission|describe|essay\d+)/i.test(
    `${label} ${name} ${id}`
  );
}

function isStrictEssayDescriptor(field = {}) {
  const label = String(field?.label || "").toLowerCase();
  const name = String(field?.name || "").toLowerCase();
  const id = String(field?.id || "").toLowerCase();
  const blob = `${label} ${name} ${id}`.trim();
  if (!blob) return false;
  if (/(newsletter|subscribe|coupon|promo|marketing|feedback|comment|message|search|captcha|login|password)/i.test(blob)) {
    return false;
  }
  return /(essay|statement|short answer|long answer|minimum words?|word limit|prompt|describe|tell us|why do you|college|university|essay\d+)/i
    .test(blob);
}

function isCodeLikeEssayText(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  const cssBlock = /\{[^{}]{1,240}\}/.test(value) && /[:;]/.test(value);
  const cssProps = /\b(width|height|margin|padding|font-size|line-height|background|display|position|border|color)\s*:\s*[^;]+;/.test(lower);
  const cssSelector = /(^|\s)[.#][a-z0-9_-]+\s+[a-z0-9_.#-]+\s*\{/.test(lower);
  const codeFence = /```|<\/?[a-z][^>]*>|function\s*\(|const\s+[a-z0-9_]+\s*=|=>/.test(value);
  const semicolons = (value.match(/;/g) || []).length;
  return cssBlock || cssProps || cssSelector || codeFence || semicolons >= 4;
}

function scoreEssayPromptCandidate(text = "") {
  const value = String(text || "").trim();
  if (!value || value.length < 24) return 0;
  if (isCodeLikeEssayText(value)) return 0;
  const lower = value.toLowerCase();
  if (/\b(to be considered eligible|eligibility|read more about eligibility|all applications must be received|no late applications|on the day of the deadline)\b/.test(lower)) {
    return 0;
  }
  if (/\bsubmit answer to the essay question\b/.test(lower) && /\bfound on the application page\b/.test(lower)) {
    return 0;
  }
  if ((value.match(/\b\d+\)\s+/g) || []).length >= 2 && /\bmust\b/.test(lower)) {
    return 0;
  }
  let score = 0;
  if (/essay question/.test(lower)) score += 9;
  if (/(essay|personal statement|short answer|long answer|writing prompt)/.test(lower)) score += 6;
  if (/(why do you|describe|tell us|explain|how have|what does)/.test(lower)) score += 3;
  if (/(minimum|max(imum)?|word|words|characters?)/.test(lower)) score += 2;
  if (/[?]/.test(value)) score += 2;
  if (value.length > 1400) score -= 2;
  return score;
}

function normalizeEssayPromptCandidate(text = "") {
  let value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const explicitIdx = value.toLowerCase().indexOf("essay question:");
  if (explicitIdx >= 0) {
    value = value.slice(explicitIdx + "essay question:".length).trim();
  }
  if (value.length > 900) {
    const qIdx = value.indexOf("?");
    if (qIdx > 24) {
      value = value.slice(0, qIdx + 1).trim();
    } else {
      value = value.slice(0, 900).trim();
    }
  }
  return value;
}

async function detectEssayPromptOnPage(page) {
  const frames = allFrames(page);
  let best = "";
  let bestScore = 0;
  let sawEssayContext = false;
  for (const frame of frames) {
    try {
      const candidate = await frame.evaluate(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const isMarketingText = (text) => /\b(newsletter|subscribe|coupon|promo|marketing emails?|mailing list)\b/i.test(String(text || ""));
        const isLikelyEssayText = (text) => /(essay question|essay|personal statement|short answer|long answer|minimum|word|words|describe|tell us|why do you|\?)/i
          .test(String(text || ""));
        const push = (arr, value) => {
          const text = String(value || "").replace(/\s+/g, " ").trim();
          if (text.length < 24) return;
          if (isMarketingText(text)) return;
          if (!isLikelyEssayText(text)) return;
          arr.push(text);
        };

        const candidates = [];
        let hasEssayLikeControl = false;
        const controls = Array.from(
          document.querySelectorAll("textarea, [contenteditable='true'], input[type='text'], input:not([type])")
        ).filter((el) => visible(el) && !el.disabled && !el.readOnly);
        for (const ta of controls) {
          const descriptor = `${ta.placeholder || ""} ${ta.getAttribute?.("aria-label") || ""} ${ta.getAttribute?.("name") || ta.name || ""} ${ta.id || ""}`;
          const descriptorLower = descriptor.toLowerCase();
          if (/(newsletter|subscribe|coupon|promo|marketing|comment|feedback|search)/i.test(descriptorLower)) continue;
          const textLike = String(ta.tagName || "").toLowerCase() === "textarea" || ta.isContentEditable;
          const rows = Number(ta.getAttribute?.("rows") || 0);
          const maxLength = Number(ta.getAttribute?.("maxlength") || 0);
          if (/(essay|statement|short answer|long answer|minimum|word|words|prompt|describe|tell us|why do you|college|university|essay\d+)/i.test(descriptorLower)
            || (textLike && rows >= 3)
            || (textLike && Number.isFinite(maxLength) && maxLength >= 180)) {
            hasEssayLikeControl = true;
          }
          const labelNode = ta.closest("label");
          if (labelNode) push(candidates, labelNode.textContent || "");
          const fieldset = ta.closest("fieldset");
          if (fieldset) {
            const legend = fieldset.querySelector("legend");
            if (legend) push(candidates, legend.textContent || "");
          }
          const container = ta.closest("form, section, article, main, div");
          if (container) {
            const containerText = String(container.innerText || "").replace(/\s+/g, " ").trim();
            if (containerText) {
              const lines = containerText.split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean).slice(0, 40);
              for (const line of lines) {
                push(candidates, line.slice(0, 1200));
              }
            }
          }
          const nearbyPromptNodes = ta.closest("form, section, article, main, div")
            ? ta.closest("form, section, article, main, div").querySelectorAll("h1, h2, h3, h4, label, legend, p, strong, b")
            : [];
          for (const node of nearbyPromptNodes) {
            if (!visible(node)) continue;
            push(candidates, String(node.textContent || ""));
          }
        }
        if (!hasEssayLikeControl) {
          return { hasEssayContext: false, candidates: [] };
        }
        return { hasEssayContext: true, candidates: candidates.slice(0, 250) };
      });

      if (candidate?.hasEssayContext) {
        sawEssayContext = true;
      }
      for (const raw of Array.isArray(candidate?.candidates) ? candidate.candidates : []) {
        const normalized = normalizeEssayPromptCandidate(raw);
        const score = scoreEssayPromptCandidate(normalized);
        if (score > bestScore) {
          best = normalized;
          bestScore = score;
        }
      }
    } catch {
      // ignore frame read errors
    }
  }
  if (!sawEssayContext) return "";
  return bestScore >= 6 ? best : "";
}

function inferEssayPromptFromSession(session = null) {
  const directCandidates = [
    String(session?.lastEssayPrompt || "")
  ].map((text) => normalizeEssayPromptCandidate(text))
    .filter((text) => text && !isCodeLikeEssayText(text));
  for (const text of directCandidates) {
    const explicit = text.match(/essay question:\s*(.+)$/i);
    if (explicit?.[1]) {
      return String(explicit[1]).trim();
    }
    if (/(why do you|essay|statement|short answer|long answer|describe)/i.test(text) && text.length > 24) {
      return text;
    }
  }
  const telemetryCandidates = [
    String(session?.aiActionPreview || ""),
    ...(Array.isArray(session?.lastFillDiagnostics?.debugEntries)
      ? session.lastFillDiagnostics.debugEntries.map((entry) => String(entry?.fieldLabel || ""))
      : [])
  ]
    .map((text) => normalizeEssayPromptCandidate(text))
    .filter((text) => /essay question:/i.test(text) && !isCodeLikeEssayText(text));
  for (const text of telemetryCandidates) {
    const explicit = text.match(/essay question:\s*(.+)$/i);
    if (explicit?.[1]) {
      return String(explicit[1]).trim();
    }
  }
  return "";
}

async function refreshOverlayStateForCurrentPage(session, fallbackStatus = "Page changed") {
  const fields = await extractVisibleFields(session.page);
  const accountState = await detectAccountWall(session.page);
  const summary = await summarizeSessionState(session, fields, null, {
    accountRequired: accountState.accountRequired,
    accountReason: accountState.reason,
    accountEvidence: accountState.evidence
  });
  rememberOverlayState(session, summary, fallbackStatus);
  await installInPageControls(session);
  return summary;
}

async function refillCurrentStep(session) {
  const fillResult = await fillVisibleFields(session.page, session.payload, { session });
  const fields = await extractVisibleFields(session.page);
  return summarizeSessionState(session, fields, fillResult);
}

async function summarizeSessionState(session, fields, fillResult = null, extras = {}) {
  const fileRequired = fields.filter((f) => f.type === "file" && f.required).length;
  const accountRequired = extras.accountRequired === true;
  const accountReason = extras.accountReason || "";
  const explicitCanAdvance = typeof extras.canAdvance === "boolean" ? extras.canAdvance : null;
  const detectedCanAdvance = explicitCanAdvance !== null
    ? explicitCanAdvance
    : accountRequired ? false : await hasNextActionOnPage(session?.page || null);
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
        ? `Review this page and upload ${fileRequired} required file(s) manually before continuing. You can use in-page Guided Controls (Retry Autofill with AI/Approve This Page & Next).`
        : "Review this page, make any edits in browser, then click Approve This Page & Next. You can also use in-page Guided Controls."),
    canAdvance: accountRequired ? false : detectedCanAdvance
  };
}

function rememberOverlayState(session, summary, fallbackStatus = "Ready") {
  const fillDiagnostics = summary?.fillDiagnostics && typeof summary.fillDiagnostics === "object"
    ? summary.fillDiagnostics
    : { filledCount: 0, debugEntries: [] };
  session.lastFillDiagnostics = fillDiagnostics;
  if (summary && typeof summary.canAdvance === "boolean") {
    session.canAdvance = summary.canAdvance;
  } else {
    session.canAdvance = false;
  }
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

export async function startGuidedSubmission({ sourceUrl, payload, studentProfile = {} }) {
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
    studentProfile: studentProfile || {},
    canAdvance: false,
    manualActionRequested: false,
    manualResumeRequested: false,
    overlayStatus: "Ready",
    lastFillDiagnostics: { filledCount: 0, debugEntries: [] },
    aiActionPreview: "No planned AI action.",
    lastEssayPrompt: "",
    lastEssayDraft: ""
  };
  installGuidedLoggingListeners(page, session);
  attachGuidedPageListeners(session, page);

  await context.exposeBinding("__sbRefill", async () => {
    session.manualActionRequested = false;
    session.manualResumeRequested = false;
    const summary = await refillCurrentStep(session);
    const overlay = rememberOverlayState(session, summary, "Refilled");
    await installInPageControls(session);
    return { ok: true, ...overlay };
  });
  await context.exposeBinding("__sbNext", async () => {
    session.manualActionRequested = false;
    session.manualResumeRequested = false;
    const beforeFields = await extractVisibleFields(session.page);
    const beforeSnapshot = {
      url: session.page.url(),
      fingerprint: buildVisibleFieldFingerprint(beforeFields)
    };
    const moved = await clickNext(session.page);
    if (!moved) {
      const overlay = rememberOverlayState(session, null, "No next button found");
      await installInPageControls(session);
      return { ok: false, reason: "No next button found", ...overlay };
    }
    await session.page.waitForTimeout(1400);
    const summary = await refillCurrentStep(session);
    const afterSnapshot = {
      url: session.page.url(),
      fingerprint: buildVisibleFieldFingerprint(summary?.fields || [])
    };
    const advanced = hasMeaningfulPageAdvance(beforeSnapshot, afterSnapshot);
    if (!advanced) {
      const accountState = await detectAccountWall(session.page);
      const blockedSummary = {
        ...summary,
        accountRequired: accountState.accountRequired,
        accountReason: accountState.reason,
        accountEvidence: accountState.evidence,
        canAdvance: accountState.accountRequired ? false : summary.canAdvance,
        reviewMessage: accountState.accountRequired
          ? `Account setup required before continuing (${accountState.reason || "login/signup page detected"}). Complete it in browser, then click Resume After Account Setup.`
          : "Could not confirm page advance from this step. Complete any on-page role/account/apply action, then click Approve This Page & Next."
      };
      const overlay = rememberOverlayState(
        session,
        blockedSummary,
        accountState.accountRequired ? "Account setup required" : "No page advance detected"
      );
      await installInPageControls(session);
      return { ok: false, reason: "No page advance detected", ...overlay };
    }
    session.stepNumber += 1;
    const overlay = rememberOverlayState(session, summary, "Advanced");
    await installInPageControls(session);
    return { ok: true, ...overlay };
  });
  await context.exposeBinding("__sbStop", async () => {
    const sessionId = session.id;
    let result = await stopGuidedSubmission({ sessionId });
    if (!result?.closed) {
      result = await stopGuidedSubmission({ sessionId: "" });
    }
    return { ok: Boolean(result?.closed), ...result };
  });
  await context.exposeBinding("__sbManualAction", async () => {
    session.manualActionRequested = true;
    session.manualResumeRequested = true;
    return { ok: true };
  });
  await context.exposeBinding("__sbManualApplied", async () => {
    await clearManualRequestedState(session, {
      refresh: true,
      fallbackStatus: "Manual selection applied"
    });
    return { ok: true };
  });
  await context.exposeBinding("__sbEssayDraft", async (_source, promptText) => {
    const prompt = String(promptText || "").trim();
    if (prompt.length < 10) {
      throw new Error("Essay prompt is too short");
    }
    const scholarshipName = String(session.page?.url?.() || "").trim();
    const result = await generateEssayDraftWithAgent({
      prompt,
      studentProfile: session.studentProfile || session.payload || {},
      scholarshipName,
      timeoutMs: 150000
    });
    session.lastEssayPrompt = prompt;
    session.lastEssayDraft = String(result?.essay || "").trim();
    await installInPageControls(session);
    return {
      ok: true,
      essay: session.lastEssayDraft,
      prompt: session.lastEssayPrompt,
      wordCount: Number(result?.wordCount || 0),
      minWords: result?.minWords ?? null,
      maxWords: result?.maxWords ?? null,
      targetWords: result?.targetWords ?? null
    };
  });
  await context.exposeBinding("__sbEssayApply", async (_source, args = {}) => {
    const essay = String(args?.essay || "").trim();
    const prompt = String(args?.prompt || "").trim();
    if (!essay) {
      throw new Error("Essay text is required");
    }

    if (prompt) {
      session.lastEssayPrompt = prompt;
    }
    session.lastEssayDraft = essay;

    const updates = {};
    const keys = new Set();
    const visibleFields = await extractVisibleFields(session.page);
    const likelyEssayFields = visibleFields.filter((field) => isLikelyEssayDescriptor(field));
    for (const field of likelyEssayFields) {
      for (const rawKey of [field?.name, field?.id, field?.label]) {
        const key = String(rawKey || "").trim();
        if (!key) continue;
        keys.add(key);
      }
    }

    for (const key of keys) {
      updates[key] = essay;
    }
    updates["essays.0.content"] = essay;
    updates.personal_statement = essay;

    for (const [key, value] of Object.entries(updates)) {
      session.payload[key] = String(value);
    }
    if (!Array.isArray(session.studentProfile?.essays)) {
      session.studentProfile = {
        ...(session.studentProfile || {}),
        essays: []
      };
    }
    if (prompt || essay) {
      session.studentProfile.essays = [
        {
          prompt: prompt || null,
          content: essay
        },
        ...session.studentProfile.essays.filter((row) => String(row?.content || "").trim() !== essay)
      ].slice(0, 3);
    }

    const appliedCount = await applyEssayDraftToCurrentPage(session.page, essay, prompt);
    const fields = await extractVisibleFields(session.page);
    const summary = await summarizeSessionState(session, fields, {
      filledCount: appliedCount,
      debugEntries: [{
        fieldLabel: "Essay response",
        method: "essay-assistant-apply",
        success: appliedCount > 0,
        reason: appliedCount > 0 ? "" : "no-essay-target"
      }]
    });
    const overlay = rememberOverlayState(
      session,
      summary,
      appliedCount > 0 ? "Essay applied" : "No essay target detected"
    );
    await installInPageControls(session);
    return {
      ok: true,
      appliedCount,
      ...overlay
    };
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const activePage = await clickApplyStart(page, context);
  if (activePage !== page) {
    session.page = activePage;
    attachGuidedPageListeners(session, activePage);
  }

  let fillResult = await fillVisibleFields(session.page, payload || {}, { session });
  let fields = await extractVisibleFields(session.page);
  let accountState = await detectAccountWall(session.page);

  // If we ended up on an entry page with no visible fields yet,
  // try one more apply click pass before final classification.
  if (fields.length === 0) {
    const retriedPage = await clickApplyStart(session.page, session.context);
    if (retriedPage !== session.page) {
      session.page = retriedPage;
      attachGuidedPageListeners(session, retriedPage);
    }
    fillResult = await fillVisibleFields(session.page, payload || {}, { session });
    fields = await extractVisibleFields(session.page);
    accountState = await detectAccountWall(session.page);
  }

  const initialSummary = await summarizeSessionState(session, fields, fillResult, {
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

  const beforeFields = await extractVisibleFields(session.page);
  const beforeSnapshot = {
    url: session.page.url(),
    fingerprint: buildVisibleFieldFingerprint(beforeFields)
  };
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
  const fillResult = await fillVisibleFields(session.page, session.payload, { session });
  const fields = await extractVisibleFields(session.page);
  const accountState = await detectAccountWall(session.page);
  const afterSnapshot = {
    url: session.page.url(),
    fingerprint: buildVisibleFieldFingerprint(fields)
  };
  const advanced = hasMeaningfulPageAdvance(beforeSnapshot, afterSnapshot);
  if (!advanced) {
    const nextSummary = await summarizeSessionState(session, fields, fillResult, {
      accountRequired: accountState.accountRequired,
      accountReason: accountState.reason,
      accountEvidence: accountState.evidence
    });
    const summary = {
      ...nextSummary,
      canAdvance: accountState.accountRequired ? false : nextSummary.canAdvance,
      reviewMessage: accountState.accountRequired
        ? `Account setup required before continuing (${accountState.reason || "login/signup page detected"}). Complete it in browser, then click Resume After Account Setup.`
        : "Could not confirm page advance from this step. Complete any on-page role/account/apply action, then click Approve This Page & Next."
    };
    rememberOverlayState(
      session,
      summary,
      accountState.accountRequired ? "Account setup required" : "No page advance detected"
    );
    await installInPageControls(session);
    return summary;
  }
  session.stepNumber += 1;
  const summary = await summarizeSessionState(session, fields, fillResult, {
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
  const fillResult = await fillVisibleFields(session.page, session.payload, { session });
  const fields = await extractVisibleFields(session.page);
  const accountState = await detectAccountWall(session.page);
  const summary = await summarizeSessionState(session, fields, fillResult, {
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
  const closeSingleSession = async (session, closeId) => {
    sessions.delete(closeId);
    const errors = [];
    try {
      await Promise.race([
        session.browser.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("browser.close timeout")), 5000))
      ]);
      return { closed: true };
    } catch (error) {
      errors.push(error?.message || String(error));
    }
    try {
      await session.context?.close?.();
      return { closed: true, fallback: "context.close" };
    } catch (error) {
      errors.push(error?.message || String(error));
    }
    try {
      await session.page?.close?.();
      return { closed: true, fallback: "page.close" };
    } catch (error) {
      errors.push(error?.message || String(error));
    }
    return { closed: false, reason: errors.join("; ") || "Unable to close session resources" };
  };

  if (id) {
    const session = sessions.get(id);
    if (!session) {
      // Session id can become stale on long-lived UI state; if there is only one
      // active session, close it as a best-effort recovery.
      if (sessions.size === 1) {
        const [onlyId, onlySession] = Array.from(sessions.entries())[0];
        const result = await closeSingleSession(onlySession, onlyId);
        return {
          ...result,
          reason: result.closed ? "" : (result.reason || "Session not found")
        };
      }
      return { closed: false, reason: "No session available" };
    }
    return await closeSingleSession(session, id);
  }

  const all = Array.from(sessions.entries());
  if (!all.length) {
    return { closed: false, reason: "No active sessions" };
  }
  let closedCount = 0;
  const errors = [];
  for (const [sessionKey, session] of all) {
    const result = await closeSingleSession(session, sessionKey);
    if (result.closed) {
      closedCount += 1;
    } else if (result.reason) {
      errors.push(result.reason);
    }
  }
  return {
    closed: closedCount > 0,
    closedCount,
    reason: errors.length ? errors.join(" | ") : ""
  };
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
  return await summarizeSessionState(session, fields, null);
}
