import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { getProfile, saveProfile } from "../utils/profile";
import { avatarMap, coachAvatars } from "../utils/avatars";
import betterMeLogo from "../assets/betterme-logo.jpg";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

const AVATARS = [
  { id: "fem", label: "Feminine avatar" },
  { id: "masc", label: "Masculine avatar" },
  { id: "neutral", label: "Neutral avatar" },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const existing = useMemo(() => getProfile(), []);

  const [name, setName] = useState(existing?.name ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [avatar, setAvatar] = useState(existing?.avatar ?? "neutral");
  const [selectedCoach, setSelectedCoach] = useState(existing?.coachAvatar ?? "mira");

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
      }, { timeout: 2000 });

      saveProfile({
        user_id: res.data.user_id,
        name: res.data.name,
        email: res.data.email,
        avatar,
        coachVoice: selectedCoach === "kai" ? "male" : "female",
        coachAvatar: selectedCoach,
        coachId: selectedCoach,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      navigate("/intro");
    } catch (err) {
      console.warn("Backend unavailable, proceeding with offline/demo mode");
      // Fallback for demo/offline
      saveProfile({
        user_id: `demo_${Date.now()}`,
        name: cleanName,
        email: cleanEmail,
        avatar,
        coachVoice: selectedCoach === "kai" ? "male" : "female",
        coachAvatar: selectedCoach,
        coachId: selectedCoach,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      navigate("/intro");
    } finally {
      setLoading(false);
    }
  };

  const styles = {
    page: {
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      padding: "40px 24px",
      fontFamily: "'Inter', sans-serif"
    },
    header: {
      textAlign: "center",
      marginBottom: 32,
      maxWidth: 600
    },
    brandTitle: {
      fontSize: 64,
      fontWeight: "800",
      color: "#ffffff",
      marginBottom: 16,
      lineHeight: 1,
      letterSpacing: "-0.02em"
    },
    brandSubtitle: {
      fontSize: 20,
      color: "#d1d5db",
      lineHeight: 1.5,
      fontWeight: 500
    },
    card: {
      width: "100%",
      maxWidth: 720,
      background: "rgba(17, 24, 39, 0.8)", // Semi-transparent dark bg
      backdropFilter: "blur(12px)",
      borderRadius: 24,
      border: "1px solid rgba(255,255,255,0.08)",
      padding: "40px 48px",
      boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)"
    },
    welcomeTitle: {
      fontSize: 32,
      fontWeight: "900",
      marginBottom: 12,
      textAlign: "center",
      color: "#ffffff",
      letterSpacing: "-0.01em"
    },
    welcomeSubtitle: {
      fontSize: 16,
      textAlign: "center",
      color: "#9ca3af",
      marginBottom: 24
    },
    label: {
      display: "block",
      fontWeight: 700,
      marginBottom: 8,
      fontSize: 13,
      color: "#e5e7eb",
      textTransform: "uppercase",
      letterSpacing: "0.05em"
    },
    input: {
      display: "block",
      width: "100%",
      padding: "16px",
      borderRadius: 14,
      border: "1px solid rgba(255,255,255,0.1)",
      background: "rgba(31, 41, 55, 0.5)",
      color: "#ffffff",
      fontSize: 16,
      marginBottom: 0,
      boxSizing: "border-box",
      outline: "none",
      transition: "all 0.2s"
    },
    sectionTitle: {
      fontWeight: 700,
      marginBottom: 16,
      fontSize: 15,
      color: "#f3f4f6",
      marginTop: 20,
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      textAlign: "center"
    },
    avatarGrid: { display: "flex", gap: 12, marginBottom: 24 },
    coachGrid: { display: "flex", gap: 16, marginBottom: 32 },
    submitBtn: {
      width: "100%",
      padding: "20px",
      borderRadius: 16,
      border: "none",
      background: "linear-gradient(90deg, #14b8a6 0%, #22c55e 100%)",
      color: "#ffffff",
      fontSize: 18,
      fontWeight: 800,
      cursor: "pointer",
      boxShadow: "0 10px 25px -5px rgba(34, 197, 94, 0.4)",
      transition: "all 0.2s",
      textTransform: "uppercase",
      letterSpacing: "0.025em",
      marginTop: 8
    }
  };

  return (
    <div style={styles.page}>
      {/* Header Section */}
      <div style={styles.header}>
        <h1 style={styles.brandTitle}>Better Me</h1>
        <p style={styles.brandSubtitle}>
          Your friendly coach to grow confidence step by step.
        </p>
      </div>

      {/* Main Card */}
      <div style={styles.card}>
        <h2 style={styles.welcomeTitle}>Welcome aboard!</h2>
        <p style={styles.welcomeSubtitle}>Let's set up your profile to start your journey.</p>

        {error && (
          <div style={{ marginBottom: 24, padding: 14, background: "rgba(239, 68, 68, 0.1)", color: "#f87171", borderRadius: 12, fontSize: 14, fontWeight: 600, border: "1px solid rgba(239, 68, 68, 0.2)", textAlign: "center" }}>
            {error}
          </div>
        )}

        {/* Inputs */}
        <div style={{ display: "flex", gap: 24, marginBottom: 24 }}>
          <div style={{ flex: 1 }}>
            <label style={styles.label}>Full Name (First, Last)</label>
            <input
              style={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Vivien Rose"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={styles.label}>Email Address</label>
            <input
              type="email"
              style={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g., vivien@growth.com"
            />
          </div>
        </div>

        {/* Avatar Selection */}
        <div style={styles.sectionTitle}>Choose your avatar style</div>
        <div style={styles.avatarGrid}>
          {AVATARS.map((a) => {
            const isSelected = avatar === a.id;
            const img = avatarMap[a.id]?.img;

            let bg = "rgba(255,255,255,0.03)";
            let borderColor = "rgba(255,255,255,0.05)";
            let activeColor = "#3b82f6";
            let labelColor = isSelected ? "#ffffff" : "#9ca3af";

            if (a.id === "fem") {
              bg = isSelected ? "rgba(244, 63, 94, 0.1)" : "rgba(255,255,255,0.02)";
              borderColor = isSelected ? "#fb7185" : "rgba(255,255,255,0.05)";
              activeColor = "#fb7185";
            }
            else if (a.id === "masc") {
              bg = isSelected ? "rgba(37, 99, 235, 0.1)" : "rgba(255,255,255,0.02)";
              borderColor = isSelected ? "#60a5fa" : "rgba(255,255,255,0.05)";
              activeColor = "#3b82f6";
            }
            else if (a.id === "neutral") {
              bg = isSelected ? "rgba(139, 92, 246, 0.1)" : "rgba(255,255,255,0.02)";
              borderColor = isSelected ? "#a78bfa" : "rgba(255,255,255,0.05)";
              activeColor = "#a78bfa";
            }

            return (
              <div
                key={a.id}
                onClick={() => setAvatar(a.id)}
                style={{
                  cursor: "pointer", flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
                  padding: 12, borderRadius: 16, border: `2px solid ${borderColor}`, background: bg, transition: "all 0.2s"
                }}
              >
                <div style={{ width: 64, height: 64, borderRadius: "50%", overflow: "hidden", marginBottom: 10, border: `2px solid ${isSelected ? activeColor : "rgba(255,255,255,0.05)"}` }}>
                  <img src={img} alt={a.label} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 20%", transform: "scale(1.1)" }} />
                </div>
                <span style={{ fontSize: 13, fontWeight: isSelected ? 800 : 500, color: labelColor, textAlign: "center" }}>{a.label.split(" ")[0]}</span>
              </div>
            );
          })}
        </div>

        {/* Coach Selection */}
        <div style={styles.sectionTitle}>Meet your growth coach</div>
        <div style={styles.coachGrid}>
          {Object.entries(coachAvatars).map(([id, data]) => {
            const isSelected = selectedCoach === id;
            const isMira = id === "mira";

            const bg = isMira
              ? (isSelected ? "rgba(244, 63, 94, 0.1)" : "rgba(255,255,255,0.02)")
              : (isSelected ? "rgba(37, 99, 235, 0.1)" : "rgba(255,255,255,0.02)");

            const border = isMira
              ? (isSelected ? "#fb7185" : "rgba(255,255,255,0.05)")
              : (isSelected ? "#60a5fa" : "rgba(255,255,255,0.05)");

            const textColor = isSelected ? "#ffffff" : "#9ca3af";

            return (
              <div
                key={id}
                onClick={() => setSelectedCoach(id)}
                style={{
                  cursor: "pointer", flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
                  padding: "20px 16px", borderRadius: 16, border: `2px solid ${border}`, background: bg, transition: "all 0.2s"
                }}
              >
                <div style={{ width: 64, height: 64, borderRadius: "50%", overflow: "hidden", marginBottom: 12, border: `2px solid ${border}` }}>
                  <img src={data.img} alt={data.label} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 20%", transform: "scale(1.2)" }} />
                </div>
                <span style={{ fontWeight: 800, color: textColor, fontSize: 16 }}>{data.label}</span>
                <span style={{ fontSize: 11, color: isSelected ? textColor : "#6b7280", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{isMira ? "Compassionate" : "Empowerment"}</span>
              </div>
            );
          })}
        </div>

        <button
          onClick={onContinue}
          disabled={loading}
          style={{ ...styles.submitBtn, opacity: loading ? 0.7 : 1 }}
        >
          {loading ? "Preparing your Roadmap..." : "Let's Begin →"}
        </button>
      </div>
    </div>
  );
}
