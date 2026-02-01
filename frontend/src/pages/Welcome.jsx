import { useNavigate } from "react-router-dom";
import { saveProfile } from "../utils/profile";

import coachMira from "../assets/avatars/coach_mira.png";
import coachKai from "../assets/avatars/coach_kai.png";

export default function Welcome() {
  const navigate = useNavigate();

  const pickCoach = (coachId) => {
    saveProfile({ coachId });
    navigate("/intro");
  };

  return (
    <div style={styles.page}>
      <div style={styles.content}>
        {/* Title */}
        <h1 style={styles.title}>Better Me</h1>

        {/* Subtitle */}
        <p style={styles.subtitle}>
          Your friendly coach to grow confidence, one step at a time.
        </p>

        {/* Coach cards */}
        <div style={styles.coachRow}>
          <button style={styles.coachCard} onClick={() => pickCoach("mira")}>
            <img src={coachMira} alt="Mira" style={styles.avatar} />
            <div style={styles.coachName}>Mira</div>
            <div style={styles.coachDesc}>Compassionate</div>
          </button>

          <button style={styles.coachCard} onClick={() => pickCoach("kai")}>
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
    display: "flex",
    alignItems: "center",
    paddingLeft: "8vw",   // left breathing space
    paddingRight: 24,
  },
  content: {
    maxWidth: 560,
  },
  title: {
    fontSize: 72,              // MUCH larger
    fontWeight: 900,
    letterSpacing: "-1.2px",
    color: "#3a2f2a",          // warm cocoa
    margin: "0 0 16px 0",
  },
  subtitle: {
    fontSize: 18,
    lineHeight: 1.7,
    color: "rgba(58,47,42,0.72)",
    margin: "0 0 40px 0",
  },
  coachRow: {
    display: "flex",
    gap: 20,
  },
  coachCard: {
    width: 220,
    background: "rgba(255,255,255,0.78)",
    border: "1px solid rgba(58,47,42,0.25)",
    borderRadius: 20,
    padding: "20px 18px",
    textAlign: "left",        // left aligned card text
    cursor: "pointer",
    boxShadow: "0 14px 36px rgba(0,0,0,0.10)",
    transition: "all 140ms ease",
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 999,
    objectFit: "cover",
    marginBottom: 14,
    boxShadow: "0 8px 22px rgba(0,0,0,0.15)",
  },
  coachName: {
    fontSize: 18,
    fontWeight: 800,
    color: "#3a2f2a",
  },
  coachDesc: {
    fontSize: 14,
    color: "rgba(58,47,42,0.65)",
  },
};
