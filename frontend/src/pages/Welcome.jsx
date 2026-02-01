import { useNavigate } from "react-router-dom";
import { saveProfile } from "../utils/profile";

// coach avatars (you already have these)
import coachMira from "../assets/avatars/coach_mira.png";
import coachKai from "../assets/avatars/coach_kai.png";

export default function Welcome() {
  const navigate = useNavigate();

  const pickCoach = (coachId) => {
    // only save coach choice here
    saveProfile({ coachId });
    navigate("/intro"); // keep your existing flow
  };

  return (
    <div style={styles.page}>
      <div style={styles.center}>
        {/* Title */}
        <h1 style={styles.title}>Better Me</h1>

        {/* Subtitle */}
        <p style={styles.subtitle}>
          Your friendly coach to grow confidence, one step at a time.
        </p>

        {/* Coach selection */}
        <div style={styles.coachWrap}>
          <button
            style={styles.coachCard}
            onClick={() => pickCoach("mira")}
          >
            <img src={coachMira} alt="Mira" style={styles.avatar} />
            <div style={styles.coachName}>Mira</div>
            <div style={styles.coachDesc}>Compassionate</div>
          </button>

          <button
            style={styles.coachCard}
            onClick={() => pickCoach("kai")}
          >
            <img src={coachKai} alt="Kai" style={styles.avatar} />
            <div style={styles.coachName}>Kai</div>
            <div style={styles.coachDesc}>Empowering</div>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- styles ---------------- */

const styles = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },
  center: {
    textAlign: "center",
    maxWidth: 520,
  },
  title: {
    fontSize: 48,
    fontWeight: 800,
    letterSpacing: "-0.8px",
    color: "#3a2f2a", // warm cocoa
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 1.6,
    color: "rgba(58,47,42,0.72)",
    marginBottom: 36,
  },
  coachWrap: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
  },
  coachCard: {
    background: "rgba(255,255,255,0.75)",
    border: "1px solid rgba(58,47,42,0.25)",
    borderRadius: 18,
    padding: "18px 14px",
    cursor: "pointer",
    transition: "all 140ms ease",
    boxShadow: "0 12px 30px rgba(0,0,0,0.08)",
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 999,
    objectFit: "cover",
    marginBottom: 10,
    boxShadow: "0 8px 20px rgba(0,0,0,0.15)",
  },
  coachName: {
    fontSize: 16,
    fontWeight: 800,
    color: "#3a2f2a",
  },
  coachDesc: {
    fontSize: 13,
    color: "rgba(58,47,42,0.65)",
  },
};
