import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { getProfile, saveProfile } from "../utils/profile";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

const AVATARS = [
  { id: "fem", label: "Feminine avatar" },
  { id: "masc", label: "Masculine avatar" },
  { id: "neutral", label: "Neutral avatar" },
  // If you keep "custom", make sure Chat falls back to neutral
  // { id: "custom", label: "Let me choose later" },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const existing = useMemo(() => getProfile(), []);

  const [name, setName] = useState(existing?.name ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [avatar, setAvatar] = useState(existing?.avatar ?? "neutral");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const onContinue = async () => {
    setError("");

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (!cleanName) {
      setError("Please enter your name.");
      return;
    }

    if (!cleanEmail || !/^\S+@\S+\.\S+$/.test(cleanEmail)) {
      setError("Please enter a valid email address.");
      return;
    }

    setLoading(true);

    try {
      // 🔐 login / create user
      const res = await axios.post(`${API_BASE}/users/login`, {
        name: cleanName,
        email: cleanEmail,
      });

      // Save minimal profile (focus is chosen on /focus page)
      saveProfile({
        user_id: res.data.user_id,
        name: res.data.name,
        email: res.data.email,
        avatar,
        coachId: existing?.coachId || "mira", // ✅ IMPORTANT
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      

      navigate("/focus");
    } catch (err) {
      setError("Something went wrong while creating your profile. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>
      <h2>Quick setup</h2>
      <p>We’ll personalize your experience. You can change this later.</p>

      {error && (
        <div style={{ marginTop: 12, color: "#b91c1c", fontWeight: 600 }}>
          {error}
        </div>
      )}

      {/* Name */}
      <div style={{ marginTop: 16 }}>
        <label>
          Name
          <input
            style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Vivien"
            autoComplete="name"
          />
        </label>
      </div>

      {/* Email */}
      <div style={{ marginTop: 16 }}>
        <label>
          Email
          <input
            type="email"
            style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g., vivien@example.com"
            autoComplete="email"
          />
        </label>
      </div>

      {/* Avatar */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Choose an avatar style
        </div>

        {AVATARS.map((a) => (
          <label key={a.id} style={{ display: "block", marginBottom: 8 }}>
            <input
              type="radio"
              name="avatar"
              value={a.id}
              checked={avatar === a.id}
              onChange={() => setAvatar(a.id)}
              style={{ marginRight: 8 }}
            />
            {a.label}
          </label>
        ))}
      </div>

      <button
        onClick={onContinue}
        disabled={loading}
        style={{ marginTop: 20, padding: "10px 14px" }}
      >
        {loading ? "Saving…" : "Continue"}
      </button>
    </div>
  );
}
