import { useState } from "react";
import axios from "axios";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

export default function Chat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    { from: "mira", text: "Hi! I’m Mira, your confidence coach 😊" },
    { from: "mira", text: "Type a message and I’ll reply (echo) for now." },
  ]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;

    const next = [...messages, { from: "you", text }];
    setMessages(next);
    setInput("");

    try {
      const res = await axios.post(`${API_BASE}/chat/`, { message: text });
      setMessages([...next, { from: "mira", text: res.data.reply }]);
    } catch (err) {
      setMessages([
        ...next,
        { from: "mira", text: "Hmm—couldn’t reach the backend. Is it running on :8000?" },
      ]);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 700, margin: "0 auto" }}>
      <h2 style={{ marginTop: 0 }}>Mira (Confidence Coach)</h2>

      <div
        style={{
          border: "1px solid #333",
          borderRadius: 12,
          padding: 12,
          minHeight: 320,
          background: "#111",
        }}
      >
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: m.from === "you" ? "flex-end" : "flex-start",
              margin: "10px 0",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "10px 12px",
                borderRadius: 12,
                background: m.from === "you" ? "#2563eb" : "#222",
                color: "white",
                whiteSpace: "pre-wrap",
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type here…"
          style={{ flex: 1, padding: 10, borderRadius: 10 }}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button onClick={send} style={{ padding: "10px 14px", cursor: "pointer" }}>
          Send
        </button>
      </div>
    </div>
  );
}
