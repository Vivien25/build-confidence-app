import { useState, useMemo } from "react";
import axios from "axios";
import { getProfile } from "../utils/profile";
import { avatarMap, coachAvatar } from "../utils/avatars";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

export default function Chat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  // load profile once
  const profile = useMemo(() => getProfile(), []);
  const userAvatarKey = profile?.avatar ?? "neutral";
  const userAvatar = avatarMap[userAvatarKey];
  const coach = coachAvatar;

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userText = input;
    setInput("");
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", text: userText },
    ]);

    try {
      const res = await axios.post(`${API_BASE}/chat`, {
        message: userText,
      });

      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: res.data.reply },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Sorry — something went wrong while talking to the coach.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 16 }}>
      <h2>Build Confidence Chat</h2>

      {/* Messages */}
      <div style={{ marginBottom: 16 }}>
        {messages.map((m, i) => {
          const isUser = m.role === "user";
          const avatarImg = isUser ? userAvatar?.img : coach.img;
          const name = isUser ? "You" : "Coach";

          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                marginBottom: 12,
              }}
            >
              <img
                src={avatarImg}
                alt={name}
                width={36}
                height={36}
                style={{
                  borderRadius: "50%",
                  marginRight: 10,
                }}
              />

              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {name}
                </div>
                <div>{m.text}</div>
              </div>
            </div>
          );
        })}

        {loading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              opacity: 0.6,
            }}
          >
            <img
              src={coach.img}
              alt={coach.label}
              width={36}
              height={36}
              style={{
                borderRadius: "50%",
                marginRight: 10,
              }}
            />
            <div>
              <div style={{ fontWeight: 600 }}>Coach</div>
              <div>typing…</div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Say something…"
        style={{
          width: "100%",
          padding: 10,
          boxSizing: "border-box",
        }}
        onKeyDown={(e) => e.key === "Enter" && sendMessage()}
      />

      <button
        onClick={sendMessage}
        disabled={loading}
        style={{ marginTop: 8 }}
      >
        {loading ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
