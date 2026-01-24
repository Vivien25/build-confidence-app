// frontend/src/pages/Chat.jsx
import { useEffect, useRef, useState } from "react";
import axios from "axios";
import mermaid from "mermaid";
import { getProfile } from "../utils/profile";
import { avatarMap, COACHES } from "../utils/avatars";
import { useNavigate } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const AXIOS_TIMEOUT_MS = Number(import.meta.env.VITE_CHAT_TIMEOUT_MS || 20000);

mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

// ---------- localStorage helpers (persistent) ----------
function loadSaved(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

// ---------- sessionStorage helpers (per visit / refreshable) ----------
function loadSession(key, fallback = null) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveSession(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseConfidence(input) {
  const s = String(input || "").trim();
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 10) return null;
  return Math.round(n * 10) / 10;
}

function focusLabel(focus) {
  const f = String(focus || "work");
  return f.charAt(0).toUpperCase() + f.slice(1);
}

function titleCase(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  return /^(hi|hello|hey|hiya|yo)[!.\s]*$/.test(t);
}

function userAskedForPlan(text) {
  const t = String(text || "").toLowerCase();
  return /\b(plan|steps|roadmap|action items|what should i do|next steps|help me|can you help|strategy|schedule|prep)\b/.test(t);
}

// ---------- Learning links generator (fallback when backend doesn’t provide resources) ----------
function defaultResourcesForStep(stepLabel) {
  const s = String(stepLabel || "").toLowerCase();

  const COMMON = [
    { title: "STAR interview method (overview)", url: "https://www.themuse.com/advice/star-interview-method", type: "article" },
    { title: "System design primer (GitHub)", url: "https://github.com/donnemartin/system-design-primer", type: "repo" },
    { title: "Google Cloud Architecture Center", url: "https://cloud.google.com/architecture", type: "doc" },
  ];

  const CODING = [
    { title: "NeetCode practice patterns", url: "https://neetcode.io/practice", type: "practice" },
    { title: "Big-O Cheat Sheet", url: "https://www.bigocheatsheet.com/", type: "reference" },
    { title: "Grokking the Coding Interview (patterns)", url: "https://www.educative.io/courses/grokking-the-coding-interview", type: "course" },
  ];

  const ML_SYSTEMS = [
    { title: "Rules of ML (Google)", url: "https://developers.google.com/machine-learning/guides/rules-of-ml", type: "doc" },
    { title: "Reliable ML (Google)", url: "https://developers.google.com/machine-learning/guides/reliable-ml", type: "doc" },
    { title: "MLOps pipelines (Google Cloud)", url: "https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning", type: "doc" },
  ];

  const BEHAVIORAL = [
    { title: "How Google hires (interview guide)", url: "https://careers.google.com/how-we-hire/interview/", type: "guide" },
    { title: "How to answer “Tell me about yourself” (HBR)", url: "https://hbr.org/2021/11/how-to-answer-tell-me-about-yourself", type: "article" },
    { title: "STAR method worksheet (Indeed)", url: "https://www.indeed.com/career-advice/interviewing/star-method", type: "article" },
  ];

  // coding hints
  if (s.includes("leetcode") || s.includes("algorithm") || s.includes("complexity") || s.includes("coding") || s.includes("code")) return CODING;

  // system design hints
  if (s.includes("system design") || s.includes("architecture") || s.includes("design") || s.includes("tradeoff") || s.includes("scal")) {
    return [
      { title: "System design primer (GitHub)", url: "https://github.com/donnemartin/system-design-primer", type: "repo" },
      { title: "Google Cloud Architecture Center", url: "https://cloud.google.com/architecture", type: "doc" },
      { title: "DDIA references / notes", url: "https://github.com/ept/ddia-references", type: "notes" },
    ];
  }

  // ML / inference hints
  if (s.includes("ml") || s.includes("model") || s.includes("inference") || s.includes("serving") || s.includes("latency") || s.includes("eval")) return ML_SYSTEMS;

  // behavioral hints
  if (s.includes("star") || s.includes("story") || s.includes("behavior") || s.includes("project") || s.includes("experience")) return BEHAVIORAL;

  return COMMON;
}

function ensureResourcesOnSteps(planObj) {
  const steps = Array.isArray(planObj?.steps) ? planObj.steps : [];
  return {
    ...planObj,
    steps: steps.map((s) => {
      const has = Array.isArray(s?.resources) && s.resources.length > 0;
      return { ...s, resources: has ? s.resources : defaultResourcesForStep(s?.label).slice(0, 3) };
    }),
  };
}

// ---------- Mermaid helpers ----------
function safeMermaidLabel(s) {
  // Prevent breaking Mermaid node syntax: remove quotes + newlines, trim, limit length
  return String(s || "")
    .replace(/"/g, "'")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

function buildFallbackMermaidFromSteps(title, steps) {
  const st = Array.isArray(steps) ? steps : [];
  const t = safeMermaidLabel(title || "Plan");

  if (!st.length) return `flowchart TD\nA["${t}"]`;

  const nodes = st
    .slice(0, 12)
    .map((label, i) => `S${i + 1}["${safeMermaidLabel(label)}"]`)
    .join("\n");

  const edges = st
    .slice(0, 12)
    .map((_, i) => (i === 0 ? `A["${t}"] --> S1` : `S${i} --> S${i + 1}`))
    .join("\n");

  return `flowchart TD
${nodes}
${edges}
`;
}

// ---------- Simple plan text extraction (when backend sends only numbered steps) ----------
function extractPlanFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // Capture lines like "1. something", "2) something", "- something" (fallback)
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  const numbered = [];
  for (const l of lines) {
    const m = l.match(/^(\d+)[\.\)]\s+(.*)$/);
    if (m && m[2]) {
      numbered.push(m[2].trim());
    }
  }

  // If no numbered list, try bullet list
  if (numbered.length === 0) {
    const bullets = lines
      .filter((l) => /^[-•]\s+/.test(l))
      .map((l) => l.replace(/^[-•]\s+/, "").trim())
      .filter(Boolean);
    if (bullets.length >= 2) return { steps: bullets.slice(0, 12) };
    return null;
  }

  // Drop weird empty markdown like "**" or ""
  const cleaned = numbered
    .map((s) => s.replace(/^\*\*+|\*\*+$/g, "").trim())
    .filter((s) => s && s !== "**");

  if (cleaned.length < 2) return null;
  return { steps: cleaned.slice(0, 12) };
}

// ---------- Mermaid component ----------
function MermaidDiagram({ code }) {
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        if (!ref.current) return;

        const src = String(code || "").trim();
        if (!src) {
          ref.current.innerHTML = "<div style='opacity:.8'>No diagram.</div>";
          return;
        }

        const id = `mmd-${Math.random().toString(16).slice(2)}`;
        const { svg } = await mermaid.render(id, src);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch (e) {
        if (!cancelled && ref.current) {
          ref.current.innerHTML = "<div style='opacity:.8'>Diagram failed to render.</div>";
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [code]);

  return <div ref={ref} />;
}

// ✅ Replace/update system messages instead of appending stale ones
function upsertSystemMessage(setMessages, msg) {
  setMessages((prev) => {
    const idx = prev.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      const next = prev.slice();
      next[idx] = { ...next[idx], ...msg };
      return next;
    }
    return [...prev, msg];
  });
}

function getAxiosErrorMessage(err) {
  const detail = err?.response?.data?.detail;
  const message = err?.response?.data?.message;
  const error = err?.response?.data?.error;

  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (typeof message === "string" && message.trim()) return message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();

  if (err?.code === "ECONNABORTED") return "Request timed out.";
  if (typeof err?.message === "string" && err.message.trim()) return err.message.trim();
  return "Network or server error.";
}

/**
 * Map your UI "need" to backend topics.
 */
function mapNeedToBackendTopic(needKey, focus, customNeedLabel) {
  if (needKey === "interview") return "interview_confidence";
  if (needKey === "presentation") return "presentation_confidence";
  if (needKey === "communication") return "relationship_communication";
  if (needKey === "networking") return "general";
  if (needKey === "leadership") return "work_focus";
  if (needKey === "negotiation") return "work_focus";

  if (needKey === "custom") {
    const slug = slugify(customNeedLabel);
    return slug ? `custom_${slug}` : "general";
  }

  if (focus === "work") return "work_focus";
  return "general";
}

/**
 * Convert backend plan -> UI plan object (robust)
 * Supports tasks OR steps OR items, and string steps.
 */
function adaptBackendPlanToUI(plan, focus, needKey, needLabel) {
  const raw =
    (Array.isArray(plan?.tasks) && plan.tasks) ||
    (Array.isArray(plan?.steps) && plan.steps) ||
    (Array.isArray(plan?.items) && plan.items) ||
    [];

  const norm = raw.map((t) => {
    if (typeof t === "string") return { text: t, resources: [] };
    return {
      text: t?.text ?? t?.label ?? t?.task ?? "",
      resources: Array.isArray(t?.resources) ? t.resources : [],
    };
  });

  return {
    id: plan?.id || uid("plan"),
    title: plan?.title || `${titleCase(focus)} • ${needLabel || "Plan"}`,
    goal: plan?.goal || "",
    focus,
    needKey,
    needLabel,
    steps: norm
      .map((t, i) => ({
        id: `S${i + 1}`,
        label: String(t?.text || "").trim(),
        resources: t.resources,
      }))
      .filter((s) => s.label) // drop empty items
      .slice(0, 12),
    createdAt: plan?.created_at || new Date().toISOString(),
    acceptedAt: null,
  };
}

// ---------- Inline sidebar (shows links too) ----------
function ConversationPlansSidebarInline({ plans }) {
  const styles = {
    titleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 },
    title: { fontWeight: 900, fontSize: 16 },
    card: { border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", marginBottom: 10 },
    muted: { opacity: 0.75 },
    planTitle: { fontWeight: 900, marginBottom: 6 },
    steps: { margin: "6px 0 0", paddingLeft: 18 },
    step: { marginBottom: 8, lineHeight: 1.35 },
    links: { marginTop: 4, paddingLeft: 16, fontSize: 13, opacity: 0.95 },
    linkItem: { marginBottom: 3 },
    pill: {
      display: "inline-block",
      fontSize: 12,
      padding: "2px 8px",
      borderRadius: 999,
      border: "1px solid #e5e7eb",
      opacity: 0.9,
      marginLeft: 6,
    },
  };

  const safePlans = Array.isArray(plans) ? plans : [];

  return (
    <div>
      <div style={styles.titleRow}>
        <div style={styles.title}>Plans from this conversation</div>
      </div>

      {safePlans.length === 0 ? (
        <div style={styles.card}>
          <div style={styles.muted}>No saved plans yet. Accept a plan to pin it here.</div>
        </div>
      ) : (
        safePlans.map((p) => (
          <div key={p.id} style={styles.card}>
            <div style={styles.planTitle}>
              {p.title || "Plan"}
              {p.needLabel ? <span style={styles.pill}>{p.needLabel}</span> : null}
            </div>

            {Array.isArray(p.steps) && p.steps.length > 0 ? (
              <ol style={styles.steps}>
                {p.steps.slice(0, 3).map((s) => (
                  <li key={s.id} style={styles.step}>
                    <div>{s.label}</div>

                    {/* ✅ Show links in sidebar too */}
                    {Array.isArray(s.resources) && s.resources.length > 0 ? (
                      <ul style={styles.links}>
                        {s.resources.slice(0, 2).map((r, idx) => (
                          <li key={idx} style={styles.linkItem}>
                            <a href={r.url} target="_blank" rel="noreferrer">
                              {r.title}
                            </a>
                            {r.type ? <span style={{ opacity: 0.7 }}> ({r.type})</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <div style={styles.muted}>No steps found.</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export default function Chat() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(() => getProfile() || {});

  useEffect(() => {
    setProfile(getProfile() || {});
  }, []);

  const userAvatarKey = profile?.avatar ?? "neutral";
  const userAvatar = avatarMap[userAvatarKey];

  const coachId = profile?.coachId || "mira";
  const coach = (COACHES && (COACHES[coachId] || COACHES.mira)) || {
    name: "Coach",
    avatar: userAvatar?.img,
  };

  // Recommend stable userId (email if you have it)
  const userId = profile?.user_id || profile?.email || "local-dev";
  const focus = profile?.focus || "work";

  // need selection (localStorage)
  const needKeyStorage = `bc_need_${userId}_${focus}`;
  const customNeedLabelStorage = `bc_need_custom_label_${userId}_${focus}`;
  const activeNeedStorage = `bc_active_need_${userId}_${focus}`;

  const NEED_OPTIONS = [
    { key: "interview", label: "Interview confidence" },
    { key: "presentation", label: "Presentation confidence" },
    { key: "communication", label: "Communication confidence" },
    { key: "networking", label: "Networking confidence" },
    { key: "leadership", label: "Leadership confidence" },
    { key: "negotiation", label: "Negotiation confidence" },
    { key: "custom", label: "Other (custom)" },
  ];

  const [needKey, setNeedKey] = useState(() => {
    const active = loadSaved(activeNeedStorage, null);
    if (active && NEED_OPTIONS.some((n) => n.key === String(active))) return String(active);

    const saved = loadSaved(needKeyStorage, null);
    if (saved && NEED_OPTIONS.some((n) => n.key === String(saved))) return String(saved);

    return "interview";
  });

  const [customNeedLabel, setCustomNeedLabel] = useState(() => {
    const saved = loadSaved(customNeedLabelStorage, "");
    return String(saved || "");
  });

  function currentNeedLabel() {
    const found = NEED_OPTIONS.find((x) => x.key === needKey);
    if (needKey === "custom") {
      return customNeedLabel?.trim() ? titleCase(customNeedLabel.trim()) : "Custom confidence";
    }
    return found?.label || "Confidence";
  }

  const needSlug = needKey === "custom" ? `custom_${slugify(customNeedLabel) || "custom"}` : needKey;

  // per-need chat storage
  const chatKey = `bc_chat_${userId}_${focus}_${needSlug}`;
  // persistent across app
  const plansKey = `bc_plans_${userId}`;
  // conversation plans (sessionStorage)
  const convPlansKey = `bc_conv_plans_${userId}_${focus}`;
  // confidence per focus + need
  const confidenceKey = `bc_conf_${userId}_${focus}_${needSlug}`;
  // UI state across navigation
  const uiKey = `bc_chat_ui_${userId}_${focus}_${needSlug}`;
  // pending plan request (prevents “two questions at once”)
  const pendingKey = `${uiKey}_pendingPlanRequest`;

  const [hasUserSpoken, setHasUserSpoken] = useState(() => loadSession(`${uiKey}_hasSpoken`, false));
  const [readyForBaseline, setReadyForBaseline] = useState(() => loadSession(`${uiKey}_readyBaseline`, false));

  const [input, setInput] = useState(() => loadSession(`${uiKey}_draft`, ""));
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  // Prevent double-send
  const sendingRef = useRef(false);

  const [plans, setPlans] = useState([]);
  const [convPlans, setConvPlans] = useState([]);

  const [plansHydrated, setPlansHydrated] = useState(false);
  const [convPlansHydrated, setConvPlansHydrated] = useState(false);
  const [chatHydrated, setChatHydrated] = useState(false);

  // confidence UX
  const [awaitingBaseline, setAwaitingBaseline] = useState(() => loadSession(`${uiKey}_awaitBaseline`, false));
  const [awaitingBaselineReason, setAwaitingBaselineReason] = useState(() => loadSession(`${uiKey}_awaitBaselineReason`, false));
  const [awaitingDailyProgress, setAwaitingDailyProgress] = useState(() => loadSession(`${uiKey}_awaitDailyProgress`, false));
  const [awaitingDailyConfidence, setAwaitingDailyConfidence] = useState(() => loadSession(`${uiKey}_awaitDailyConfidence`, false));

  // backend ui
  const [backendUI, setBackendUI] = useState(() =>
    loadSession(`${uiKey}_backendUI`, { mode: "CHAT", show_plan_sidebar: false, plan_link: null, mermaid: null })
  );

  const listRef = useRef(null);
  const reqSeqRef = useRef(0);

  // Load per-need chat messages
  useEffect(() => {
    setChatHydrated(false);
    setMessages(loadSaved(chatKey, []));
    setChatHydrated(true);
  }, [chatKey]);

  // Load global plans
  useEffect(() => {
    const p = loadSaved(plansKey, []);
    setPlans(Array.isArray(p) ? p : []);
    setPlansHydrated(true);
  }, [plansKey]);

  // Load conversation plans
  useEffect(() => {
    const savedConv = loadSession(convPlansKey, []);
    setConvPlans(Array.isArray(savedConv) ? savedConv : []);
    setConvPlansHydrated(true);
  }, [convPlansKey]);

  // Persist chat
  useEffect(() => {
    save(chatKey, messages);
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, chatKey]);

  // Persist global plans
  useEffect(() => {
    if (!plansHydrated) return;
    save(plansKey, plans);
  }, [plansKey, plans, plansHydrated]);

  // Persist conversation plans
  useEffect(() => {
    if (!convPlansHydrated) return;
    saveSession(convPlansKey, convPlans);
  }, [convPlansKey, convPlans, convPlansHydrated]);

  // Persist need selection
  useEffect(() => {
    save(needKeyStorage, needKey);
  }, [needKeyStorage, needKey]);

  useEffect(() => {
    save(customNeedLabelStorage, customNeedLabel);
  }, [customNeedLabelStorage, customNeedLabel]);

  // Persist UI state
  useEffect(() => saveSession(`${uiKey}_draft`, input), [uiKey, input]);
  useEffect(() => saveSession(`${uiKey}_hasSpoken`, hasUserSpoken), [uiKey, hasUserSpoken]);
  useEffect(() => saveSession(`${uiKey}_readyBaseline`, readyForBaseline), [uiKey, readyForBaseline]);
  useEffect(() => saveSession(`${uiKey}_awaitBaseline`, awaitingBaseline), [uiKey, awaitingBaseline]);
  useEffect(() => saveSession(`${uiKey}_awaitBaselineReason`, awaitingBaselineReason), [uiKey, awaitingBaselineReason]);
  useEffect(() => saveSession(`${uiKey}_awaitDailyProgress`, awaitingDailyProgress), [uiKey, awaitingDailyProgress]);
  useEffect(() => saveSession(`${uiKey}_awaitDailyConfidence`, awaitingDailyConfidence), [uiKey, awaitingDailyConfidence]);
  useEffect(() => saveSession(`${uiKey}_backendUI`, backendUI), [uiKey, backendUI]);

  // Reset local UX gating when need changes
  useEffect(() => {
    setAwaitingBaseline(false);
    setAwaitingBaselineReason(false);
    setAwaitingDailyProgress(false);
    setAwaitingDailyConfidence(false);
    setReadyForBaseline(false);
    saveSession(pendingKey, null);

    setMessages((prev) =>
      prev.filter(
        (m) =>
          !(
            m.type === "system" &&
            (m.kind === "baseline_prompt" || m.kind === "baseline_reason_prompt" || m.kind === "daily_prompt" || m.kind === "daily_conf_prompt")
          )
      )
    );

    setBackendUI({ mode: "CHAT", show_plan_sidebar: false, plan_link: null, mermaid: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, customNeedLabel, focus]);

  // Baseline + daily triggers (only after user talked + requested plan)
  useEffect(() => {
    if (!chatHydrated) return;
    if (!hasUserSpoken || !readyForBaseline) return;

    const conf = loadSaved(confidenceKey, null);
    const t = todayStr();
    const fLabel = focusLabel(focus);
    const nLabel = currentNeedLabel();

    if (needKey === "custom" && !customNeedLabel.trim()) return;

    if (!conf || typeof conf?.baseline !== "number") {
      if (!awaitingBaseline && !awaitingBaselineReason) {
        setAwaitingBaseline(true);
        setAwaitingDailyProgress(false);
        setAwaitingDailyConfidence(false);

        upsertSystemMessage(setMessages, {
          id: `system_baseline_${focus}_${needSlug}`,
          role: "assistant",
          type: "system",
          kind: "baseline_prompt",
          mode: "coach",
          message: `Before we go deeper on **${nLabel}** (${fLabel}), quick baseline.\nOn a scale from 1–10, what is your confidence level right now?`,
        });
      }
      return;
    }

    const lastChecked = String(conf?.lastCheckDate || "");
    if (lastChecked !== t) {
      if (!awaitingDailyProgress && !awaitingDailyConfidence) {
        setAwaitingDailyProgress(true);
        setAwaitingBaseline(false);
        setAwaitingBaselineReason(false);

        upsertSystemMessage(setMessages, {
          id: `system_daily_${focus}_${needSlug}`,
          role: "assistant",
          type: "daily_progress",
          kind: "daily_prompt",
          mode: "coach",
          message: `Quick check-in 🌱\nDid you get a chance to work on your **${nLabel}** plan since last time?`,
        });
      }
    } else {
      setAwaitingDailyProgress(false);
      setAwaitingDailyConfidence(false);
      setAwaitingBaseline(false);
      setAwaitingBaselineReason(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatHydrated, hasUserSpoken, readyForBaseline, confidenceKey, focus, needKey, customNeedLabel]);

  const acceptPlan = (planObj) => {
    const accepted = { ...planObj, acceptedAt: new Date().toISOString() };
    save(activeNeedStorage, accepted?.needKey || needKey);

    setPlans((prev) => {
      const dedup = prev.filter((p) => p.id !== accepted.id);
      return [accepted, ...dedup];
    });

    setConvPlans((prev) => {
      const dedup = prev.filter((p) => p.id !== accepted.id);
      return [accepted, ...dedup];
    });

    setMessages((prev) =>
      prev.map((m) => {
        if (m.type === "plan" && m.plan?.id === planObj.id) return { ...m, accepted: true };
        if (m.type === "plan_accept" && m.planId === planObj.id) return { ...m, accepted: true };
        return m;
      })
    );

    setMessages((prev) => [
      ...prev,
      { id: uid("msg"), role: "assistant", type: "text", mode: "coach", message: "Saved ✅ Added to this conversation and your All Plans page." },
    ]);
  };

  const revisePlan = async () => {
    setMessages((prev) => [
      ...prev,
      {
        id: uid("msg"),
        role: "assistant",
        type: "text",
        mode: "coach",
        message: "Sure — tell me what to change. (Examples: “make it shorter”, “focus on system design”, “replace step 3”, “more lightweight”.)",
      },
    ]);
  };

  function alreadyHasRecentReachError(prev) {
    const last = prev?.length ? prev[prev.length - 1] : null;
    const txt = String(last?.message || last?.text || "");
    return last?.role === "assistant" && last?.type === "text" && txt.includes("couldn’t reach the coach");
  }

  function addPlanCardToChat(planObj, mermaidCode) {
    const finalPlan = ensureResourcesOnSteps(planObj);

    setMessages((prev) => [
      ...prev,
      { id: uid("msg"), role: "assistant", type: "plan", mode: "coach", plan: finalPlan, mermaid: mermaidCode, accepted: false },
      { id: uid("msg"), role: "assistant", type: "plan_accept", mode: "coach", planId: finalPlan.id, accepted: false },
    ]);
  }

  async function callCoachBackend(outboundText, didRetry = false) {
    const mySeq = ++reqSeqRef.current;
    const topic = mapNeedToBackendTopic(needKey, focus, customNeedLabel);

    try {
      const res = await axios.post(
        `${API_BASE}/chat`,
        { user_id: userId, message: outboundText, coach: coachId, profile, topic },
        { timeout: AXIOS_TIMEOUT_MS }
      );

      if (mySeq !== reqSeqRef.current) return;

      const data = res.data || {};

      const ui = data.ui || {};
      const uiState = {
        mode: ui.mode || "CHAT",
        show_plan_sidebar: !!ui.show_plan_sidebar,
        plan_link: ui.plan_link || null,
        mermaid: ui.mermaid || null,
      };
      setBackendUI(uiState);

      // Text messages from backend
      const backendMessages = Array.isArray(data.messages) ? data.messages : [];
      let lastAssistantText = "";

      if (backendMessages.length > 0) {
        const texts = backendMessages.map((m) => String(m?.text || "").trim()).filter(Boolean);
        lastAssistantText = texts.length ? texts[texts.length - 1] : "";

        setMessages((prev) => [
          ...prev,
          ...texts.map((text) => ({ id: uid("msg"), role: "assistant", type: "text", mode: "coach", message: text })),
        ]);
      }

      // Plan card when backend returns structured plan
      if (data.plan && typeof data.plan === "object") {
        let planObj = adaptBackendPlanToUI(data.plan, focus, needKey, currentNeedLabel());
        planObj = ensureResourcesOnSteps(planObj);

        const steps = Array.isArray(planObj.steps) ? planObj.steps : [];
        const mermaidCode =
          uiState.mermaid && String(uiState.mermaid).trim()
            ? String(uiState.mermaid)
            : buildFallbackMermaidFromSteps(planObj.title, steps.map((s) => s.label));

        addPlanCardToChat(planObj, mermaidCode);
        return;
      }

      // ✅ Fallback: if backend only returned numbered steps text, create a plan anyway
      if (lastAssistantText) {
        const extracted = extractPlanFromText(lastAssistantText);
        if (extracted?.steps?.length) {
          let planObj = {
            id: uid("plan"),
            title: `${currentNeedLabel()} Plan`,
            goal: "",
            focus,
            needKey,
            needLabel: currentNeedLabel(),
            steps: extracted.steps.map((label, i) => ({
              id: `S${i + 1}`,
              label: String(label || "").trim(),
              resources: defaultResourcesForStep(label).slice(0, 3),
            })),
            createdAt: new Date().toISOString(),
            acceptedAt: null,
          };

          planObj = ensureResourcesOnSteps(planObj);
          const mermaidCode = buildFallbackMermaidFromSteps(planObj.title, extracted.steps);

          addPlanCardToChat(planObj, mermaidCode);
        }
      }
    } catch (err) {
      if (mySeq !== reqSeqRef.current) return;

      // One silent retry
      if (!didRetry) {
        await new Promise((r) => setTimeout(r, 800));
        return callCoachBackend(outboundText, true);
      }

      const msg = getAxiosErrorMessage(err);
      const finalText =
        msg === "Request timed out."
          ? "Sorry — the coach is taking too long. Please try sending again."
          : "Sorry — I couldn’t reach the coach just now. Please try again.";

      setMessages((prev) => {
        if (alreadyHasRecentReachError(prev) && finalText.includes("couldn’t reach the coach")) return prev;
        return [...prev, { id: uid("msg"), role: "assistant", type: "text", mode: "chat", message: finalText }];
      });
    }
  }

  async function syncBaselineToBackend(level) {
    const topic = mapNeedToBackendTopic(needKey, focus, customNeedLabel);
    try {
      await axios.post(
        `${API_BASE}/chat`,
        { user_id: userId, message: String(level), coach: coachId, profile, topic },
        { timeout: AXIOS_TIMEOUT_MS }
      );
    } catch {
      // ignore
    }
  }

  function saveConfidence(level) {
    const t = todayStr();
    const conf = loadSaved(confidenceKey, {}) || {};
    const prevBaseline = typeof conf?.baseline === "number" ? conf.baseline : null;

    const updated = {
      baseline: prevBaseline ?? level,
      lastCheckDate: t,
      history: Array.isArray(conf?.history) ? conf.history.slice() : [],
      needLabel: currentNeedLabel(),
      focus,
    };

    updated.history = updated.history.filter((x) => x?.date !== t);
    updated.history.push({ date: t, level });

    save(confidenceKey, updated);
    return { updated, prevBaseline };
  }

  const handleDailyProgress = async (didProgress) => {
    if (loading || sendingRef.current) return;

    const fLabel = focusLabel(focus);
    const nLabel = currentNeedLabel();

    setAwaitingDailyProgress(false);

    setMessages((prev) => [...prev, { id: uid("msg"), role: "user", text: didProgress ? "Yes, I did." : "Not yet.", type: "text" }]);

    if (didProgress) {
      setAwaitingDailyConfidence(true);
      upsertSystemMessage(setMessages, {
        id: `system_daily_conf_${focus}_${needSlug}`,
        role: "assistant",
        type: "system",
        kind: "daily_conf_prompt",
        mode: "coach",
        message: `Nice — that matters ✅\nOn the same 1–10 scale, what’s your confidence for **${nLabel}** right now?`,
      });
      return;
    }

    setLoading(true);
    sendingRef.current = true;
    try {
      await callCoachBackend(
        `I didn’t get a chance to work on my ${fLabel} plan for "${nLabel}". Please give practical time-management tips and one tiny next step I can do in 5 minutes.`
      );
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  };

  const sendMessage = async () => {
    if (sendingRef.current) return;
    if (!input.trim() || loading) return;

    if (needKey === "custom" && !customNeedLabel.trim()) {
      setMessages((prev) => [
        ...prev,
        { id: uid("msg"), role: "assistant", type: "text", mode: "coach", message: 'Quick one — what would you like to call this confidence area? (Example: “Executive presence”)' },
      ]);
      return;
    }

    sendingRef.current = true;

    const userText = input.trim();
    setInput("");
    setLoading(true);

    if (!isGreeting(userText)) setHasUserSpoken(true);

    const askedPlan = userAskedForPlan(userText);
    if (askedPlan) setReadyForBaseline(true);

    setMessages((prev) => [...prev, { id: uid("msg"), role: "user", text: userText, type: "text" }]);

    const fLabel = focusLabel(focus);
    const nLabel = currentNeedLabel();

    try {
      // If user asked for a plan and we don't have baseline yet -> store request and ask baseline first
      const conf = loadSaved(confidenceKey, null);
      const hasBaseline = conf && typeof conf?.baseline === "number";

      if (askedPlan && !hasBaseline && !awaitingBaseline && !awaitingBaselineReason) {
        saveSession(pendingKey, userText);
        setAwaitingBaseline(true);

        upsertSystemMessage(setMessages, {
          id: `system_baseline_${focus}_${needSlug}`,
          role: "assistant",
          type: "system",
          kind: "baseline_prompt",
          mode: "coach",
          message: `Before we go deeper on **${nLabel}** (${fLabel}), quick baseline.\nOn a scale from 1–10, what is your confidence level right now?`,
        });
        return;
      }

      if (awaitingBaselineReason) {
        setAwaitingBaselineReason(false);

        const pending = loadSession(pendingKey, null);
        saveSession(pendingKey, null);

        const combined =
          pending && String(pending).trim()
            ? `Baseline set for "${nLabel}" (${fLabel}). The main reason I’m not more confident is: ${userText}. Also, my original request was: "${pending}". Please respond with empathy + practical suggestions, and create/refine a clear step-by-step plan.`
            : `Baseline set for "${nLabel}" (${fLabel}). The main reason I’m not more confident is: ${userText}. Help me with empathy + practical suggestions, and (if useful) refine my existing plan.`;

        await callCoachBackend(combined);
        return;
      }

      if (awaitingBaseline) {
        const level = parseConfidence(userText);
        if (level == null) {
          setMessages((prev) => [
            ...prev,
            { id: uid("msg"), role: "assistant", type: "text", mode: "coach", message: "Please reply with a number from 1 to 10 (for example: 6)." },
          ]);
          return;
        }

        saveConfidence(level);
        await syncBaselineToBackend(level);

        setAwaitingBaseline(false);
        setAwaitingBaselineReason(true);

        setMessages((prev) => prev.filter((m) => !(m.type === "system" && m.kind === "baseline_prompt")));

        upsertSystemMessage(setMessages, {
          id: `system_baseline_reason_${focus}_${needSlug}`,
          role: "assistant",
          type: "system",
          kind: "baseline_reason_prompt",
          mode: "coach",
          message: `Got it — baseline saved as ${level}/10 for **${nLabel}**. ✅\nWhat’s the main reason it feels like a ${level} (and not higher)?`,
        });
        return;
      }

      if (awaitingDailyConfidence) {
        const level = parseConfidence(userText);
        if (level == null) {
          setMessages((prev) => [
            ...prev,
            { id: uid("msg"), role: "assistant", type: "text", mode: "coach", message: "Please reply with a number from 1 to 10 (for example: 6)." },
          ]);
          return;
        }

        saveConfidence(level);
        setAwaitingDailyConfidence(false);

        await callCoachBackend(`My confidence for "${nLabel}" (${fLabel}) right now is ${level}/10. I made progress on my plan. Reflect the change and suggest what to do next.`);
        return;
      }

      await callCoachBackend(`[Need: ${nLabel}] ${userText}`);
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  };

  // Clear chat ALSO clears "Plans from this conversation"
  const clearChat = () => {
    localStorage.removeItem(chatKey);
    sessionStorage.removeItem(convPlansKey);
    saveSession(pendingKey, null);
    setMessages([]);
    setConvPlans([]);
  };

  const styles = {
    page: { maxWidth: 1200, margin: "0 auto", padding: 16, color: "var(--text-primary, #111827)" },
    layout: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 16, alignItems: "start" },
    panel: {
      marginTop: 12,
      marginBottom: 12,
      border: "1px solid var(--border-soft, #e5e7eb)",
      borderRadius: 12,
      padding: 12,
      height: "calc(100vh - 240px)",
      minHeight: 420,
      overflowY: "auto",
      background: "var(--bg-page, #ffffff)",
    },
    sidePanel: {
      marginTop: 12,
      border: "1px solid var(--border-soft, #e5e7eb)",
      borderRadius: 12,
      padding: 12,
      background: "var(--bg-page, #ffffff)",
      position: "sticky",
      top: 12,
      maxHeight: "calc(100vh - 120px)",
      overflowY: "auto",
    },
    input: {
      width: "100%",
      padding: 10,
      boxSizing: "border-box",
      borderRadius: 10,
      border: "1px solid var(--border-soft, #e5e7eb)",
      height: 42,
      background: "var(--bg-page, #ffffff)",
      color: "var(--text-primary, #111827)",
    },
    muted: { opacity: 0.8, color: "var(--text-muted, #6b7280)" },
    bubbleUser: { background: "var(--bg-chat-user, #111827)", color: "#fff", borderRadius: 12, padding: 12, whiteSpace: "pre-wrap", lineHeight: 1.45 },
    bubbleCoach: { background: "var(--bg-chat-coach, #f3f4f6)", color: "#111827", borderRadius: 12, padding: 12, whiteSpace: "pre-wrap", lineHeight: 1.45 },
    btn: {
      height: 36,
      borderRadius: 10,
      border: "1px solid var(--border-soft, #e5e7eb)",
      background: "#fff",
      color: "#111827",
      padding: "0 12px",
      cursor: "pointer",
    },
    primaryBtn: {
      height: 36,
      borderRadius: 10,
      border: "1px solid var(--border-soft, #e5e7eb)",
      background: "#111827",
      color: "#fff",
      padding: "0 12px",
      cursor: "pointer",
    },
    card: { border: "1px solid var(--border-soft, #e5e7eb)", borderRadius: 12, padding: 10, background: "#fff" },
    badge: {
      display: "inline-block",
      fontSize: 12,
      padding: "2px 8px",
      borderRadius: 999,
      border: "1px solid var(--border-soft, #e5e7eb)",
      opacity: 0.9,
      marginLeft: 8,
    },
    sendBtn: {
      marginTop: 8,
      height: 42,
      borderRadius: 10,
      border: "1px solid var(--border-soft, #e5e7eb)",
      background: "#111827",
      color: "#fff",
      padding: "0 14px",
      cursor: "pointer",
      opacity: loading ? 0.7 : 1,
    },
    hint: { fontSize: 12, marginTop: 6, opacity: 0.85, color: "var(--text-muted, #6b7280)" },
    resources: { marginTop: 6, fontSize: 13, opacity: 0.92 },
    linkList: { margin: "6px 0 0", paddingLeft: 18 },
    progressBtns: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" },
    needRow: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
    select: {
      height: 36,
      borderRadius: 10,
      border: "1px solid var(--border-soft, #e5e7eb)",
      padding: "0 10px",
      background: "#fff",
      color: "#111827",
    },
    smallInput: { height: 36, borderRadius: 10, border: "1px solid var(--border-soft, #e5e7eb)", padding: "0 10px", background: "#fff", color: "#111827", minWidth: 220 },
  };

  const showConfidenceHint = awaitingBaseline || awaitingDailyConfidence;
  const needLabel = currentNeedLabel();

  const activeNeedHint = (() => {
    const active = loadSaved(activeNeedStorage, null);
    if (!active) return null;
    return String(active);
  })();

  return (
    <div style={styles.page}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0 }}>Better Me</h2>
          <div style={{ ...styles.muted, marginTop: 6 }}>
            Focus: <b>{focusLabel(focus)}</b> • Need: <b>{needLabel}</b>
            {backendUI?.mode ? <span style={styles.badge}>{String(backendUI.mode).toUpperCase()}</span> : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => navigate("/plans")} style={styles.btn}>
            Your All Plans
          </button>
          <button onClick={() => navigate("/focus")} style={styles.btn}>
            Change focus
          </button>
          <button onClick={clearChat} style={styles.btn}>
            Clear chat (and conversation plans)
          </button>
        </div>
      </div>

      {/* Need selector */}
      <div style={{ marginTop: 12, ...styles.card }}>
        <div style={styles.needRow}>
          <div style={{ fontWeight: 800 }}>What confidence area are we working on?</div>

          <select value={needKey} onChange={(e) => setNeedKey(e.target.value)} style={styles.select} disabled={loading}>
            {NEED_OPTIONS.map((n) => (
              <option key={n.key} value={n.key}>
                {n.label}
              </option>
            ))}
          </select>

          {needKey === "custom" && (
            <>
              <input
                value={customNeedLabel}
                onChange={(e) => setCustomNeedLabel(e.target.value)}
                placeholder='Name it (e.g., "Executive presence")'
                style={styles.smallInput}
                disabled={loading}
              />
              <span style={styles.muted}>Each custom name gets its own confidence baseline.</span>
            </>
          )}

          {activeNeedHint && (
            <span style={{ ...styles.muted, marginLeft: "auto" }}>
              Active daily check-in need: <b>{activeNeedHint}</b>
            </span>
          )}
        </div>
      </div>

      <div className="chat-layout" style={styles.layout}>
        {/* LEFT: Chat */}
        <div>
          <div ref={listRef} style={styles.panel}>
            {messages.length === 0 && <div style={styles.muted}>Say what’s on your mind — I’ll respond like a real conversation.</div>}

            {messages.map((m, i) => {
              const isUser = m.role === "user";
              const avatarImg = isUser ? userAvatar?.img : coach.avatar;
              const name = isUser ? "You" : coach.name;

              return (
                <div key={m.id || i} style={{ display: "flex", alignItems: "flex-start", marginBottom: 12 }}>
                  <img src={avatarImg} alt={name} width={36} height={36} style={{ borderRadius: "50%", marginRight: 10 }} />

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{name}</div>

                    {isUser ? (
                      <div style={styles.bubbleUser}>{m.text}</div>
                    ) : m.type === "daily_progress" ? (
                      <div style={styles.bubbleCoach}>
                        <div>{m.message}</div>
                        <div style={styles.progressBtns}>
                          <button style={styles.primaryBtn} onClick={() => handleDailyProgress(true)}>
                            Yes, I did
                          </button>
                          <button style={styles.btn} onClick={() => handleDailyProgress(false)}>
                            Not yet
                          </button>
                        </div>
                      </div>
                    ) : m.type === "plan" ? (
                      <div style={styles.bubbleCoach}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>
                          {m.plan?.title || "Plan"}
                          {m.plan?.focus && <span style={styles.badge}>{m.plan.focus}</span>}
                          {m.plan?.needLabel && <span style={styles.badge}>{m.plan.needLabel}</span>}
                          {m.plan?.id && <span style={styles.badge}>#{String(m.plan.id).slice(-4)}</span>}
                        </div>

                        {m.plan?.goal && <div style={{ marginBottom: 10, opacity: 0.9 }}>{m.plan.goal}</div>}

                        <div style={{ ...styles.card, marginBottom: 10 }}>
                          <MermaidDiagram code={m.mermaid} />
                        </div>

                        {Array.isArray(m.plan?.steps) && m.plan.steps.length > 0 && (
                          <div style={{ marginTop: 8 }}>
                            <ol style={{ margin: 0, paddingLeft: 18 }}>
                              {m.plan.steps.map((s) => (
                                <li key={s.id} style={{ marginBottom: 10 }}>
                                  <div>{s.label}</div>

                                  {Array.isArray(s.resources) && s.resources.length > 0 && (
                                    <div style={styles.resources}>
                                      <div style={{ fontWeight: 700, marginBottom: 4 }}>Learning links</div>
                                      <ul style={styles.linkList}>
                                        {s.resources.slice(0, 3).map((r, idx) => (
                                          <li key={idx} style={{ marginBottom: 4 }}>
                                            <a href={r.url} target="_blank" rel="noreferrer">
                                              {r.title}
                                            </a>
                                            {r.type ? <span style={{ opacity: 0.75 }}> ({r.type})</span> : null}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}

                        {m.accepted && <div style={{ marginTop: 10, fontWeight: 700, opacity: 0.85 }}>✅ Accepted (saved)</div>}
                      </div>
                    ) : m.type === "plan_accept" && !m.accepted ? (
                      <div style={styles.bubbleCoach}>
                        <div style={{ fontWeight: 700, marginBottom: 8 }}>Do you accept this plan?</div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            style={styles.primaryBtn}
                            onClick={() => {
                              const planMsg = messages.find((x) => x.type === "plan" && x.plan?.id === m.planId);
                              if (planMsg?.plan) acceptPlan(planMsg.plan);
                            }}
                          >
                            Accept
                          </button>
                          <button style={styles.btn} onClick={revisePlan}>
                            Revise
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={styles.bubbleCoach}>
                        <div>{m.message || m.text}</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {loading && (
              <div style={{ display: "flex", alignItems: "center", opacity: 0.85, marginTop: 8 }}>
                <img src={coach.avatar} alt={coach.name} width={36} height={36} style={{ borderRadius: "50%", marginRight: 10 }} />
                <div>
                  <div style={{ fontWeight: 700 }}>{coach.name}</div>
                  <div style={styles.muted}>typing…</div>
                </div>
              </div>
            )}
          </div>

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              awaitingBaseline
                ? "Reply with a number 1–10…"
                : awaitingDailyConfidence
                ? "Reply with a number 1–10…"
                : awaitingBaselineReason
                ? "Tell me the main reason…"
                : awaitingDailyProgress
                ? "Use the buttons above…"
                : "Say something…"
            }
            style={styles.input}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!e.repeat) sendMessage();
              }
            }}
            disabled={awaitingDailyProgress}
          />

          {(showConfidenceHint || awaitingBaselineReason) && (
            <div style={styles.hint}>
              {showConfidenceHint ? (
                <>
                  Tip: type a number from <b>1</b> to <b>10</b> (example: <b>6</b>).
                </>
              ) : (
                <>Tip: one sentence is enough 🙂</>
              )}
            </div>
          )}

          <button onClick={sendMessage} disabled={loading || awaitingDailyProgress} style={styles.sendBtn}>
            {loading ? "Sending…" : "Send"}
          </button>
        </div>

        {/* RIGHT: Plans from this conversation (with links) */}
        <div className="conv-sidebar" style={styles.sidePanel}>
          <ConversationPlansSidebarInline plans={convPlans} />
        </div>
      </div>
    </div>
  );
}
