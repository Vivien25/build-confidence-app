import { useEffect, useRef, useState } from "react";
import axios from "axios";
import mermaid from "mermaid";
import { getProfile } from "../utils/profile";
import { avatarMap, coachAvatar } from "../utils/avatars";
import { useNavigate } from "react-router-dom";
import ConversationPlansSidebar from "../components/ConversationPlansSidebar";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

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

// ✅ key fix: treat greetings as NOT "user spoke"
function isGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  return /^(hi|hello|hey|hiya|yo)[!.\s]*$/.test(t);
}

// ✅ NEW: detect plan intent (so we can delay baseline questions)
function userAskedForPlan(text) {
  const t = String(text || "").toLowerCase();
  return /\b(plan|steps|roadmap|action items|what should i do|next steps|help me|can you help|strategy|schedule)\b/.test(t);
}

const NEED_OPTIONS = [
  { key: "interview", label: "Interview confidence" },
  { key: "presentation", label: "Presentation confidence" },
  { key: "communication", label: "Communication confidence" },
  { key: "networking", label: "Networking confidence" },
  { key: "leadership", label: "Leadership confidence" },
  { key: "negotiation", label: "Negotiation confidence" },
  { key: "custom", label: "Other (custom)" },
];

// ✅ supports steps as strings OR objects {label, resources:[{title,url,type}]}
function buildPlanFromSteps({ focus, needKey, needLabel, steps }) {
  const id = uid("plan");
  const title = `${titleCase(focus)} • ${needLabel || "Plan"}`;
  const goal = "Follow the steps below for the next 7 days.";
  return {
    id,
    title,
    goal,
    focus,
    needKey,
    needLabel,
    steps: steps.map((s, i) => {
      if (typeof s === "string") return { id: `S${i + 1}`, label: String(s) };
      return {
        id: `S${i + 1}`,
        label: String(s?.label || ""),
        resources: Array.isArray(s?.resources) ? s.resources : [],
      };
    }),
    createdAt: new Date().toISOString(),
    acceptedAt: null,
  };
}

