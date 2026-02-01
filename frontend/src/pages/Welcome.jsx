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
      <div style={styles.layout}>
        {/* LEFT: Brand */}
        <div style={styles.left}>
          <h1 style={styles.title}>Better Me</h1>
          <p style={styles.subtitle}>
            Your friendly coach to grow confidence, one step at a time.
          </p>
        </div>

        {/* RIGHT: Diagonal split coach chooser */}
        <div style={styles.right}>
          <div style={styles.splitCard} aria-label="Choose a coach">
            {/* Mira side */}
            <button
              type="button"
              onClick={() => pickCoach("mira")}
              style={{
                ...styles.halfBase,
                ...styles.leftHalf,
                backgroundImage: `url(${coachMira})`,
              }}
              aria-label="Choose Mira"
              title="Mira"
            >
              <div style={styles.labelBoxLeft}>
                <div style={styles.coachName}>Mira</div>
                <div style={styles.coachVibe}>Compassionate</div>
              </div>
            </button>

            {/* Kai side */}
            <button
              type="button"
              onClick={() => pickCoach("kai")}
              style={{
                ...styles.halfBase,
                ...styles.rightHalf,
                backgroundImage: `url(${coachKai})`,
              }}
              aria-label="Choose Kai"
              title="Kai"
            >
              <div style={styles.labelBoxRight}>
                <div style={styles.coachName}>Kai</div>
                <div style={styles.coachVibe}>Empowering</div>
              </div>
            </button>

            {/* soft overlay so it feels like one image */}
            <div style={styles.glowOverlay} />
          </div>

          <div style={styles.hint}>Click a side to choose your coach.</div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    padding: "48px 24px",
  },
  layout: {
    width: "min(1100px, 96vw)",
    margin: "0 auto",
    display: "grid",
    gridTemplateColumns: "1.05fr 1fr",
    gap: 36,
    alignItems: "center",
  },

  left: { textAlign: "left" },
  title: {
    margin: 0,
    fontSize: 80, // bigger
    fontWeight: 900,
    letterSpacing: "-1.4px",
    color: "#3a2f2a", // warm cocoa
    lineHeight: 1.02,
  },
  subtitle: {
    margin: "16px 0 0 0",
    fontSize: 18,
    lineHeight: 1.7,
    color: "rgba(58,47,42,0.72)",
    maxWidth: 520,
  },

  right: { display: "grid", justifyItems: "end" },

  splitCard: {
    position: "relative",
    width: "min(520px, 90vw)",
    height: 320,
    borderRadius: 24,
    overflow: "hidden",
    border: "1px solid rgba(58,47,42,0.18)",
    boxShadow: "0 24px 70px rgba(0,0,0,0.12)",
    background: "rgba(255,255,255,0.55)",
  },

  halfBase: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    border: 0,
    padding: 0,
    margin: 0,
    cursor: "pointer",
    backgroundSize: "cover",
    backgroundPosition: "center",
    transition: "transform 160ms ease, filter 160ms ease",
    filter: "saturate(1.05) contrast(1.02)",
  },

  // Diagonal split:
  // left side keeps left triangle-ish region
  leftHalf: {
    clipPath: "polygon(0 0, 63% 0, 47% 100%, 0 100%)",
  },
  // right side keeps right region
  rightHalf: {
    clipPath: "polygon(63% 0, 100% 0, 100% 100%, 47% 100%)",
  },

  // soft overlay to unify image feel
  glowOverlay: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    background:
      "linear-gradient(90deg, rgba(255,255,255,0.12), rgba(255,255,255,0.06) 40%, rgba(255,255,255,0.12))",
  },

  labelBoxLeft: {
    position: "absolute",
    left: 16,
    bottom: 16,
    padding: "10px 12px",
    borderRadius: 14,
    background: "rgba(255,255,255,0.75)",
    border: "1px solid rgba(58,47,42,0.18)",
    backdropFilter: "blur(8px)",
    textAlign: "left",
  },
  labelBoxRight: {
    position: "absolute",
    right: 16,
    bottom: 16,
    padding: "10px 12px",
    borderRadius: 14,
    background: "rgba(255,255,255,0.75)",
    border: "1px solid rgba(58,47,42,0.18)",
    backdropFilter: "blur(8px)",
    textAlign: "left",
  },

  coachName: {
    fontWeight: 900,
    color: "#3a2f2a",
    fontSize: 16,
    lineHeight: 1.1,
  },
  coachVibe: {
    marginTop: 2,
    fontSize: 13,
    color: "rgba(58,47,42,0.68)",
  },

  hint: {
    marginTop: 10,
    fontSize: 13,
    color: "rgba(58,47,42,0.60)",
    justifySelf: "end",
  },
};
