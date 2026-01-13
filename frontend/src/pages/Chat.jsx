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
function loadSaved(key, fallback = []) {
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

// ---------- sessionStorage helpers (refreshable per visit) ----------
function loadSession(key, fallback = []) {
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

function buildPlanFromSteps({ focus, steps }) {
  const id = uid("plan");
  const title = `${focus[0].toUpperCase() + focus.slice(1)} plan`;
  const goal = "Follow the steps below for the next 7 days.";
  return {
    id,
    title,
    goal,
    focus,
    steps: steps.map((s, i) => ({ id: `S${i + 1}`, label: String(s) })),
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
          ref.current.innerHTML =
            "<div style='opacity:.8'>Diagram failed to render.</div>";
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
        content = `Plan: ${m.plan.title}. Steps: ${(m.plan.steps || [])
          .map((s) => s.label)
          .join("; ")}`;
      } else {
        content = String(m.text || m.message || "");
      }

      content = content.trim();
      if (!content) return null;
      return { role, content };
    })
    .filter(Boolean);
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

  const chatKey = `bc_chat_${userId}_${focus}`;

  // ✅ persistent across app (localStorage)
  const plansKey = `bc_plans_${userId}`;

  // ✅ per focus “Plans from this conversation” (sessionStorage)
  const convPlansKey = `bc_conv_plans_${userId}_${focus}`;

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const [plans, setPlans] = useState([]);
  const [convPlans, setConvPlans] = useState([]);

  const [plansHydrated, setPlansHydrated] = useState(false);
  const [convPlansHydrated, setConvPlansHydrated] = useState(false);

  const listRef = useRef(null);

  // Load per-focus chat messages (persistent)
  useEffect(() => {
    setMessages(loadSaved(chatKey, []));
  }, [chatKey]);

  // ✅ Load global plans from localStorage
  useEffect(() => {
    const p = loadSaved(plansKey, []);
    setPlans(Array.isArray(p) ? p : []);
    setPlansHydrated(true);
  }, [plansKey]);

  // ✅ IMPORTANT: Refresh "Plans from this conversation" every time you ENTER /chat
  useEffect(() => {
    sessionStorage.removeItem(convPlansKey); // <-- THIS is what you were missing
    setConvPlans([]); // start fresh

    setConvPlansHydrated(true); // allow saving after first accept
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

  const acceptPlan = (planObj) => {
    const accepted = { ...planObj, acceptedAt: new Date().toISOString() };

    // 1) Global plans (for /plans)
    setPlans((prev) => {
      const dedup = prev.filter((p) => p.id !== accepted.id);
      return [accepted, ...dedup];
    });

    // 2) Plans from this conversation (sidebar)
    setConvPlans((prev) => {
      const dedup = prev.filter((p) => p.id !== accepted.id);
      return [accepted, ...dedup];
    });

    // Mark accepted in chat (hide buttons)
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

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userText = input.trim();
    setInput("");
    setLoading(true);

    const userMsgObj = { id: uid("msg"), role: "user", text: userText };
    setMessages((prev) => [...prev, userMsgObj]);

    try {
      const history = toHistory([...messages, userMsgObj], 12);

      const res = await axios.post(`${API_BASE}/chat`, {
        user_id: userId,
        focus,
        message: userText,
        history,
      });

      const mode = String(res.data?.mode || "chat").toLowerCase();
      const message = String(res.data?.message || "").trim();
      const planSteps = Array.isArray(res.data?.plan) ? res.data.plan.map(String) : [];

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

      const cleanedSteps = planSteps.filter((p) => p.trim()).slice(0, 6);
      if (cleanedSteps.length > 0) {
        const planObj = buildPlanFromSteps({ focus, steps: cleanedSteps });
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
    }
  };

  const clearChat = () => {
    localStorage.removeItem(chatKey);
    setMessages([]);
  };

  const styles = {
    page: { maxWidth: 1200, margin: "0 auto", padding: 16, color: "var(--text-primary, #111827)" },
    layout: {
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) 360px",
      gap: 16,
      alignItems: "start",
    },
    panel: {
      marginTop: 12,
      marginBottom: 12,
      border: "1px solid var(--border-soft, #e5e7eb)",
      borderRadius: 12,
      padding: 12,
      height: "calc(100vh - 220px)",
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
    card: {
      border: "1px solid var(--border-soft, #e5e7eb)",
      borderRadius: 12,
      padding: 10,
      background: "var(--bg-page, #ffffff)",
    },
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
  };

  return (
    <div style={styles.page}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ margin: 0 }}>Build Confidence</h2>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/plans")} style={styles.btn}>
            Your All Plans
          </button>
          <button onClick={() => navigate("/focus")} style={styles.btn}>
            Change focus
          </button>
          <button onClick={clearChat} style={styles.btn}>
            Clear chat (current focus)
          </button>
        </div>
      </div>

      <div className="chat-layout" style={styles.layout}>
        {/* LEFT: Chat */}
        <div>
          <div ref={listRef} style={styles.panel}>
            {messages.length === 0 && (
              <div style={styles.muted}>
                Say what’s on your mind — I’ll respond like a real conversation (and give tips only when helpful).
              </div>
            )}

            {messages.map((m, i) => {
              const isUser = m.role === "user";
              const avatarImg = isUser ? userAvatar?.img : coach.img;
              const name = isUser ? "You" : "Coach";

              return (
                <div key={m.id || i} style={{ display: "flex", alignItems: "flex-start", marginBottom: 12 }}>
                  <img
                    src={avatarImg}
                    alt={name}
                    width={36}
                    height={36}
                    style={{ borderRadius: "50%", marginRight: 10 }}
                  />

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{name}</div>

                    {isUser ? (
                      <div style={styles.bubbleUser}>{m.text}</div>
                    ) : m.type === "plan" ? (
                      <div style={styles.bubbleCoach}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>
                          {m.plan?.title || "Plan"}
                          {m.plan?.focus && <span style={styles.badge}>{m.plan.focus}</span>}
                        </div>

                        {m.plan?.goal && <div style={{ marginBottom: 10, opacity: 0.9 }}>{m.plan.goal}</div>}

                        <div style={{ ...styles.card, marginBottom: 10 }}>
                          <MermaidDiagram code={m.mermaid} />
                        </div>

                        {Array.isArray(m.plan?.steps) && m.plan.steps.length > 0 && (
                          <div style={{ marginTop: 8 }}>
                            <ol style={{ margin: 0, paddingLeft: 18 }}>
                              {m.plan.steps.map((s) => (
                                <li key={s.id} style={{ marginBottom: 6 }}>
                                  {s.label}
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
                <img
                  src={coach.img}
                  alt={coach.label}
                  width={36}
                  height={36}
                  style={{ borderRadius: "50%", marginRight: 10 }}
                />
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
            placeholder="Say something…"
            style={styles.input}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          />

          <button onClick={sendMessage} disabled={loading} style={styles.sendBtn}>
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
