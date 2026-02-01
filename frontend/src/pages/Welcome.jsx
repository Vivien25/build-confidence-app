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
        {/* LEFT */}
        <div style={styles.left}>
          <h1 style={styles.title}>Better Me</h1>
          <p style={styles.subtitle}>
            Your friendly coach to grow confidence, one step at a time.
          </p>
        </div>

        {/* RIGHT */}
        <div style={styles.right}>
          <div style={styles.splitPanel}>
            {/* LEFT SIDE (Mira) — wrapper is clipped, so it won't overlap */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => pickCoach("mira")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") pickCoach("mira");
              }}
              style={styles.leftWrap}
              aria-label="Choose Mira"
              title="Mira"
            >
              <div style={styles.backdropLeft} />
              <img src={coachMira} alt="Mira" style={styles.faceSafeLeft} />

              <div style={styles.labelLeft}>
                <div style={styles.coachName}>Mira</div>
                <div style={styles.coachVibe}>Compassionate</div>
              </div>
            </div>

            {/* RIGHT SIDE (Kai) — wrapper is clipped, so it won't overlap */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => pickCoach("kai")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") pickCoach("kai");
              }}
              style={styles.rightWrap}
              aria-label="Choose Kai"
              title="Kai"
            >
              <div style={styles.backdropRight} />
              <img src={coachKai} alt="Kai" style={styles.faceSafeRight} />

              <div style={styles.labelRight}>
                <div style={styles.coachName}>Kai</div>
                <div style={styles.coachVibe}>Empowering</div>
              </div>
            </div>

            {/* subtle unify overlay */}
            <div style={styles.overlay} />
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
    padding: "48px 24px",
    display: "flex",
    alignItems: "center",
  },
  layout: {
    width: "min(1200px, 96vw)",
    margin: "0 auto",
    display: "grid",
    gridTemplateColumns: "520px 1fr",
    gap: 36,
    alignItems: "center",
  },

  left: { textAlign: "left" },
  title: {
    margin: 0,
    fontSize: 80,
    fontWeight: 900,
    letterSpacing: "-1.4px",
    color: "#3a2f2a",
    lineHeight: 1.02,
  },
  subtitle: {
    margin: "16px 0 0 0",
    fontSize: 18,
    lineHeight: 1.7,
    color: "rgba(58,47,42,0.72)",
    maxWidth: 520,
  },

  right: { width: "100%" },

  splitPanel: {
    position: "relative",
    width: "100%",
    height: "min(640px, 78vh)",
    borderRadius: 26,
    overflow: "hidden",
    border: "1px solid rgba(58,47,42,0.18)",
    boxShadow: "0 26px 80px rgba(0,0,0,0.14)",
    background: "rgba(255,255,255,0.45)",
  },

  // ✅ IMPORTANT: each wrapper is clipped so images never overlap
  leftWrap: {
    position: "absolute",
    inset: 0,
    clipPath: "polygon(0 0, 60% 0, 42% 100%, 0 100%)",
    cursor: "pointer",
    outline: "none",
  },
  rightWrap: {
    position: "absolute",
    inset: 0,
    clipPath: "polygon(60% 0, 100% 0, 100% 100%, 42% 100%)",
    cursor: "pointer",
    outline: "none",
  },

  backdropLeft: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(900px 600px at 30% 30%, rgba(255,233,215,0.95), rgba(255,255,255,0.55) 55%, rgba(127,191,163,0.20))",
  },
  backdropRight: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(900px 600px at 70% 30%, rgba(255,233,215,0.80), rgba(255,255,255,0.50) 55%, rgba(227,139,109,0.18))",
  },

  // ✅ Larger + shifted slightly for each side
  faceSafeLeft: {
    position: "absolute",
    inset: "-6% -8%",
    width: "116%",
    height: "112%",
    objectFit: "contain",
    objectPosition: "20% center",
    filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.15))",
    pointerEvents: "none",
  },

  faceSafeRight: {
    position: "absolute",
    inset: "-6% -7%",
    width: "116%",
    height: "112%",
    objectFit: "contain",
    objectPosition: "82% center",
    filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.15))",
    pointerEvents: "none",
  },

  overlay: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    background:
      "linear-gradient(90deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04) 40%, rgba(255,255,255,0.10))",
  },

  labelLeft: {
    position: "absolute",
    left: 18,
    bottom: 18,
    padding: "10px 12px",
    borderRadius: 14,
    background: "rgba(255,255,255,0.78)",
    border: "1px solid rgba(58,47,42,0.18)",
    backdropFilter: "blur(8px)",
    textAlign: "left",
    pointerEvents: "none",
  },
  labelRight: {
    position: "absolute",
    right: 18,
    bottom: 18,
    padding: "10px 12px",
    borderRadius: 14,
    background: "rgba(255,255,255,0.78)",
    border: "1px solid rgba(58,47,42,0.18)",
    backdropFilter: "blur(8px)",
    textAlign: "left",
    pointerEvents: "none",
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
    textAlign: "right",
  },
};
