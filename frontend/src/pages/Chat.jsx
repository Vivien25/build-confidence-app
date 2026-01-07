import { useState } from "react";
import axios from "axios";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

export default function Chat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);

  const sendMessage = async () => {
    if (!input.trim()) return;

    // show user message
    setMessages((prev) => [...prev, { role: "user", text: input }]);

    try {
      const res = await axios.post(`${API_BASE}/chat`, {
        message: input,
      });

      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: res.data.reply },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Error talking to server." },
      ]);
    }

    setInput("");
  };

  return (
    <div>
      <h2>Build Confidence Chat</h2>

      <div>
        {messages.map((m, i) => (
          <div key={i}>
            <b>{m.role}:</b> {m.text}
          </div>
        ))}
      </div>

      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Say something..."
      />
      <button onClick={sendMessage}>Send</button>
    </div>
  );
}