function planToMermaid(plan) {
  const safe = (t) => String(t || "").replace(/"/g, '\\"');
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const first = steps?.[0]?.id || "S1";

  const nodes = steps.map((s) => `${s.id}["${safe(s.label)}"]`).join("\n");
  const edges = steps
    .slice(0, -1)
    .map((_, i) => `${steps[i].id} --> ${steps[i + 1].id}`)
    .join("\n");

  return `flowchart TD
A["${safe(plan?.title || "Plan")}"] --> ${first}
${nodes}
${edges}
`;
}

function MermaidDiagram({ code }) {
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        if (!ref.current) return;
        const id = `mmd-${Math.random().toString(16).slice(2)}`;
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
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

function toHistory(messages, limit = 12) {
  return messages
    .slice(-limit)
    .map((m) => {
      const role = m.role === "user" ? "user" : "assistant";
      let content = "";

      if (m.type === "plan" && m.plan) {
        content = `Plan: ${m.plan.title}. Steps: ${(m.plan.steps || []).map((s) => s.label).join("; ")}`;
      } else {
        content = String(m.text || m.message || "");
      }

      content = content.trim();
      if (!content) return null;
      return { role, content };
    })
    .filter(Boolean);
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

export default function Chat() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(() => getProfile() || {});

  useEffect(() => {
    setProfile(getProfile() || {});
  }, []);

  const userAvatarKey = profile?.avatar ?? "neutral";
  const userAvatar = avatarMap[userAvatarKey];
  const coach = coachAvatar;

  const userId = profile?.user_id || "local-dev";
  const focus = profile?.focus || "work";

  // ✅ need selection (localStorage)
  const needKeyStorage = `bc_need_${userId}_${focus}`;
  const customNeedLabelStorage = `bc_need_custom_label_${userId}_${focus}`;
  const activeNeedStorage = `bc_active_need_${userId}_${focus}`;

  // ----- Need state -----
  const [needKey, setNeedKey] = useState(() => {
    const active = loadSaved(activeNeedStorage, null);
    if (active) return String(active);
    const saved = loadSaved(needKeyStorage, null);
    return saved ? String(saved) : "interview";
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

  // ✅ per-need chat storage
  const chatKey = `bc_chat_${userId}_${focus}_${needSlug}`;

  // ✅ persistent across app
  const plansKey = `bc_plans_${userId}`;

  // ✅ per focus “Plans from this conversation” (sessionStorage)
  const convPlansKey = `bc_conv_plans_${userId}_${focus}`;

  // ✅ confidence state per focus + needKey (localStorage)
  const confidenceKey = `bc_conf_${userId}_${focus}_${needSlug}`;

  // ✅ Only start baseline/daily prompts after user speaks this visit
  const hasSpokenKey = `bc_has_spoken_${userId}_${focus}_${needSlug}`;
  const [hasUserSpoken, setHasUserSpoken] = useState(() => loadSession(hasSpokenKey, false));
  useEffect(() => {
    saveSession(hasSpokenKey, hasUserSpoken);
  }, [hasSpokenKey, hasUserSpoken]);

  // ✅ NEW: only start baseline prompts after the user asks for a plan (this visit)
  const readyKey = `bc_ready_for_baseline_${userId}_${focus}_${needSlug}`;
  const [readyForBaseline, setReadyForBaseline] = useState(() => loadSession(readyKey, false));
  useEffect(() => {
    saveSession(readyKey, readyForBaseline);
  }, [readyKey, readyForBaseline]);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const sendingRef = useRef(false);

  const [plans, setPlans] = useState([]);
  const [convPlans, setConvPlans] = useState([]);

  const [plansHydrated, setPlansHydrated] = useState(false);
  const [convPlansHydrated, setConvPlansHydrated] = useState(false);

  // Confidence gating
  const [awaitingBaseline, setAwaitingBaseline] = useState(false);
  const [awaitingBaselineReason, setAwaitingBaselineReason] = useState(false);

  // Daily flow gating (progress-first)
  const [awaitingDailyProgress, setAwaitingDailyProgress] = useState(false);
  const [awaitingDailyConfidence, setAwaitingDailyConfidence] = useState(false);

  const listRef = useRef(null);

  // Load per-need chat messages
  useEffect(() => {
    setMessages(loadSaved(chatKey, []));
  }, [chatKey]);

  // Load global plans
  useEffect(() => {
    const p = loadSaved(plansKey, []);
    setPlans(Array.isArray(p) ? p : []);
    setPlansHydrated(true);
  }, [plansKey]);

  // Refresh "Plans from this conversation" every time you ENTER /chat
  useEffect(() => {
    sessionStorage.removeItem(convPlansKey);
    setConvPlans([]);
    setConvPlansHydrated(true);
  }, [convPlansKey]);

  // Persist chat
  useEffect(() => {
    save(chatKey, messages);
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, chatKey]);

  // Persist global plans ONLY after hydration
  useEffect(() => {
    if (!plansHydrated) return;
    save(plansKey, plans);
  }, [plansKey, plans, plansHydrated]);

  // Persist conversation plans (sessionStorage) ONLY after hydration
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

  // Reset gating when need changes + remove stale system prompts
  useEffect(() => {
    setAwaitingBaseline(false);
    setAwaitingBaselineReason(false);
    setAwaitingDailyProgress(false);
    setAwaitingDailyConfidence(false);

    // ✅ allow short chat again when switching needs (fresh visit behavior)
    setReadyForBaseline(false);

    setMessages((prev) =>
      prev.filter(
        (m) =>
          !(
            m.type === "system" &&
            (m.kind === "baseline_prompt" ||
              m.kind === "baseline_reason_prompt" ||
              m.kind === "daily_prompt" ||
              m.kind === "daily_conf_prompt")
          )
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, customNeedLabel, focus]);

  // Baseline trigger + daily check-in trigger (per need)
  useEffect(() => {
    // ✅ NEW: do NOT prompt baseline at the beginning.
    // Only prompt once the user has spoken AND asked for a plan (readyForBaseline).
    if (!hasUserSpoken || !readyForBaseline) return;

    const conf = loadSaved(confidenceKey, null);
    const t = todayStr();
    const fLabel = focusLabel(focus);
    const nLabel = currentNeedLabel();

    if (needKey === "custom" && !customNeedLabel.trim()) return;

    // If no baseline yet -> ask baseline number
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
          message:
            `Before I create your plan for **${nLabel}** (${fLabel}), I want to understand where you are now.\n` +
            `On a scale from 1–10, what is your current confidence level?`,
        });
      }
      return;
    }

    // Baseline exists: if we haven't checked in today, ask PROGRESS first
    const lastChecked = String(conf?.lastCheckDate || "");
    if (lastChecked !== t) {
      if (!awaitingDailyProgress && !awaitingDailyConfidence) {
        setAwaitingDailyProgress(true);
        setAwaitingBaseline(false);
        setAwaitingBaselineReason(false);

        // ✅ IMPORTANT: use type "daily_progress" so UI shows buttons
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
  }, [hasUserSpoken, readyForBaseline, confidenceKey, focus, needKey, customNeedLabel]);

  const acceptPlan = (planObj) => {
    const accepted = { ...planObj, acceptedAt: new Date().toISOString() };

    const activeNeedKey =
      accepted?.needKey === "custom"
        ? `custom_${slugify(accepted?.needLabel) || "custom"}`
        : accepted?.needKey || needKey;

    save(activeNeedStorage, activeNeedKey);

    // Global plans (for /plans)
    setPlans((prev) => {
      const dedup = prev.filter((p) => p.id !== accepted.id);
      return [accepted, ...dedup];
    });

    // Plans from this conversation
    setConvPlans((prev) => {
      const dedup = prev.filter((p) => p.id !== accepted.id);
      return [accepted, ...dedup];
    });

    // Mark accepted in chat
    setMessages((prev) =>
      prev.map((m) => {
        if (m.type === "plan" && m.plan?.id === planObj.id) return { ...m, accepted: true };
        if (m.type === "plan_accept" && m.planId === planObj.id) return { ...m, accepted: true };
        return m;
      })
    );

    setMessages((prev) => [
      ...prev,
      {
        id: uid("msg"),
        role: "assistant",
        type: "text",
        mode: "coach",
        message: `Saved ✅ Added to this conversation and your All Plans page.\n(Active need: ${
          accepted.needLabel || currentNeedLabel()
        })`,
      },
    ]);
  };

  const revisePlan = () => {
    setMessages((prev) => [
      ...prev,
      {
        id: uid("msg"),
        role: "assistant",
        type: "text",
        mode: "coach",
        message:
          "Sure — what would you like to change? (Examples: make it easier, shorter, more detailed, or change the goal.)",
      },
    ]);
  };

  async function callCoachBackend(outboundText, currentMessages) {
    const history = toHistory(currentMessages, 12);

    const res = await axios.post(`${API_BASE}/chat`, {
      user_id: userId,
      focus,
      need_key: needKey,
      need_label: currentNeedLabel(),
      message: outboundText,
      history,
    });

    const mode = String(res.data?.mode || "chat").toLowerCase();
    const message = String(res.data?.message || "").trim();
    const planRaw = Array.isArray(res.data?.plan) ? res.data.plan : [];

    if (message) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid("msg"),
          role: "assistant",
          type: "text",
          mode: mode === "coach" ? "coach" : "chat",
          message,
        },
      ]);
    }

    const cleanedSteps = planRaw
      .map((x) => (typeof x === "string" ? x.trim() : x))
      .filter((x) => (typeof x === "string" ? x.trim() : String(x?.label || "").trim()))
      .slice(0, 6);

    if (cleanedSteps.length > 0) {
      const planObj = buildPlanFromSteps({
        focus,
        needKey,
        needLabel: currentNeedLabel(),
        steps: cleanedSteps,
      });
      const diagram = planToMermaid(planObj);

      setMessages((prev) => [
        ...prev,
        {
          id: uid("msg"),
          role: "assistant",
          type: "plan",
          mode: "coach",
          plan: planObj,
          mermaid: diagram,
          accepted: false,
        },
        {
          id: uid("msg"),
          role: "assistant",
          type: "plan_accept",
          mode: "coach",
          planId: planObj.id,
          accepted: false,
        },
      ]);
    }
  }

  // ✅ NEW: silently sync baseline to backend to prevent backend mis-parsing "1) 2) 3)" etc.
  async function syncBaselineToBackend(level, currentMessages) {
    try {
      const history = toHistory(currentMessages, 12);
      await axios.post(`${API_BASE}/chat`, {
        user_id: userId,
        focus,
        need_key: needKey,
        need_label: currentNeedLabel(),
        message: String(level), // IMPORTANT: only the number
        history,
      });
    } catch {
      // ignore (frontend still works)
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

    setMessages((prev) => [
      ...prev,
      {
        id: uid("msg"),
        role: "user",
        text: didProgress ? "Yes, I did." : "Not yet.",
        type: "text",
      },
    ]);

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
    try {
      const nextMessages = [...messages, { id: uid("msg"), role: "user", text: "Not yet." }];

      await callCoachBackend(
        `I didn’t get a chance to work on my ${fLabel} plan for "${nLabel}". ` +
          `Please give practical time-management tips and one tiny next step I can do in 5 minutes. ` +
          `If you propose tasks, include learning links per task.`,
        nextMessages
      );
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async () => {
    if (sendingRef.current) return;
    if (!input.trim() || loading) return;

    if (needKey === "custom" && !customNeedLabel.trim()) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid("msg"),
          role: "assistant",
          type: "text",
          mode: "coach",
          message: "Quick one — what would you like to call this confidence area? (Example: “Executive presence”)",
        },
      ]);
      return;
    }

    sendingRef.current = true;

    const userText = input.trim();
    setInput("");
    setLoading(true);

    // ✅ only mark "hasUserSpoken" if not a greeting
    if (!isGreeting(userText)) {
      setHasUserSpoken(true);
    }

    // ✅ NEW: unlock baseline prompts only after user asks for a plan
    if (!readyForBaseline && userAskedForPlan(userText)) {
      setReadyForBaseline(true);
    }

    const userMsgObj = { id: uid("msg"), role: "user", text: userText };
    const nextMessages = [...messages, userMsgObj];
    setMessages(nextMessages);

    const fLabel = focusLabel(focus);
    const nLabel = currentNeedLabel();

    try {
      if (awaitingBaselineReason) {
        setAwaitingBaselineReason(false);

        // ✅ safer text: no numbered "1) 2) 3)" which can confuse the backend
        await callCoachBackend(
          `Baseline set for "${nLabel}" (${fLabel}). The main reason I’m not more confident is: ${userText}. ` +
            `Please respond with empathy, give a few suggestions, include learning links, and propose a short plan for "${nLabel}".`,
          nextMessages
        );
        return;
      }

      if (awaitingBaseline) {
        const level = parseConfidence(userText);
        if (level == null) {
          setMessages((prev) => [
            ...prev,
            {
              id: uid("msg"),
              role: "assistant",
              type: "text",
              mode: "coach",
              message: "Please reply with a number from 1 to 10 (for example: 6).",
            },
          ]);
          return;
        }

        saveConfidence(level);

        // ✅ NEW: keep backend baseline in sync
        await syncBaselineToBackend(level, nextMessages);

        setAwaitingBaseline(false);
        setAwaitingBaselineReason(true);

        // ✅ remove old baseline prompt so it doesn't look like it's repeating
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
            {
              id: uid("msg"),
              role: "assistant",
              type: "text",
              mode: "coach",
              message: "Please reply with a number from 1 to 10 (for example: 6).",
            },
          ]);
          return;
        }

        saveConfidence(level);
        setAwaitingDailyConfidence(false);

        await callCoachBackend(
          `My confidence for "${nLabel}" (${fLabel}) right now is ${level}/10. I made progress on my plan. ` +
            `Please reflect the change and suggest what to do next. If you propose tasks, include learning links per task.`,
          nextMessages
        );
        return;
      }

      await callCoachBackend(`[Need: ${nLabel}] ${userText}`, nextMessages);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: uid("msg"),
          role: "assistant",
          type: "text",
          mode: "chat",
          message: "Sorry — something went wrong while talking to the coach.",
        },
      ]);
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  };

  const clearChat = () => {
    localStorage.removeItem(chatKey);
    setMessages([]);
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
    bubbleUser: {
      background: "var(--bg-chat-user, #111827)",
      color: "var(--text-inverse, #ffffff)",
      borderRadius: 12,
      padding: 12,
      whiteSpace: "pre-wrap",
      lineHeight: 1.45,
    },
    bubbleCoach: {
      background: "var(--bg-chat-coach, #f3f4f6)",
      color: "var(--text-primary, #111827)",
      borderRadius: 12,
      padding: 12,
      whiteSpace: "pre-wrap",
      lineHeight: 1.45,
    },
    btn: {
      height: 36,
      borderRadius: 10,
      border: "1px solid var(--border-soft, #e5e7eb)",
      background: "var(--bg-page, #ffffff)",
      color: "var(--text-primary, #111827)",
      padding: "0 12px",
      cursor: "pointer",
    },
    primaryBtn: {
      height: 36,
      borderRadius: 10,
      border: "1px solid var(--border-soft, #e5e7eb)",
      background: "var(--bg-chat-user, #111827)",
      color: "var(--text-inverse, #ffffff)",
      padding: "0 12px",
      cursor: "pointer",
    },
    card: { border: "1px solid var(--border-soft, #e5e7eb)", borderRadius: 12, padding: 10, background: "var(--bg-page, #ffffff)" },
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
      background: "var(--bg-chat-user, #111827)",
      color: "var(--text-inverse, #ffffff)",
      padding: "0 14px",
      cursor: loading ? "not-allowed" : "pointer",
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
      background: "var(--bg-page, #ffffff)",
      color: "var(--text-primary, #111827)",
    },
    smallInput: {
      height: 36,
      borderRadius: 10,
      border: "1px solid var(--border-soft, #e5e7eb)",
      padding: "0 10px",
      background: "var(--bg-page, #ffffff)",
      color: "var(--text-primary, #111827)",
      minWidth: 220,
    },
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
          <h2 style={{ margin: 0 }}>Build Confidence</h2>
          <div style={{ ...styles.muted, marginTop: 6 }}>
            Focus: <b>{focusLabel(focus)}</b> • Need: <b>{needLabel}</b>
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
            Clear chat (current need)
          </button>
        </div>
      </div>

      {/* Need selector */}
      <div style={{ marginTop: 12, ...styles.card }}>
        <div style={styles.needRow}>
          <div style={{ fontWeight: 800 }}>What confidence area are we working on?</div>

          <select
            value={needKey}
            onChange={(e) => setNeedKey(e.target.value)}
            style={styles.select}
            disabled={loading}
            title="Select a specific need (each need has its own baseline)"
          >
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
              const avatarImg = isUser ? userAvatar?.img : coach.img;
              const name = isUser ? "You" : "Coach";

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

                        {m.accepted && (
                          <div style={{ marginTop: 10, fontWeight: 700, opacity: 0.85 }}>
                            ✅ Accepted (saved)
                          </div>
                        )}
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
                <img src={coach.img} alt={coach.label} width={36} height={36} style={{ borderRadius: "50%", marginRight: 10 }} />
                <div>
                  <div style={{ fontWeight: 700 }}>Coach</div>
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

        {/* RIGHT: Plans from this conversation */}
        <div className="conv-sidebar" style={styles.sidePanel}>
          <ConversationPlansSidebar plans={convPlans} focus={focus} />
        </div>
      </div>
    </div>
  );
}
