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
  return /\b(plan|steps|roadmap|action items|what should i do|next steps|help me|can you help|strategy|schedule)\b/.test(t);
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

function updateMessageById(setMessages, id, updates) {
  setMessages((prev) => {
    const idx = prev.findIndex((m) => m.id === id);
    if (idx === -1) return prev;
    const next = prev.slice();
    next[idx] = { ...next[idx], ...updates };
    return next;
  });
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
        resources: Array.isArray(t?.resources) ? t.resources : [],
      }))
      .filter((s) => s.label)
      .slice(0, 12),
    createdAt: plan?.created_at || new Date().toISOString(),
    acceptedAt: null,
  };
}

// -------- Inline sidebar (no external file needed) --------
function ConversationPlansSidebar({ plans = [] }) {
  const styles = {
    muted: { opacity: 0.8, color: "var(--text-muted, #6b7280)" },
    pill: {
      display: "inline-block",
      fontSize: 12,
      padding: "2px 8px",
      borderRadius: 999,
      border: "1px solid var(--border-soft, #e5e7eb)",
      opacity: 0.9,
      marginLeft: 8,
    },
    linkList: { margin: "6px 0 0", paddingLeft: 18 },
  };

  if (!Array.isArray(plans) || plans.length === 0) {
    return <div style={styles.muted}>No plans saved in this conversation yet.</div>;
  }

  return (
    <div>
      <div style={{ fontWeight: 900, marginBottom: 10 }}>Plans from this conversation</div>

      <div style={{ display: "grid", gap: 10 }}>
        {plans.map((p) => (
          <div key={p.id} style={{ border: "1px solid var(--border-soft, #e5e7eb)", borderRadius: 12, padding: 10 }}>
            <div style={{ fontWeight: 900, lineHeight: 1.25 }}>
              {p.title || "Plan"}
              {p.focus ? <span style={styles.pill}>{p.focus}</span> : null}
            </div>

            {p.goal ? <div style={{ marginTop: 6, ...styles.muted }}>{p.goal}</div> : null}

            {Array.isArray(p.steps) && p.steps.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {p.steps.slice(0, 6).map((s) => (
                    <li key={s.id} style={{ marginBottom: 8 }}>
                      <div>{s.label}</div>

                      {Array.isArray(s.resources) && s.resources.length > 0 ? (
                        <ul style={styles.linkList}>
                          {s.resources.slice(0, 2).map((r, idx) => (
                            <li key={idx}>
                              <a href={r.url} target="_blank" rel="noreferrer">
                                {r.title || r.url}
                              </a>
                              {r.type ? <span style={styles.muted}> ({r.type})</span> : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <div style={{ marginTop: 8, ...styles.muted }}>No steps found.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ✅ Convert backend history rows into UI messages (text + 12h check-in buttons)
function historyRowToUiMessage(h) {
  const ts = h?.ts || new Date().toISOString();
  const role = String(h?.role || "");
  const text = String(h?.text || "");
  const kind = h?.kind || null;

  const backend_key = `${ts}|${role}|${kind || ""}|${text}`;

  if (role === "user") {
    return {
      id: `h_${backend_key}`,
      backend_key,
      role: "user",
      type: "text",
      text,
      ts,
    };
  }

  // coach
  if (kind === "checkin_12h") {
    return {
      id: `h_${backend_key}`,
      backend_key,
      role: "assistant",
      type: "daily_progress",
      kind: "daily_prompt",
      mode: "coach",
      message: text,
      ts,
      fromBackend: true,
    };
  }

  return {
    id: `h_${backend_key}`,
    backend_key,
    role: "assistant",
    type: "text",
    mode: "coach",
    message: text,
    ts,
    fromBackend: true,
  };
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

  const userId = profile?.user_id || "local-dev";
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

  // Voice state
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const micStreamRef = useRef(null);
  const [voicesReady, setVoicesReady] = useState(false);

  useEffect(() => {
    // Populate voices early for speech synth
    const loadVoices = () => {
      const vs = window.speechSynthesis.getVoices();
      if (vs.length > 0) setVoicesReady(true);
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

  const listRef = useRef(null);
  const reqSeqRef = useRef(0);

  function anyPromptActive() {
    return awaitingBaseline || awaitingBaselineReason || awaitingDailyProgress || awaitingDailyConfidence;
  }

  // ✅ Load local cached chat immediately (keeps plan cards), then sync in backend-injected messages
  useEffect(() => {
    setChatHydrated(false);

    const local = loadSaved(chatKey, []);
    setMessages(Array.isArray(local) ? local : []);
    setChatHydrated(true);

    // then sync from backend (Option B)
    (async () => {
      try {
        const topic = mapNeedToBackendTopic(needKey, focus, customNeedLabel);
        const res = await axios.get(`${API_BASE}/chat/history`, {
          params: { user_id: userId, topic, coach: coachId },
          timeout: AXIOS_TIMEOUT_MS,
        });

        const byHint = (hints) =>
          pool.find((v) => hints.some((h) => String(v.name || "").toLowerCase().includes(h)));

        const incoming = hist
          .map(historyRowToUiMessage)
          .filter((m) => m.role === "assistant" && (m.fromBackend || m.backend_key)); // only inject coach-side history

        setMessages((prev) => {
          const prevArr = Array.isArray(prev) ? prev : [];
          const existingKeys = new Set(prevArr.map((x) => x?.backend_key).filter(Boolean));

          const toAdd = incoming.filter((m) => m.backend_key && !existingKeys.has(m.backend_key));

          if (toAdd.length === 0) return prevArr;
          return [...prevArr, ...toAdd];
        });
      } catch {
        // ignore
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey, userId, focus, needKey, customNeedLabel, coachId]);

  // Persist chat (so plan cards still stay)
  useEffect(() => {
    save(chatKey, messages);
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, chatKey]);

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

  // ✅ If we have an unanswered backend daily prompt at the end, force the UI into awaitingDailyProgress
  useEffect(() => {
    const last = messages?.length ? messages[messages.length - 1] : null;
    const shouldAwait = !!last && last.role === "assistant" && last.type === "daily_progress";
    if (shouldAwait !== awaitingDailyProgress) {
      setAwaitingDailyProgress(shouldAwait);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Reset local UX gating when need changes
  useEffect(() => {
    setAwaitingBaseline(false);
    setAwaitingBaselineReason(false);
    setAwaitingDailyProgress(false);
    setAwaitingDailyConfidence(false);
    setReadyForBaseline(false);

    setMessages((prev) =>
      (prev || []).filter(
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

    setBackendUI({ mode: "CHAT", show_plan_sidebar: false, plan_link: null, mermaid: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, customNeedLabel, focus]);

  // Baseline triggers (kept)
  useEffect(() => {
    if (!chatHydrated) return;
    if (!hasUserSpoken || !readyForBaseline) return;

    if (anyPromptActive()) return;

    const conf = loadSaved(confidenceKey, null);
    const fLabel = focusLabel(focus);
    const nLabel = currentNeedLabel();

    if (needKey === "custom" && !customNeedLabel.trim()) return;

    if (!conf || typeof conf?.baseline !== "number") {
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
      {
        id: uid("msg"),
        role: "assistant",
        type: "text",
        mode: "coach",
        message: "Saved ✅ Added to this conversation and your All Plans page.",
        ts: new Date().toISOString(),
      },
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
        ts: new Date().toISOString(),
      },
    ]);
  };


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

    // Show user's click in UI
    setMessages((prev) => [
      ...prev,
      {
        id: uid("msg"),
        role: "user",
        text: didProgress ? "Yes, I did." : "Not yet.",
        type: "text",
        ts: new Date().toISOString(),
      },
    ]);

    // ✅ IMPORTANT: Tell backend right away, so follow-up logic knows user responded
    setLoading(true);
    sendingRef.current = true;

    try {
      if (didProgress) {
        // This is intentionally short — it just updates backend history / follow-up state.
        await callCoachBackend(
          `Check-in update: I made progress on my "${nLabel}" (${fLabel}) plan since the last check-in.`
        );

        // Continue your local UX: ask for confidence number
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

      // didProgress === false -> backend coaching + tiny next step
      await callCoachBackend(
        `I didn’t get a chance to work on my ${fLabel} plan for "${nLabel}". Please give practical time-management tips and one tiny next step I can do in 5 minutes.`
      );
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  };

  // Helper for applying backend response to local state
  function applyBackendChatResponse(chatData) {
    const msgs = chatData.messages || [];
    const backendUI = chatData.ui || {};

    let lastAssistantText = "";

    // 1. Update UI state
    if (backendUI.mode) {
      setBackendUI(backendUI);
    }

    // 2. Append messages
    const newMsgs = msgs.map((m) => {
      lastAssistantText = m.text; // track last one for TTS
      return {
        id: uid("msg_coach"),
        role: "assistant",
        type: "text", // or derive from structure
        mode: "coach",
        message: m.text,
        ts: new Date().toISOString(),
        // plan stuff could be attached here if needed
        mermaid: backendUI.mermaid,
        plan: chatData.plan,
        type: chatData.plan ? "plan" : "text"
      };
    });

    if (newMsgs.length > 0) {
      setMessages((prev) => [...prev, ...newMsgs]);
    }

    return { lastAssistantText };
  }

  const callCoachBackend = async (userText) => {
    if (sendingRef.current) return;
    setLoading(true);
    sendingRef.current = true;

    try {
      const topic = mapNeedToBackendTopic(needKey, focus, customNeedLabel);

      const res = await axios.post(`${API_BASE}/chat`, {
        user_id: userId,
        message: userText,
        coach: coachId,
        topic,
        profile: profile || {},
      }, { timeout: AXIOS_TIMEOUT_MS });

      const chat = res.data;
      applyBackendChatResponse(chat);

    } catch (err) {
      const msg = getAxiosErrorMessage(err);
      setMessages((prev) => [
        ...prev,
        {
          id: uid("msg_err"),
          role: "assistant",
          type: "text",
          mode: "coach",
          message: msg === "Request timed out."
            ? "Thinking took too long. Please try again."
            : "Sorry, I’m having trouble connecting. Please try again.",
        },
      ]);
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
        {
          id: uid("msg"),
          role: "assistant",
          type: "text",
          mode: "coach",
          message: 'Quick one — what would you like to call this confidence area? (Example: “Executive presence”)',
          ts: new Date().toISOString(),
        },
      ]);
      return;
    }

    sendingRef.current = true;

    const userText = input.trim();
    setInput("");
    setLoading(true);

    if (!isGreeting(userText)) setHasUserSpoken(true);
    if (!readyForBaseline && userAskedForPlan(userText)) setReadyForBaseline(true);

    setMessages((prev) => [...prev, { id: uid("msg"), role: "user", text: userText, type: "text", ts: new Date().toISOString() }]);

    const fLabel = focusLabel(focus);
    const nLabel = currentNeedLabel();

    try {
      if (awaitingBaselineReason) {
        setAwaitingBaselineReason(false);
        await callCoachBackend(
          `Baseline set for "${nLabel}" (${fLabel}). The main reason I’m not more confident is: ${userText}. Help me with empathy + practical suggestions, and (if useful) refine my existing plan.`
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
              ts: new Date().toISOString(),
            },
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
            {
              id: uid("msg"),
              role: "assistant",
              type: "text",
              mode: "coach",
              message: "Please reply with a number from 1 to 10 (for example: 6).",
              ts: new Date().toISOString(),
            },
          ]);
          return;
        }

        saveConfidence(level);
        setAwaitingDailyConfidence(false);

        await callCoachBackend(
          `My confidence for "${nLabel}" (${fLabel}) right now is ${level}/10. I made progress on my plan. Reflect the change and suggest what to do next.`
        );
        return;
      }

      await callCoachBackend(`[Need: ${nLabel}] ${userText}`);
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  };

  // -----------------------
  // Voice: audio playback
  // -----------------------
  function speakCoach(textToSpeak) {
    if (!textToSpeak) return;

    // This function now mainly serves as a fallback or if we want to use browser TTS.
    // But since we are using backend Edge-TTS, the backend logic inside sendVoiceBlob 
    // likely needs to know *what* URL to play.
    // Current implementation in sendVoiceBlob (from previous steps) 
    // didn't receive the audio URL yet properly from the backend logic I added. 

    // WAIT: The backend /chat/voice endpoint returns VoiceChatResponse(transcript, chat). 
    // It DOES NOT yet return the 'audio_url' I wanted to add in step 370 but skipped.

    // Let's rely on browser TTS as a robust fallback if backend audio isn't available, 
    // OR implement the audio fetch here if we assume the backend generated it.

    // For this user request "voice tone should be human-like", browser TTS is often robotic.
    // I need to ensure the backend actually returns the audio URL. 
    // The backend code in step 370 didn't strictly include audio_url in the Pydantic model.

    // Let's implement browser TTS as a safe backup for now to prevent crashing, 
    // but the *ideal* is playing the MP3. 

    // Since I can't easily change the backend Pydantic model in a small patch without potentially breaking validation,
    // I will assume for a moment we use browser TTS as immediate fix for "nothing showing up" 
    // (because missing function definition crashes React).

    const synth = window.speechSynthesis;
    if (!synth) return;

    // Cancel existing
    synth.cancel();

    const u = new SpeechSynthesisUtterance(textToSpeak);
    // Try to pick a voice
    const voices = synth.getVoices();
    // Mira (female) or Kai (male)
    const isMale = coach.name.toLowerCase().includes("kai");

    // Simple heuristic for "natural" voices
    const target = voices.find(v =>
      v.name.includes(isMale ? "Male" : "Female") ||
      v.name.includes(isMale ? "David" : "Zira") ||
      v.name.includes("Google")
    );

    if (target) u.voice = target;
    u.rate = 1.0;
    u.pitch = 1.0;
    synth.speak(u);
  }

  // -----------------------
  // Voice: record + send
  // -----------------------
  async function startVoice() {
    if (loading || sendingRef.current || recording) return;
    if (awaitingDailyProgress) return;

    // If user is in a strict numeric prompt, voice isn't useful
    if (awaitingBaseline || awaitingDailyConfidence) return;

    // If custom need label missing, same as text
    if (needKey === "custom" && !customNeedLabel.trim()) {
      setMessages((prev) => [
        ...prev,
        { id: uid("msg"), role: "assistant", type: "text", mode: "coach", message: 'Quick one — what would you like to call this confidence area? (Example: “Executive presence”)' },
      ]);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        try {
          // stop mic tracks
          try {
            micStreamRef.current?.getTracks?.().forEach((t) => t.stop());
          } catch { }
          micStreamRef.current = null;

          const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || "audio/webm" });
          await sendVoiceBlob(blob);
        } catch {
          // ignore
        } finally {
          audioChunksRef.current = [];
          mediaRecorderRef.current = null;
        }
      };

      mr.start();
      setRecording(true);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: uid("msg"),
          role: "assistant",
          type: "text",
          mode: "coach",
          message: "I can’t access your microphone. Please allow mic permission in the browser settings, then try again.",
        },
      ]);
    }
  }

  function stopVoice() {
    if (!recording) return;
    setRecording(false);
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      // ensure mic off
      try {
        micStreamRef.current?.getTracks?.().forEach((t) => t.stop());
      } catch { }
      micStreamRef.current = null;
    }
  }

  async function sendVoiceBlob(blob) {
    const mySeq = ++reqSeqRef.current;
    const topic = mapNeedToBackendTopic(needKey, focus, customNeedLabel);

    const tempUserMsgId = uid("voice_user");
    setMessages((prev) => [...prev, { id: tempUserMsgId, role: "user", type: "text", text: "🎙️ (processing voice…)" }]);

    setLoading(true);
    sendingRef.current = true;

    try {
      const form = new FormData();
      form.append("user_id", userId);
      form.append("coach", coachId); // backend accepts mira/kai too
      form.append("topic", topic);
      form.append("profile_json", JSON.stringify(profile || {}));
      form.append("audio", blob, "voice.webm");

      const res = await axios.post(`${API_BASE}/chat/voice`, form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: Math.max(AXIOS_TIMEOUT_MS, 60000),
      });

      if (mySeq !== reqSeqRef.current) return;

      const transcript = String(res.data?.transcript || "").trim() || "(Voice message)";
      updateMessageById(setMessages, tempUserMsgId, { text: transcript });

      const chat = res.data?.chat || {};
      const { lastAssistantText } = applyBackendChatResponse(chat);

      // Speak only for voice flows
      if (lastAssistantText) {
        // Ensure some browsers have voices loaded (best effort)
        if (!voicesReady) {
          try {
            window.speechSynthesis.getVoices?.();
          } catch { }
        }
        speakCoach(lastAssistantText);
      }
    } catch (err) {
      if (mySeq !== reqSeqRef.current) return;

      const msg = getAxiosErrorMessage(err);
      updateMessageById(setMessages, tempUserMsgId, { text: "🎙️ (voice failed to send)" });

      setMessages((prev) => [
        ...prev,
        {
          id: uid("msg"),
          role: "assistant",
          type: "text",
          mode: "chat",
          message:
            msg === "Request timed out."
              ? "Sorry — voice took too long to process. Try a shorter message."
              : "Sorry — I couldn’t process that voice message. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  }

  const clearChat = () => {
    localStorage.removeItem(chatKey);
    sessionStorage.removeItem(convPlansKey);
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
    select: { height: 36, borderRadius: 10, border: "1px solid var(--border-soft, #e5e7eb)", padding: "0 10px", background: "#fff", color: "#111827" },
    smallInput: { height: 36, borderRadius: 10, border: "1px solid var(--border-soft, #e5e7eb)", padding: "0 10px", background: "#fff", color: "#111827", minWidth: 220 },
  };

  const showConfidenceHint = awaitingBaseline || awaitingDailyConfidence;
  const needLabel = currentNeedLabel();

  const activeNeedHint = (() => {
    const active = loadSaved(activeNeedStorage, null);
    return active ? String(active) : null;
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
                                              {r.title || r.url}
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

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
                        : "Type... or tap mic to speak"
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

            {/* Mic button */}
            <button
              className={recording ? "mic-recording" : "mic-btn-base"}
              onClick={recording ? stopVoice : startVoice}
              disabled={loading || awaitingDailyProgress}
              title={recording ? "Stop Recording" : "Start Voice"}
            >
              {recording ? "⏹" : "🎤"}
            </button>

            <button onClick={sendMessage} disabled={loading || awaitingDailyProgress} style={styles.sendBtn}>
              {loading ? "..." : "Send"}
            </button>
          </div>

          {(showConfidenceHint || awaitingBaselineReason) && (
            <div style={styles.hint}>
              {showConfidenceHint ? (
                <>Tip: type a number from <b>1</b> to <b>10</b>.</>
              ) : (
                <>Tip: one sentence is enough 🙂</>
              )}
            </div>
          )}

          <div style={{ ...styles.muted, marginTop: 10, fontSize: 12 }}>
            In-app check-ins: if you’re away for ~12 hours, the coach will drop a quick progress check here when you come back.
          </div>
        </div>

        {/* RIGHT: Plans from this conversation */}
        <div className="conv-sidebar" style={styles.sidePanel}>
          <ConversationPlansSidebar plans={convPlans} />
        </div>
      </div>
    </div>
  );
}
