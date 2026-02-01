import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { getProfile, saveProfile } from "../utils/profile";

// ✅ avatar images (adjust paths/names to match your assets)
import userFem from "../assets/avatars/user_fem.png";
import userMasc from "../assets/avatars/user_masc.png";
import userNeutral from "../assets/avatars/user_neutral.png";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

const AVATARS = [
  { id: "fem", label: "Feminine", img: userFem },
  { id: "masc", label: "Masculine", img: userMasc },
  { id: "neutral", label: "Neutral", img: userNeutral },
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
      const res = await axios.post(`${API_BASE}/users/login`, {
        name: cleanName,
        email: cleanEmail,
      });

      saveProfile({
        user_id: res.data.user_id,
        name: res.data.name,
        email: res.data.email,
        avatar,
        coachId: existing?.coachId || "mira", // keep your default
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
    <div style={styles.page}>
      <div className="warm-card" style={styles.shell}>
        <div style={styles.header}>
          <h1 style={styles.title}>Welcome aboard</h1>
          <p className="muted" style={{ margin: 0 }}>
            Let’s set up your profile. You can change this later.
          </p>
        </div>

        {error && (
          <div style={styles.errorBox}>
            {error}
          </div>
        )}

        {/* Name + Email */}
        <div style={styles.grid2}>
          <div>
            <label style={styles.label}>Full name</label>
            <input
              className="warm-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Vivien"
              autoComplete="name"
            />
          </div>

          <div>
            <label style={styles.label}>Email address</label>
            <input
              type="email"
              className="warm-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g., vivien@example.com"
              autoComplete="email"
            />
          </div>
        </div>

        {/* Avatar cards */}
        <div style={{ marginTop: 18 }}>
          <div style={styles.sectionTitle}>Choose your avatar</div>

          <div style={styles.avatarRow}>
            {AVATARS.map((a) => {
              const selected = avatar === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAvatar(a.id)}
                  style={{
                    ...styles.avatarCard,
                    ...(selected ? styles.avatarCardSelected : {}),
                  }}
                  aria-pressed={selected}
                >
                  <img
                    src={a.img}
                    alt={a.label}
                    style={{
                      ...styles.avatarImg,
                      ...(selected ? styles.avatarImgSelected : {}),
                    }}
                  />
                  <div style={{ fontWeight: 800 }}>{a.label}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {selected ? "Selected" : "Tap to choose"}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* CTA */}
        <div style={{ marginTop: 22 }}>
          <button
            className="warm-btn"
            style={{ width: "100%" }}
            onClick={onContinue}
            disabled={loading}
          >
            {loading ? "Saving…" : "LET’S BEGIN →"}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 18,
  },
  shell: {
    width: "min(900px, 96vw)",
    padding: 22,
  },
  header: {
    textAlign: "center",
    padding: "4px 0 16px 0",
  },
  title: {
    margin: 0,
    fontSize: 34,
    letterSpacing: "-0.6px",
  },
  errorBox: {
    marginTop: 10,
    marginBottom: 6,
    padding: "10px 12px",
    borderRadius: 12,
    background: "rgba(185, 28, 28, 0.08)",
    border: "1px solid rgba(185, 28, 28, 0.18)",
    color: "#b91c1c",
    fontWeight: 700,
  },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: "0.10em",
    textTransform: "uppercase",
    opacity: 0.75,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    opacity: 0.75,
    marginBottom: 10,
    textAlign: "center",
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
  },
  avatarRow: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 12,
  },
  avatarCard: {
    borderRadius: 18,
    border: "1px solid var(--border)",
    background: "var(--surface2)",
    padding: "14px 12px",
    textAlign: "center",
    cursor: "pointer",
    boxShadow: "0 10px 26px rgba(43,42,39,0.08)",
    transition: "transform 120ms ease, box-shadow 120ms ease",
  },
  avatarCardSelected: {
    border: "1px solid rgba(227,139,109,0.55)",
    boxShadow: "0 16px 40px rgba(227,139,109,0.22)",
    transform: "translateY(-1px)",
    background: "rgba(255,255,255,0.82)",
  },
  avatarImg: {
    width: 62,
    height: 62,
    borderRadius: 999,
    objectFit: "cover",
    border: "2px solid rgba(255,255,255,0.85)",
    boxShadow: "0 10px 26px rgba(43,42,39,0.10)",
    marginBottom: 10,
  },
  avatarImgSelected: {
    boxShadow: "0 14px 32px rgba(227,139,109,0.28)",
  },
};
