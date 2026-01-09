import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { getProfile } from "../utils/profile";
import { avatarMap, coachAvatar } from "../utils/avatars";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

function loadSaved(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export default function Chat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const profile = useMemo(() => getProfile() || {}, []);
  const userAvatarKey = profile?.avatar ?? "neutral";
  const userAvatar = avatarMap[userAvatarKey];
  const coach = coachAvatar;

  const userId = profile?.id || "local-dev";
  const focus = profile?.focus || "work";
  const storageKey = `bc_chat_${userId}_${focus}`;

  const listRef = useRef(null);

  useEffect(() => {
    // Only run once on mount
    const runCheckin = async () => {
      try {
        const res = await axios.post(`${API_BASE}/chat/checkin`, {
          user_id: userId,
          focus,
          inactive_hours: 18,
        });
  
        if (res.data?.should_send && String(res.data?.message || "").trim()) {
          const checkinMsg = String(res.data.message).trim();
  
          setMessages((prev) => {
            // prevent duplicates if refresh happens
            const already = prev.some(
              (m) => m.role === "assistant" && m.kind === "checkin" && m.message === checkinMsg
            );
            if (already) return prev;
  
            return [
              ...prev,
              {
                role: "assistant",
                mode: "chat",
                kind: "checkin",
                message: checkinMsg,
                tips: [],
                plan: [],
                question: "",
              },
            ];
          });
        }
      } catch {
        // ignore check-in failures
      }
    };
  
    runCheckin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  

  useEffect(() => {
    setMessages(loadSaved(storageKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    save(storageKey, messages);
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, storageKey]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userText = input.trim();
    setInput("");
    setLoading(true);

    setMessages((prev) => [...prev, { role: "user", text: userText }]);

    try {
      const res = await axios.post(`${API_BASE}/chat`, {
        user_id: userId,
        focus,
        message: userText,
      });

      const mode = String(res.data?.mode || "chat").toLowerCase();
      const message = String(res.data?.message || "").trim();
      const tips = Array.isArray(res.data?.tips) ? res.data.tips.map(String) : [];
      const plan = Array.isArray(res.data?.plan) ? res.data.plan.map(String) : [];
      const question = String(res.data?.question || "").trim();

      if (!message) {
        const fallback = res.data?.reply || "Coach returned an unexpected response.";
        setMessages((prev) => [
          ...prev,
          { role: "assistant", mode: "chat", message: String(fallback), tips: [], plan: [], question: "" },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            mode: mode === "coach" ? "coach" : "chat",
            message,
            tips: tips.filter((t) => t.trim()).slice(0, 3),
            plan: plan.filter((p) => p.trim()).slice(0, 5),
            question,
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          mode: "chat",
          message: "Sorry — something went wrong while talking to the coach.",
          tips: [],
          plan: [],
          question: "",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const clearChat = () => {
    localStorage.removeItem(storageKey);
    setMessages([]);
  };

  const styles = {
    page: { maxWidth: 760, margin: "0 auto", padding: 16, color: "var(--text-primary, #111827)" },
    panel: {
      marginTop: 12,
      marginBottom: 16,
      border: "1px solid var(--border-soft, #e5e7eb)",
      borderRadius: 12,
      padding: 12,
      height: 520,
      overflowY: "auto",
      background: "var(--bg-page, #ffffff)",
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
    label: { fontWeight: 700, opacity: 0.9, marginBottom: 6 },
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
  };

  return (
    <div style={styles.page}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Build Confidence Chat</h2>
        <button
          onClick={clearChat}
          style={{
            height: 36,
            borderRadius: 10,
            border: "1px solid var(--border-soft, #e5e7eb)",
            background: "var(--bg-page, #ffffff)",
            color: "var(--text-primary, #111827)",
            padding: "0 12px",
            cursor: "pointer",
          }}
        >
          Clear
        </button>
      </div>

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
            <div key={i} style={{ display: "flex", alignItems: "flex-start", marginBottom: 12 }}>
              <img src={avatarImg} alt={name} width={36} height={36} style={{ borderRadius: "50%", marginRight: 10 }} />

              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{name}</div>

                {isUser ? (
                  <div style={styles.bubbleUser}>{m.text}</div>
                ) : (
                  <div style={styles.bubbleCoach}>
                    <div>{m.message || m.text}</div>

                    {Array.isArray(m.tips) && m.tips.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={styles.label}>Tips</div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {m.tips.map((t, idx) => (
                            <li key={idx} style={{ marginBottom: 6 }}>
                              {t}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {Array.isArray(m.plan) && m.plan.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={styles.label}>Plan</div>
                        <ol style={{ margin: 0, paddingLeft: 18 }}>
                          {m.plan.map((step, idx) => (
                            <li key={idx} style={{ marginBottom: 6 }}>
                              {step}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}

                    {!!m.question?.trim() && (
                      <div style={{ marginTop: 10 }}>
                        {m.mode === "chat" ? (
                          <div style={{ opacity: 0.95 }}>{m.question}</div>
                        ) : (
                          <>
                            <div style={styles.label}>Question</div>
                            <div>{m.question}</div>
                          </>
                        )}
                      </div>
                    )}
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
        placeholder="Say something…"
        style={styles.input}
        onKeyDown={(e) => e.key === "Enter" && sendMessage()}
      />

      <button
        onClick={sendMessage}
        disabled={loading}
        style={{
          marginTop: 8,
          height: 42,
          borderRadius: 10,
          border: "1px solid var(--border-soft, #e5e7eb)",
          background: "var(--bg-chat-user, #111827)",
          color: "var(--text-inverse, #ffffff)",
          padding: "0 14px",
          cursor: loading ? "not-allowed" : "pointer",
          opacity: loading ? 0.7 : 1,
        }}
      >
        {loading ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
